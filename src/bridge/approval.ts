import crypto from "node:crypto";
import {
  approvalOptions,
  type CodexApprovalOption,
  type CodexApprovalDecision,
  type CodexApprovalRequest
} from "../codex/approval.js";
import { createChoiceCard, type ChannelActionCard } from "../channels/action-card.js";
import { copyBlock } from "../channels/copyable.js";
import { ApprovalJournal } from "./approval-journal.js";
import type { ChannelMention, ChannelReceipt } from "../channels/types.js";
import { ChannelPartialDeliveryError } from "../channels/errors.js";
import { ApprovalNoticeDelivery } from "./approval-notice-delivery.js";
import { isDirectedMentionId } from "../channels/mentions.js";
import type { AcceptedPresentationInput } from "./input-presentation.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

type PendingApproval = {
  id: string;
  senderId: string;
  resolve: (decision: CodexApprovalDecision | undefined) => void;
  timer: NodeJS.Timeout;
  request: CodexApprovalRequest;
  promise: Promise<CodexApprovalDecision | undefined>;
  version: string;
  createdAt: number;
  expiresAt: number;
};

export type ApprovalDeliveryResult = "confirmed" | "failed" | "withdrawn";
export class ApprovalDecisionConflictError extends Error {}

export type ChannelApprovalNotice = {
  readonly text: string;
  readonly card?: ChannelActionCard;
  readonly mentions?: readonly ChannelMention[];
  /** The continuation card already conveys this confirmed grant. */
  readonly presentation?: AcceptedPresentationInput;
};

export class ChannelApprovalController {
  private readonly pending = new Map<string, PendingApproval>();
  private nextId = 1;
  private readonly notices = new WeakMap<CodexApprovalRequest, { id: string; senderId: string; mentions?: readonly ChannelMention[] }>();
  private readonly journal: ApprovalJournal;
  private noticeTransfers = 0;
  private readonly resolutionDelivery: ApprovalNoticeDelivery;
  private closed = false;

  constructor(
    private readonly send: (senderId: string, notice: ChannelApprovalNotice) => Promise<ChannelReceipt | void>,
    private readonly timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    private readonly allocateId?: () => string,
    journalFile?: string,
    private readonly options: {
      resolveMentions?: (senderId: string, request: CodexApprovalRequest) => readonly ChannelMention[] | undefined;
      onAcceptedInput?: (input: AcceptedPresentationInput) => Promise<void>;
      updateCard?: (messageId: string, card: ChannelActionCard) => Promise<void>;
      noticeSourceKey?: (senderId: string) => string;
      validateNotice?: (scope: { recipientId: string; hostId: string; threadId: string; sourceKey?: string }) => boolean;
      noticeRetryDelayMs?: number;
    } = {}
  ) {
    this.journal = new ApprovalJournal(journalFile);
    this.resolutionDelivery = new ApprovalNoticeDelivery(this.journal, {
      send: (senderId, notice) => this.sendNotice(senderId, notice), updateCard: options.updateCard,
      validate: options.validateNotice, retryDelayMs: options.noticeRetryDelayMs,
    });
  }

  request(senderId: string, request: CodexApprovalRequest): Promise<CodexApprovalDecision | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const snapshot = structuredClone(request);
    const version = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const existing = snapshot.nativeKey && [...this.pending.values()].find(p => p.senderId === senderId && p.request.nativeKey === snapshot.nativeKey);
    if (existing) {
      if (existing.version !== version) return Promise.reject(new Error("Native approval identity changed its scope"));
      this.notices.set(request, { id: existing.id, senderId, mentions: this.notices.get(existing.request)?.mentions });
      return existing.promise;
    }
    const id = this.allocateId?.() ?? `A${this.nextId++}`;
    let mentions: readonly ChannelMention[] | undefined;
    try { mentions = this.options.resolveMentions?.(senderId, snapshot)?.filter(item => isDirectedMentionId(item.userId))
      .filter((item, index, all) => all.findIndex(other => other.userId === item.userId) === index).map(item => ({ ...item })); }
    catch { console.warn("[codex-im-gateway] approval mention unavailable; request delivery preserved"); }
    const notice = { id, senderId, mentions };
    this.notices.set(request, notice);
    this.notices.set(snapshot, notice);
    let resolve!: (value: CodexApprovalDecision | undefined) => void;
    const promise = new Promise<CodexApprovalDecision | undefined>(done => { resolve = done; });
    const createdAt = Date.now(), expiresAt = createdAt + this.timeoutMs;
    this.journal.add({ id, recipientId: senderId, threadId: snapshot.threadId, hostId: snapshot.hostId ?? "local", version, createdAt });
    this.journal.updateNotice(id, { delivery: "ready", attempts: 0, sourceKey: this.options.noticeSourceKey?.(senderId) });
    {
      const timer = setTimeout(() => {
        if (!this.settle(senderId, id, denial(snapshot))) return;
        this.sendNotice(senderId, { text: `审批 ${id} 已超时，已选择拒绝；是否生效以 Codex 回执为准。`, mentions }).catch((error: unknown) => {
          console.warn(`Unable to send approval timeout ${id}: ${errorDetail(error)}`);
        });
      }, this.timeoutMs);
      this.pending.set(this.key(senderId, id), { id, senderId, resolve, timer, request: snapshot,
        promise, version, createdAt, expiresAt });
      void this.sendNotice(senderId, { ...approvalNotice(id, snapshot, this.timeoutMs), mentions }).then(receipt => {
        if (receipt?.messageId) this.resolutionDelivery.rememberCard(id, receipt.messageId);
      }).catch((error: unknown) => {
        // Missing IM delivery is not a user decision. Keep the native request
        // and its Web/IM identifier pending instead of manufacturing a denial.
        if (error instanceof ChannelPartialDeliveryError && error.delivered[0]?.messageId && this.options.updateCard) {
          this.resolutionDelivery.rememberCard(id, error.delivered[0].messageId);
        }
        console.warn(`[codex-im-gateway] approval ${id} notice unconfirmed; native request retained`);
      }).catch(() => console.warn("[codex-im-gateway] approval card receipt persistence unavailable"));
    }
    return promise;
  }

  decide(senderId: string, rawId: string, decision: CodexApprovalDecision): string {
    const parts = rawId.trim().split(/\s+/);
    if (parts.length > 2 || decision !== "accept" && parts.length > 1) return "审批命令格式不正确，请使用该审批卡中的完整命令。";
    const id = this.resolveId(senderId, parts[0] ?? "");
    if (!id) return "当前没有待审批请求，或审批编号不属于这个账号。";
    const pending = this.pending.get(this.key(senderId, id))!;
    if (Date.now() >= pending.expiresAt) {
      this.settle(senderId, id, denial(pending.request));
      return "审批已过期，已选择拒绝，等待 Codex 确认；请等待新的原生请求。";
    }
    const selected = approvalOptions(pending.request).find(o => o.id === (parts[1] ?? decision));
    if (!selected) return "该请求不支持这个授权范围；请使用审批卡当前提供的选项。";
    this.settle(senderId, id, selected.id);
    return `已提交${selected.id === "decline" || selected.id === "cancel" ? "拒绝" : "批准"}审批 ${id}（${selected.label}）的决定；是否生效以 Codex 接收结果为准。`;
  }

  list() {
    return [...this.pending.values()].map(p => ({ id: p.id, recipientId: p.senderId, threadId: p.request.threadId,
      hostId: p.request.hostId ?? "local", version: p.version, createdAt: p.createdAt, expiresAt: p.expiresAt,
      kind: p.request.kind, body: approvalDetails(p.request).filter(Boolean).join("\n"),
      options: approvalOptions(p.request).map(({ id, label, description }) => ({ id, label, description })) }));
  }

  private sendNotice(senderId: string, notice: ChannelApprovalNotice): Promise<ChannelReceipt | void> {
    this.noticeTransfers++;
    let sent: Promise<ChannelReceipt | void>;
    try { sent = Promise.resolve(this.send(senderId, notice)); }
    catch (error) { sent = Promise.reject(error); }
    return sent.finally(() => { this.noticeTransfers--; });
  }
  hasRestartBlockingWork(): boolean { return this.noticeTransfers > 0 || this.resolutionDelivery.hasRestartBlockingWork(); }
  decideCurrent(senderId: string, id: string, choice: string, version: string): string {
    const pending = this.pending.get(this.key(senderId, id));
    if (!pending || pending.version !== version || Date.now() >= pending.expiresAt) throw new ApprovalDecisionConflictError("审批已处理、已过期或范围发生变化，请刷新。");
    if (!approvalOptions(pending.request).some(o => o.id === choice)) throw new ApprovalDecisionConflictError("原生请求不支持此授权范围");
    return this.decide(senderId, `${id} ${choice}`, "accept");
  }

  async reportResult(senderId: string, request: CodexApprovalRequest, result: ApprovalDeliveryResult): Promise<void> {
    if (this.closed) return;
    const notice = this.notices.get(request);
    if (!notice || notice.senderId !== senderId) return;
    const recorded = this.journal.snapshot().find(record => record.id === notice.id);
    if (recorded?.phase === "confirmed" || recorded?.phase === result) {
      await this.resolutionDelivery.deliver(notice.id); return;
    }
    // An approval handled in Desktop (or removed by a task switch) must no
    // longer be actionable from a stale IM notice.
    if (result === "withdrawn" || result === "failed") {
      const pending = this.pending.get(this.key(senderId, notice.id));
      if (pending) this.settle(senderId, notice.id, denial(pending.request));
    }
    // Only an explicit grant and a native confirmation rotate presentation.
    // Persist the boundary before notifying; restart observes this fact rather
    // than resending an approval or inventing another execution turn.
    const selected = approvalOptions(request).find(option => option.id === recorded?.choice);
    const networkPolicy = (selected?.result.decision as { applyNetworkPolicyAmendment?: {
      network_policy_amendment?: { action?: string } } } | undefined)?.applyNetworkPolicyAmendment?.network_policy_amendment;
    const granted = recorded?.choice && recorded.choice !== "decline" && recorded.choice !== "cancel"
      && (!recorded.choice.startsWith("network-") || networkPolicy?.action === "allow");
    const presentation = result === "confirmed" && granted ? {
        id: `approval:${crypto.createHash("sha256").update(JSON.stringify([request.hostId ?? "local",
          request.threadId, request.turnId, request.nativeKey ?? notice.id, recorded.version])).digest("hex")}`,
        hostId: request.hostId ?? "local", threadId: request.threadId, turnId: request.turnId,
        kind: "approval" as const, acceptedAt: Date.now(),
      } : undefined;
    this.journal.update(notice.id, { phase: result, ...(presentation ? { presentation } : {}), notice: {
      sourceKey: this.journal.notice(notice.id)?.sourceKey,
      messageId: this.journal.notice(notice.id)?.messageId,
      mentions: notice.mentions?.map(mention => ({ ...mention })), outcome: result, delivery: "ready", attempts: 0,
    } });
    if (presentation) {
      try { await this.options.onAcceptedInput?.(presentation); }
      catch { console.warn("[codex-im-gateway] confirmed approval presentation pending"); }
    }
    await this.resolutionDelivery.deliver(notice.id);
  }

  acceptedPresentationInputs(): AcceptedPresentationInput[] {
    return this.journal.confirmedPresentations();
  }

  declineAll(senderId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.senderId === senderId) this.settle(senderId, pending.id, denial(pending.request));
    }
  }

  /** Retire this observer without answering any native request. */
  close(): void {
    if (this.closed) return;
    this.closed = true; this.resolutionDelivery.close();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve(undefined); }
    this.pending.clear();
  }

  hasPending(senderId: string): boolean {
    return [...this.pending.values()].some(item => item.senderId === senderId);
  }

  private resolveId(senderId: string, rawId: string): string | undefined {
    const normalized = rawId.trim().toUpperCase();
    if (normalized) return this.pending.has(this.key(senderId, normalized)) ? normalized : undefined;
    const matches = Array.from(this.pending.values()).filter((pending) => pending.senderId === senderId);
    return matches.length === 1 ? matches[0]?.id : undefined;
  }

  private settle(senderId: string, id: string, decision: CodexApprovalDecision): boolean {
    const key = this.key(senderId, id);
    const pending = this.pending.get(key);
    if (!pending) return false;
    const option = approvalOptions(pending.request).find(o => o.id === decision);
    try { this.journal.update(id, { phase: "unconfirmed", choice: decision, label: option?.label ?? decision }); }
    catch (error) {
      // Never authorize without the audit commit. Denial must still release a
      // native waiter on timeout/shutdown even if the disk has become unavailable.
      if (decision !== denial(pending.request)) throw error;
      console.warn(`[codex-im-gateway] approval ${id} denied; audit write unavailable`);
    }
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
  }

  private key(senderId: string, id: string): string {
    return `${senderId}\u0000${id}`;
  }
}

function approvalDetails(request: CodexApprovalRequest) {
  const details = request.kind === "command"
    ? ["类型：运行命令", request.command ? `命令：\n${limit(request.command)}` : undefined]
    : request.kind === "file"
      ? ["类型：修改文件", request.grantRoot ? `写入范围：${request.grantRoot}` : undefined,
        request.fileChanges?.length ? `修改清单：\n${request.fileChanges.map(file =>
          `${{ add: "新增", delete: "删除", update: "修改" }[file.kind]}：${approvalPath(file.path)}${file.movePath ? ` → ${approvalPath(file.movePath)}` : ""}`).join("\n")}${(request.fileChangeCount ?? 0) > request.fileChanges.length ? `\n仅显示前 ${request.fileChanges.length} 项，共 ${request.fileChangeCount} 项。` : ""}`
          : "文件清单暂不可用，请到 Codex 核对修改范围后再决定。"]
      : request.kind === "mcp"
        ? ["类型：工具操作确认", request.serverName ? `来源：${request.serverName}` : undefined]
        : ["类型：申请额外权限", request.permissions ? `权限：${limit(JSON.stringify(request.permissions))}` : undefined];
  return [`会话：${request.threadId}`, ...details,
    request.cwd ? `工作目录：${request.cwd}` : undefined,
    request.reason ? `原因：${limit(request.reason)}` : undefined,
    request.scopeDescription ? `授权对象：${limit(request.scopeDescription)}` : undefined];
}
function approvalPath(value: string): string {
  return Array.from(value.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ")).slice(0, 500).join("")
    .replace(/[\\`*_{}\[\]<>#|~]/g, "\\$&");
}
function approvalNotice(id: string, request: CodexApprovalRequest, timeoutMs: number): ChannelApprovalNotice {
  const timeout = `${Math.max(1, Math.ceil(timeoutMs / 60_000))} 分钟内未处理将自动拒绝。`;
  const body = approvalDetails(request).filter(Boolean).join("\n");
  const options = approvalOptions(request);
  const command = (o: CodexApprovalOption) => o.id === "decline" ? `/reject ${id}` : `/approve ${id}${o.id === "accept" ? "" : ` ${o.id}`}`;
  const summary = [`【Codex 审批 ${id}】`, body,
    ...options.map(o => `${o.label}：${o.description}\n\n${copyBlock(command(o))}`), timeout].join("\n\n");
  return {
    text: summary,
    card: createChoiceCard({
      title: `Codex 审批 ${id}`,
      template: "orange",
      body,
      note: timeout,
      fallbackText: summary,
      choices: options.map(o => ({ label: o.label, command: o.id === "decline" ? "reject" : "approve",
        arg: o.id === "accept" || o.id === "decline" ? id : `${id} ${o.id}`,
        style: o.id === "decline" || o.id === "cancel" ? "danger" : o.id === "accept" ? "primary" : "default",
        ...(o.id !== "decline" && o.id !== "cancel" ? { confirm: o.description } : {}) }))
    })
  };
}
function denial(request: CodexApprovalRequest): CodexApprovalDecision {
  return approvalOptions(request).some(o => o.id === "decline") ? "decline" : "cancel";
}

function limit(value: string): string {
  return value.length > 1_200 ? `${value.slice(0, 1_200)}…` : value;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
