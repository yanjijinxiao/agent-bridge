import { createChoiceCard, type ChannelActionCard } from "../channels/action-card.js";
import { channelProgressError } from "../channels/errors.js";
import { ApprovalJournal } from "./approval-journal.js";
import type { ChannelApprovalNotice } from "./approval.js";

const MAX_ATTEMPTS = 3;
type Scope = { recipientId: string; hostId: string; threadId: string; sourceKey?: string };

/** Native confirmation and IM delivery are distinct commits. Only replacement
 * of an acknowledged card can be retried after a missing provider receipt. */
export class ApprovalNoticeDelivery {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly persistenceFailures = new Set<string>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  constructor(private readonly journal: ApprovalJournal, private readonly options: {
    send: (recipientId: string, notice: ChannelApprovalNotice) => Promise<unknown>;
    updateCard?: (messageId: string, card: ChannelActionCard) => Promise<void>;
    validate?: (scope: Scope) => boolean;
    retryDelayMs?: number;
  }) {
    for (const record of journal.snapshot()) {
      const notice = journal.notice(record.id);
      if (notice?.delivery !== "pending") continue;
      notice.delivery = "unconfirmed";
      if (notice.messageId && options.updateCard && notice.attempts < MAX_ATTEMPTS) notice.retryAt = Date.now();
      journal.updateNotice(record.id, notice);
    }
    this.schedule();
  }
  rememberCard(id: string, messageId: string): void {
    if (this.closed || this.persistenceFailures.has(id)) return;
    const previous = this.journal.notice(id);
    if (previous?.messageId === messageId) return;
    // A native resolution may precede the initial card's ACK. Close that exact
    // late card too; do not leave its now-invalid approval buttons actionable.
    this.journal.updateNotice(id, { ...previous, messageId, delivery: "ready", attempts: 0 });
    this.schedule();
  }
  async deliver(id: string): Promise<void> {
    if (this.closed || this.persistenceFailures.has(id)) return;
    const ongoing = this.inflight.get(id);
    if (ongoing) { await ongoing; return this.deliver(id); }
    const record = this.journal.snapshot().find(record => record.id === id), notice = this.journal.notice(id);
    if (!record || !notice?.outcome || this.options.validate && !this.options.validate({ ...record, sourceKey: notice.sourceKey })
      || notice.delivery === "delivered" || notice.delivery === "unconfirmed"
        && (notice.retryAt === undefined || notice.retryAt > Date.now())) return;
    const outcome = notice.outcome;
    const action = (async () => {
      notice.delivery = "pending"; notice.attempts++; delete notice.retryAt;
      this.journal.updateNotice(id, notice);
      const text = outcome === "confirmed"
        ? `Codex 已确认审批 ${id} 请求结束；实际权限以原生工具当前状态为准。`
        : outcome === "withdrawn"
          ? `审批 ${id} 已失效或已在 Codex 中处理，请以 Codex 当前状态为准。`
          : `审批 ${id} 的决定未获 Codex 确认，不能确认已生效。请在 Codex 中检查；不要重复批准其他请求。`;
      try {
        if (notice.messageId && this.options.updateCard) {
          await this.options.updateCard(notice.messageId, createChoiceCard({
            title: `Codex 审批 ${id} · ${outcome === "confirmed" ? "请求已结束" : outcome === "withdrawn" ? "已失效" : "等待接收确认"}`,
            body: text, fallbackText: text, choices: [], template: outcome === "failed" ? "orange" : "grey" }));
        } else {
          const presentation = this.journal.confirmedPresentation(id);
          await this.options.send(record.recipientId, { text, mentions: notice.mentions, presentation });
        }
        notice.delivery = "delivered";
      } catch (error) {
        notice.delivery = "unconfirmed";
        if (notice.messageId && this.options.updateCard && notice.attempts < MAX_ATTEMPTS && channelProgressError(error).retryable) {
          notice.retryAt = Date.now() + (this.options.retryDelayMs ?? 5_000) * 2 ** (notice.attempts - 1);
        }
        console.warn("[codex-im-gateway] approval resolution notice unconfirmed; native decision unchanged");
      }
      // A retired service must not overwrite a replacement controller's file;
      // a late failed notice must not erase a stronger native confirmation.
      const current = this.journal.notice(id);
      if (!this.closed && current?.outcome === outcome && current.messageId === notice.messageId) this.journal.updateNotice(id, notice);
    })();
    this.inflight.set(id, action);
    try { await action; }
    catch (error) {
      // Retain the last durable state, but do not spin a zero-delay timer when
      // the audit disk is unavailable. A new process can reconcile it later.
      this.persistenceFailures.add(id); throw error;
    }
    finally { this.inflight.delete(id); this.schedule(); }
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    const due = this.journal.snapshot().flatMap(record => {
      const notice = this.journal.notice(record.id);
      if (!notice?.outcome || this.inflight.has(record.id) || this.persistenceFailures.has(record.id)
        || this.options.validate && !this.options.validate({ ...record, sourceKey: notice.sourceKey })) return [];
      const at = notice.delivery === "ready" ? Date.now()
        : notice.delivery === "unconfirmed" && notice.messageId && this.options.updateCard ? notice.retryAt : undefined;
      return at === undefined ? [] : [{ id: record.id, at }];
    });
    if (!due.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void Promise.all(due.filter(row => row.at <= Date.now()).map(row => this.deliver(row.id)))
        .catch(() => console.warn("[codex-im-gateway] approval notice receipt persistence unavailable"))
        .finally(() => this.schedule());
    }, Math.min(2_147_483_647, Math.max(0, Math.min(...due.map(row => row.at)) - Date.now())));
    this.timer.unref?.();
  }
  hasRestartBlockingWork(): boolean { return this.inflight.size > 0; }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
