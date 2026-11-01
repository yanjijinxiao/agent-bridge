import crypto from "node:crypto";
import { desktopAsyncUserInputs, desktopAsyncAnswerReceipts, asyncAnswerDigest, asyncUserInputReply,
  type NativeAsyncAnswerReceipt } from "./async-user-input.js";
import type { CodexSteerInput, CodexSteerResult, CodexUserInputResult } from "./backend.js";
import type { NativeInteractionObserver, NativeUserInput } from "./interactions.js";

type Pending = { input: NativeUserInput; observer: NativeInteractionObserver; submitted: boolean; accepted: boolean;
  expected?: NativeAsyncAnswerReceipt[]; failureReported?: boolean };

/** Native agent-message questions share the same item DTO in all clients.
 * Replies use guarded turn/steer and exact accepted native answer evidence. */
export class NativeAsyncQuestions {
  private readonly items = new Map<string, Map<string, Record<string, unknown>>>();
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly hostId: string,
    private readonly current: (threadId: string, observer: NativeInteractionObserver) => boolean,
    private readonly steer: (input: CodexSteerInput) => Promise<CodexSteerResult>,
    private readonly refresh: (threadId: string) => void) {}

  observe(threadId: string, turnId: string, values: unknown[], observer: NativeInteractionObserver): void {
    const scope = JSON.stringify([threadId, turnId]), items = this.items.get(scope) ?? new Map();
    for (const value of values) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      if (typeof item.id !== "string") continue;
      if (item.type === "agentMessage" && (items.has(item.id) || Array.isArray(item.questions) && item.questions.length)
        || ["userMessage", "steeringUserMessage"].includes(String(item.type))
          && JSON.stringify(item.content ?? item.input ?? []).includes("<send_user_message_question_reply>")) items.set(item.id, item);
    }
    this.items.set(scope, items);
    const state = { threadRuntimeStatus: { type: "active" }, turns: [{ turnId, status: "inProgress", items: [...items.values()] }] };
    const receipts = desktopAsyncAnswerReceipts(threadId, state, this.hostId);
    if (receipts.length) void Promise.resolve(observer.onObservedUserInputAnswers?.(receipts)).catch(() => {});
    for (const [key, pending] of this.pending) if (pending.submitted && pending.expected?.every(expected => receipts.some(r =>
      r.threadId === expected.threadId && r.turnId === expected.turnId && r.questionId === expected.questionId && r.digest === expected.digest))) {
      this.pending.delete(key); this.report(pending, "confirmed");
    } else if (!pending.submitted && pending.input.request.questions.every(q => receipts.some(r => r.questionId === q.id
      && r.threadId === pending.input.request.threadId && r.turnId === pending.input.request.turnId))) {
      this.pending.delete(key); this.report(pending, "withdrawn");
    }
    const requests = desktopAsyncUserInputs(threadId, state, this.hostId);
    const live = new Set(requests.map(request => request.requestId ?? JSON.stringify(["async", turnId, request.itemId])));
    for (const [key, pending] of this.pending) if (!pending.submitted && pending.input.request.threadId === threadId
      && pending.input.request.turnId === turnId && !live.has(pending.input.requestId as string)) {
      this.pending.delete(key); this.report(pending, "withdrawn");
    }
    for (const request of requests) {
      const requestId = request.requestId ?? JSON.stringify(["async", turnId, request.itemId]), key = JSON.stringify([threadId, turnId, requestId]);
      const previous = this.pending.get(key);
      if (previous && JSON.stringify(previous.input.request.questions) !== JSON.stringify(request.questions)) {
        this.pending.delete(key); this.report(previous, previous.submitted ? "suspended" : "withdrawn");
      }
      if (this.pending.has(key) || !observer.onUserInput) continue;
      const input: NativeUserInput = { hostId: this.hostId, requestId, method: "item/tool/requestUserInput", request: { ...request, requestId } };
      const pending: Pending = { input, observer, submitted: false, accepted: false };
      this.pending.set(key, pending);
      void Promise.resolve().then(() => observer.onUserInput!(input)).then(async answers => {
        if (this.pending.get(key) !== pending) return;
        if (!this.current(threadId, observer)) { this.pending.delete(key); this.report(pending, "withdrawn"); return; }
        if (answers === undefined) { this.pending.delete(key); this.refresh(threadId); return; }
        pending.expected = request.questions.map(q => ({ hostId: this.hostId, threadId, turnId, questionId: q.id,
          digest: asyncAnswerDigest(q.id, q.question, answers[q.id]?.answers[0] ?? "") }));
        const clientUserMessageId = crypto.createHash("sha256").update(JSON.stringify([this.hostId, threadId, requestId, pending.expected])).digest("hex");
        pending.submitted = true;
        const receipt = await this.steer({ threadId, expectedTurnId: turnId, prompt: asyncUserInputReply(request, answers), clientUserMessageId });
        if (receipt.turnId !== turnId) throw new Error("Native async answer identity mismatch");
        if (this.pending.get(key) !== pending) return;
        pending.accepted = true; this.observe(threadId, turnId, [], observer);
      }).catch(() => {
        if (this.pending.get(key) !== pending) return;
        if (!pending.submitted) this.pending.delete(key);
        pending.failureReported = true; this.report(pending, pending.submitted ? "failed" : "suspended");
      });
    }
  }
  end(threadId: string, turnId?: string): void {
    for (const [key, pending] of this.pending) if (pending.input.request.threadId === threadId
      && (!turnId || pending.input.request.turnId === turnId)) {
      this.pending.delete(key); if (!pending.failureReported) this.report(pending, pending.submitted ? "suspended" : "withdrawn");
    }
    for (const scope of this.items.keys()) { const [thread, turn] = JSON.parse(scope); if (thread === threadId && (!turnId || turn === turnId)) this.items.delete(scope); }
  }
  disconnect(): void { for (const pending of [...this.pending.values()]) this.end(pending.input.request.threadId); this.items.clear(); }
  private report(pending: Pending, result: CodexUserInputResult) {
    void Promise.resolve().then(() => pending.observer.onUserInputResult?.(pending.input, result)).catch(() => {});
  }
}
