import fs from "node:fs";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChannelMessage } from "../channels/message.js";
import { writeAtomicTextFile } from "../state/json-store.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { CodexBackendCapabilityError, CodexQueueAdmissionError, CodexRunAdmissionError } from "../codex/backend.js";

export type InboundReceipt = {
  phase: "received" | "submitting" | "accepted" | "handled" | "unconfirmed";
  clientUserMessageId: string;
  conversationId?: string; actorId?: string;
  sessionId?: string; hostId?: string; threadId?: string; turnId?: string;
  queuedSubmissionId?: string;
  /** Explicit ordinary turn submission; legacy sources may be checked against the saved inbox. */
  nativeInput?: true;
  /** Terminal input is never recovered by matching native thread history. */
  runtimeInput?: true;
  /** Durable output obligation reconstructed from exact native history. */
  recoveredNativeInput?: true;
};
type Receipt = InboundReceipt;
const identity = (id: string) => crypto.createHash("sha256").update(id.trim()).digest("hex");

/** Source receipts only: no bodies, execution backlog, timers or automatic resubmission.
 * A redelivery may reclaim preparation after a crash, never an attempted mutation.
 * One account owner injects this instance into every submission entry point.
 */
export class InboundReceiptJournal {
  private readonly context = new AsyncLocalStorage<Receipt>();
  private readonly claimed = new Set<string>();
  private readonly processing = new Set<string>();
  private readonly receipts: Record<string, Receipt>;
  private writes = 0;
  private appendUnavailable = false;
  constructor(private readonly filePath: string, legacyIds: readonly string[] = [],
    private readonly options: { onAccepted?: (receipt: Readonly<InboundReceipt>) => void } = {}) {
    this.receipts = {};
    let raw: Buffer | undefined;
    try { raw = fs.readFileSync(filePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!raw) {
      for (const id of legacyIds) this.receipts[identity(id)] = { phase: "handled", clientUserMessageId: `gateway-${identity(id)}` };
      this.compact();
      return;
    }
    const end = raw.lastIndexOf(10) + 1;
    if (!end) throw Error("Invalid inbound receipt journal header");
    const lines = raw.subarray(0, end).toString("utf8").trimEnd().split("\n");
    if (JSON.parse(lines.shift()!).version !== 1) throw Error("Invalid inbound receipt journal version");
    for (const line of lines) {
      const { id, receipt } = JSON.parse(line);
      if (!/^[a-f0-9]{64}$/.test(id) || !receipt || receipt.clientUserMessageId !== `gateway-${id}`
        || !["received", "submitting", "accepted", "handled", "unconfirmed"].includes(receipt.phase)
        || receipt.nativeInput !== undefined && receipt.nativeInput !== true
        || receipt.runtimeInput !== undefined && receipt.runtimeInput !== true
        || receipt.runtimeInput && (receipt.nativeInput || receipt.turnId || receipt.queuedSubmissionId)
        || receipt.recoveredNativeInput !== undefined && receipt.recoveredNativeInput !== true) throw Error("Invalid inbound receipt");
      this.receipts[id] = receipt;
    }
    // An incomplete last append cannot authorize a native write: submitting is
    // fsynced before dispatch. Earlier accepted/submitting evidence is retained.
    if (end < raw.length) {
      const fd = fs.openSync(filePath, "r+");
      try { fs.ftruncateSync(fd, end); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    // A code rollback may have handled newer messages using the old store.
    // Import only missing tombstones; never weaken an existing receipt phase.
    for (const messageId of legacyIds) {
      const id = identity(messageId);
      if (!this.receipts[id]) {
        const receipt: Receipt = { phase: "handled", clientUserMessageId: `gateway-${id}` };
        this.receipts[id] = receipt; this.save(receipt);
      }
    }
  }
  private compact(): void {
    const text = JSON.stringify({ version: 1 }) + "\n" + Object.entries(this.receipts)
      .map(([id, receipt]) => JSON.stringify({ id, receipt }) + "\n").join("");
    writeAtomicTextFile(this.filePath, text, { durable: true });
  }
  private save(receipt: Receipt): void {
    // Append only the changed fact; do not rewrite an ever-growing ID history
    // for every incoming message. No ID is evicted by message count.
    if (this.appendUnavailable) throw Error("Inbound receipt journal needs restart recovery; no further append attempted");
    const id = receipt.clientUserMessageId.slice("gateway-".length);
    const fd = fs.openSync(this.filePath, "r+");
    let position: number | undefined;
    try {
      position = fs.fstatSync(fd).size;
      const body = Buffer.from(JSON.stringify({ id, receipt }) + "\n");
      let offset = 0;
      while (offset < body.length) {
        const written = fs.writeSync(fd, body, offset, body.length - offset, position + offset);
        if (!written) throw Error("Inbound receipt append incomplete");
        offset += written;
      }
      fs.fsyncSync(fd);
    } catch (error) {
      // A failed append must not become a broken middle line when the next
      // message arrives. If repair fails, stop all appends until restart recovery.
      try { if (position !== undefined) { fs.ftruncateSync(fd, position); fs.fsyncSync(fd); } }
      catch { this.appendUnavailable = true; }
      throw error;
    } finally { fs.closeSync(fd); }
    if (++this.writes >= 1024) { this.writes = 0; if (fs.statSync(this.filePath).size > 1024 * 1024) this.compact(); }
  }
  private transition(receipt: Receipt, patch: Partial<Receipt>): void {
    const previous = structuredClone(receipt); Object.assign(receipt, patch);
    try { this.save(receipt); }
    catch (error) {
      for (const key of Object.keys(receipt)) delete (receipt as Record<string, unknown>)[key];
      Object.assign(receipt, previous); throw error;
    }
  }
  claim(message: Pick<ChannelMessage, "id" | "senderId" | "replyTargetId">): boolean {
    if (!message.id.trim()) return false;
    const key = identity(message.id), prior = this.receipts[key];
    if (this.claimed.has(key) || this.processing.has(key) || prior && prior.phase !== "received") return false;
    if (prior && (prior.actorId !== message.senderId || prior.conversationId !== (message.replyTargetId ?? message.senderId))) return false;
    this.receipts[key] ??= { phase: "received", clientUserMessageId: `gateway-${key}`,
      actorId: message.senderId, conversationId: message.replyTargetId ?? message.senderId };
    this.save(this.receipts[key]); // Failure prevents dispatch, rather than weakening deduplication.
    this.claimed.add(key);
    return true;
  }
  async handle(message: Pick<ChannelMessage, "id" | "senderId" | "replyTargetId">, action: () => Promise<void>): Promise<void> {
    const key = identity(message.id);
    if (this.processing.has(key)) return;
    if (!this.claimed.has(key) && !this.claim(message)) return;
    const receipt = this.receipts[key];
    if (receipt.actorId !== message.senderId || receipt.conversationId !== (message.replyTargetId ?? message.senderId)) {
      this.claimed.delete(key); throw Error("入站对话身份已改变，消息未提交。");
    }
    this.claimed.delete(key); this.processing.add(key);
    try {
      await this.context.run(receipt, action);
      if (!(receipt.runtimeInput && receipt.phase === "unconfirmed")) this.transition(receipt, { phase: "handled" });
    } catch (error) {
      if (receipt.phase === "submitting") {
        this.transition(receipt, { phase: error instanceof CodexCommunicationError && error.submission === "not-submitted"
          || error instanceof CodexBackendCapabilityError || error instanceof CodexQueueAdmissionError
          || error instanceof CodexRunAdmissionError ? "received" : "unconfirmed" });
      }
      throw error;
    } finally { this.processing.delete(key); }
  }
  currentId(): string | undefined { return this.context.getStore()?.clientUserMessageId; }
  /** Native RPC events may arrive outside the dispatch AsyncLocalStorage context. */
  capture() {
    const receipt = this.context.getStore();
    if (!receipt) return undefined;
    return {
      currentId: () => receipt.clientUserMessageId,
      submitting: (scope: Pick<Receipt, "sessionId" | "hostId" | "threadId" | "nativeInput" | "runtimeInput">) => {
        if ((scope.runtimeInput || receipt.runtimeInput) && (scope.nativeInput || receipt.nativeInput || receipt.turnId || receipt.queuedSubmissionId))
          throw Error("Terminal and native input receipts cannot be mixed");
        this.transition(receipt, { ...scope, ...(receipt.phase === "received" ? { phase: "submitting" } : {}) });
      },
      accepted: (threadId: string, turnId: string) => {
        if (receipt.runtimeInput) throw Error("Terminal input cannot acquire a native turn receipt");
        this.transition(receipt, { phase: "accepted", threadId, turnId });
        try { this.options.onAccepted?.(structuredClone(receipt)); }
        catch { console.warn("[codex-im-gateway] accepted input cleanup deferred; durable native receipt retained"); }
      },
      runtimeAccepted: (threadId: string) => {
        if (!receipt.runtimeInput || receipt.nativeInput || receipt.turnId) throw Error("Invalid terminal input receipt");
        this.transition(receipt, { phase: "accepted", threadId });
        try { this.options.onAccepted?.(structuredClone(receipt)); }
        catch { console.warn("[agent-bridge] terminal input cleanup deferred; durable receipt retained"); }
      },
      runtimeUnconfirmed: () => {
        if (!receipt.runtimeInput) throw Error("Invalid terminal input receipt");
        this.transition(receipt, { phase: "unconfirmed" });
      }
    };
  }
  releasePreparation(messageId: string): void {
    const key = identity(messageId);
    if (!this.processing.has(key) && this.receipts[key]?.phase === "received") this.claimed.delete(key);
  }
  submitting(scope: Pick<Receipt, "sessionId" | "hostId" | "threadId"> = {}): void { this.capture()?.submitting(scope); }
  accepted(threadId: string, turnId: string): void { this.capture()?.accepted(threadId, turnId); }
  queued(threadId: string, queuedSubmissionId: string, turnId?: string): void {
    const receipt = this.context.getStore(); if (!receipt) return;
    if (receipt.runtimeInput) throw Error("Terminal input cannot acquire a native queue receipt");
    this.transition(receipt, { phase: "accepted", threadId, queuedSubmissionId, ...(turnId ? { turnId } : {}) });
    try { this.options.onAccepted?.(structuredClone(receipt)); }
    catch { console.warn("[codex-im-gateway] queued input cleanup deferred; durable native receipt retained"); }
  }
  abandon(messageId: string): boolean {
    const key = identity(messageId), receipt = this.receipts[key];
    if (!receipt || receipt.phase !== "received" || this.processing.has(key)) return false;
    this.transition(receipt, { phase: "handled" });
    this.claimed.delete(key); return true;
  }
  snapshot(): Readonly<Record<string, Receipt>> { return structuredClone(this.receipts); }
  receipt(messageId: string): Readonly<Receipt> | undefined {
    const receipt = this.receipts[identity(messageId)]; return receipt && structuredClone(receipt);
  }
  /** Only exact Connector handoff evidence repairs terminal acceptance. It is
   * never a native turn and never schedules input or native result recovery. */
  recoverRuntimeAccepted(proof: { clientUserMessageId: string; sessionId: string; hostId: string; threadId: string;
    actorId: string; conversationId: string }): boolean {
    const key = proof.clientUserMessageId.slice("gateway-".length), current = this.receipts[key];
    if (!/^gateway-[a-f0-9]{64}$/.test(proof.clientUserMessageId) || !current || this.processing.has(key)
      || !current.runtimeInput || current.nativeInput || current.turnId || current.queuedSubmissionId
      || !["submitting", "unconfirmed"].includes(current.phase)
      || current.sessionId !== proof.sessionId || current.threadId !== proof.threadId || (current.hostId ?? "local") !== proof.hostId
      || current.actorId !== proof.actorId || current.conversationId !== proof.conversationId) return false;
    this.transition(current, { phase: "accepted" });
    try { this.options.onAccepted?.(structuredClone(current)); }
    catch { console.warn("[agent-bridge] recovered terminal cleanup deferred; durable receipt retained"); }
    return true;
  }
  /** The account's queue coordinator owns the native identity and result duty.
   * Bridge its confirmed receipt back to the original IM identity after a crash
   * between the two journals. Never create a second ordinary-result obligation. */
  recoverQueued(expected: Readonly<Receipt>, proof: {
    messageId: string; actorId: string; conversationId: string; sessionId: string; hostId: string; threadId: string;
    queuedSubmissionId?: string; turnId?: string;
  }): boolean {
    const key = identity(proof.messageId), current = this.receipts[key];
    if (!current || this.processing.has(key) || !["submitting", "unconfirmed"].includes(current.phase)
      || current.nativeInput || current.runtimeInput || JSON.stringify(current) !== JSON.stringify(expected)
      || current.actorId !== proof.actorId || current.conversationId !== proof.conversationId
      || current.sessionId !== proof.sessionId || (current.hostId ?? "local") !== proof.hostId || current.threadId !== proof.threadId
      || !proof.queuedSubmissionId?.trim() && !proof.turnId?.trim()
      || current.queuedSubmissionId && current.queuedSubmissionId !== proof.queuedSubmissionId
      || current.turnId && current.turnId !== proof.turnId) return false;
    this.transition(current, { phase: "accepted", ...(proof.queuedSubmissionId ? { queuedSubmissionId: proof.queuedSubmissionId } : {}),
      ...(proof.turnId ? { turnId: proof.turnId } : {}) });
    try { this.options.onAccepted?.(structuredClone(current)); }
    catch { console.warn("[codex-im-gateway] recovered queue cleanup deferred; durable native receipt retained"); }
    return true;
  }
  /** Commit exact, read-only native evidence without claiming or dispatching
   * the saved input. A late read cannot overwrite a live/newer journal fact. */
  recoverAccepted(expected: Readonly<Receipt>, proof: { hostId: string; threadId: string; turnId: string }): boolean {
    const key = expected.clientUserMessageId.slice("gateway-".length), current = this.receipts[key];
    if (!current || this.processing.has(key) || !["submitting", "unconfirmed"].includes(current.phase)
      || current.runtimeInput
      || JSON.stringify(current) !== JSON.stringify(expected) || !proof.turnId.trim()
      || (current.hostId ?? "local") !== proof.hostId || current.threadId !== proof.threadId
      || current.turnId && current.turnId !== proof.turnId) return false;
    this.transition(current, { phase: "accepted", turnId: proof.turnId, recoveredNativeInput: true });
    try { this.options.onAccepted?.(structuredClone(current)); }
    catch { console.warn("[codex-im-gateway] recovered acceptance cleanup deferred; durable native receipt retained"); }
    return true;
  }
  /** Only the persistent result-delivery journal may settle this obligation. */
  recoveredResultDelivered(expected: Readonly<Receipt>): void {
    const current = this.receipts[expected.clientUserMessageId.slice("gateway-".length)];
    if (current?.phase === "accepted" && current.recoveredNativeInput && JSON.stringify(current) === JSON.stringify(expected))
      this.transition(current, { phase: "handled" });
  }
}
