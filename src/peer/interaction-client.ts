import crypto from "node:crypto";
import type { NativeInteractionObserver } from "../codex/interactions.js";
import type { PeerRegistry } from "./registry.js";
import { PeerError } from "./rpc.js";

export class PeerInteractionClient {
  private readonly subscriptions = new Map<string, { host: string; thread: string; id: string; ready: boolean; close(): Promise<void> }>();
  constructor(private readonly registry: PeerRegistry) {}
  ready(thread: string, host: string): boolean { return [...this.subscriptions.values()].some(s => s.host === host && s.thread === thread && s.ready); }
  async observe(thread: string, host: string, observer: NativeInteractionObserver, consumer = "gateway"): Promise<void> {
    if (!this.registry.description(host).interactions) throw new PeerError("unsupported", "请更新 Connector 以启用原生交互订阅。");
    await this.unobserve(thread, host, consumer);
    const key = JSON.stringify([host, thread, consumer]), id = crypto.randomBytes(32).toString("hex"), ready = deferred();
    const controller = new AbortController(), requests = new Map<string, any>(), answered = new Set<string>();
    const retire = async () => {
      const pending = [...requests]; requests.clear();
      await Promise.allSettled(pending.map(([key, input]) => Promise.resolve().then(() => {
        const result = answered.has(key) ? "failed" as const : "withdrawn" as const;
        return key.startsWith('["approval"') ? observer.onResult?.(input, result) : observer.onUserInputResult?.(input, result);
      })));
    };
    const subscription = { host, thread, id, ready: false, close: async () => {
      subscription.ready = false; controller.abort(); void retire();
      try { await this.registry.invoke(host, "unobserveThreadInteractions", [thread, id]); } catch { /* Connection close also retires it. */ }
    } };
    this.subscriptions.set(key, subscription);
    const callback = async (name: string, values: unknown[]) => {
      if (this.subscriptions.get(key) !== subscription) throw new PeerError("stale", "交互订阅已退休。");
      if (name === "ready") { subscription.ready = true; ready.resolve(); return null; }
      if (!["onApproval", "onResult", "onUserInput", "onUserInputResult", "onProgress", "onObservedUserInputAnswers", "onUnsupportedInteraction"].includes(name)) throw new PeerError("scope", "Unknown native interaction");
      let receiptKey: string | undefined;
      if (name === "onObservedUserInputAnswers") {
        if (!Array.isArray(values[0]) || values[0].some(v => v.threadId !== thread)) throw new PeerError("scope", "Invalid answer scope");
        values[0] = values[0].map(v => ({ ...v, hostId: host }));
      } else {
        const envelope = values[0] as any;
        if (!envelope || (envelope.request?.threadId ?? envelope.threadId) !== thread) throw new PeerError("scope", "Invalid interaction scope");
        values[0] = { ...envelope, hostId: host, ...(envelope.request ? { request: { ...envelope.request, hostId: host } } : {}) };
        if (["onApproval", "onResult", "onUserInput", "onUserInputResult"].includes(name)) {
          const requestKey = JSON.stringify([name === "onApproval" || name === "onResult" ? "approval" : "question", values[0]]);
          if (name === "onApproval" || name === "onUserInput") {
            if (!requests.has(requestKey)) requests.set(requestKey, values[0]);
          } else if (!requests.has(requestKey)) throw new PeerError("scope", "Unmatched native interaction receipt");
          values[0] = requests.get(requestKey); receiptKey = requestKey;
        }
      }
      try {
        const result = await (observer as any)[name]?.(...values) ?? null;
        if (receiptKey && result !== null && (name === "onApproval" || name === "onUserInput")) answered.add(receiptKey);
        return result;
      } finally {
        if (receiptKey && (name === "onResult" || name === "onUserInputResult")) { requests.delete(receiptKey); answered.delete(receiptKey); }
      }
    };
    void this.registry.invoke(host, "observeThreadInteractions", [thread], false, id, callback, controller.signal)
      .catch(error => { ready.reject(error); })
      .finally(() => { subscription.ready = false; if (this.subscriptions.get(key) === subscription) this.subscriptions.delete(key); ready.reject(new PeerError("stale", "交互订阅已断开。")); void retire(); });
    return ready.promise;
  }
  async unobserve(thread: string, host: string, consumer = "gateway") {
    const key = JSON.stringify([host, thread, consumer]), subscription = this.subscriptions.get(key);
    this.subscriptions.delete(key); await subscription?.close();
  }
  async close() { const all = [...this.subscriptions.values()]; this.subscriptions.clear(); await Promise.allSettled(all.map(s => s.close())); }
}

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
