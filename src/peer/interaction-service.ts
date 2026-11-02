import { z } from "zod";
import type { CodexBridgeBackend } from "../codex/backend.js";
import type { NativeInteractionObserver } from "../codex/interactions.js";
import { approvalOptions, type CodexApprovalDecision } from "../codex/approval.js";
import { PeerConnection, PeerError, PEER_EXECUTION_TIMEOUT_MS } from "./rpc.js";

/** A subscription only borrows the native observer. Ending it retires prompts,
 * never sends an approval decision or interrupts the owning turn. */
export class PeerInteractionService {
  private readonly leases = new Map<string, { connection: PeerConnection; close(): Promise<void> }>();
  constructor(private readonly backend: CodexBridgeBackend) {}
  async call(connection: PeerConnection, method: string, threadId: string, id: string, current: () => void): Promise<unknown> {
    if (method === "unobserveThreadInteractions") {
      const lease = this.leases.get(id);
      if (lease?.connection === connection) await lease.close();
      return null;
    }
    if (!this.backend.observeThreadInteractions) throw new PeerError("unsupported", "设备后端不支持原生交互订阅。");
    if (this.leases.has(id) || this.leases.size >= 100) throw new PeerError("busy", "原生交互订阅已存在或达到上限。");
    const done = deferred(), consumer = `peer:${id}`;
    let live = true, timer: NodeJS.Timeout | undefined;
    const check = () => { if (!live || !connection.open) throw new PeerError("stale", "交互订阅已退休。"); current(); };
    const callback = async (name: string, args: unknown[]) => {
      check(); const result = await connection.request("execution.callback", { operationId: id, name, args }, PEER_EXECUTION_TIMEOUT_MS);
      check(); return result;
    };
    const notify = (name: string, args: unknown[]) => callback(name, args).then(() => {}, () => {});
    const observer: NativeInteractionObserver = {
      onApproval: async input => {
        try { const answer = await callback("onApproval", [input]); return approvalOptions(input.request).some(o => o.id === answer) ? answer as CodexApprovalDecision : undefined; }
        catch { return undefined; }
      },
      onResult: (input, result) => notify("onResult", [input, result]),
      onUserInput: async input => {
        try { const result = await callback("onUserInput", [input]); return result == null ? undefined : z.record(z.string(), z.object({ answers: z.array(z.string()) }).strict()).parse(result); }
        catch { return undefined; }
      },
      onUserInputResult: (input, result) => notify("onUserInputResult", [input, result]),
      onProgress: (scope, text) => notify("onProgress", [scope, text]),
      onObservedUserInputAnswers: receipts => notify("onObservedUserInputAnswers", [receipts]),
      onUnsupportedInteraction: async input => { try { return await callback("onUnsupportedInteraction", [input]) === true; } catch { return false; } }
    };
    let starting: Promise<void> | undefined;
    let removeClose = () => {};
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      live = false; if (timer) clearInterval(timer); removeClose();
      try { await starting?.catch(() => {}); await this.backend.unobserveThreadInteractions?.(threadId, "local", consumer); }
      finally { this.leases.delete(id); done.resolve(); }
    })();
    this.leases.set(id, { connection, close });
    removeClose = connection.onClose(() => { void close().catch(() => {}); });
    try {
      starting = this.backend.observeThreadInteractions(threadId, "local", observer, consumer);
      await starting;
      check(); await callback("ready", []);
      timer = setInterval(() => {
        try { check(); if (this.backend.interactionSubscriptionReady?.(threadId, "local") === false) throw Error("refresh"); }
        catch { void close().catch(() => {}); }
      }, 1000); timer.unref();
      await done.promise; return null;
    } finally { await close(); }
  }
}

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
