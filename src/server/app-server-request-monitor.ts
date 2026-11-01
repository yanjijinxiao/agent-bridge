import type { CodexBridgeBackend } from "../codex/backend.js";
import type { NativeInteractionObserver, NativeInteractionTarget } from "../codex/interactions.js";

export interface NativeRequestMonitor {
  start(): void;
  stop(): void | Promise<void>;
  setFollowedThreads(targets: Iterable<string | NativeInteractionTarget>): void;
  observationHealth?(): { connected: boolean; threads: unknown[] };
}

/** Subscription supervision only. Requests and replies use the SAME native
 * control connection as execution, not a Desktop-specific IPC protocol. */
export class AppServerRequestMonitor implements NativeRequestMonitor {
  private readonly targets = new Map<string, NativeInteractionTarget & { attempts: number; retryAt: number }>();
  private readonly pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly backend: () => CodexBridgeBackend, private readonly observer: NativeInteractionObserver,
    private readonly retryMs = 1000) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), this.retryMs); this.timer.unref();
    this.tick();
  }
  async stop(): Promise<void> {
    this.running = false; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    const targets = [...this.targets.values()]; this.targets.clear();
    await Promise.allSettled(targets.map(t => this.backend().unobserveThreadInteractions?.(t.threadId, t.hostId)));
  }
  setFollowedThreads(targets: Iterable<string | NativeInteractionTarget>): void {
    const next = new Map([...targets].map(t => typeof t === "string" ? { hostId: "local", threadId: t } : t)
      .map(t => [JSON.stringify([t.hostId, t.threadId]), t]));
    for (const [key, target] of this.targets) if (!next.has(key)) {
      this.targets.delete(key);
      void this.backend().unobserveThreadInteractions?.(target.threadId, target.hostId).catch(() => {});
    }
    for (const [key, target] of next) if (!this.targets.has(key)) this.targets.set(key, { ...target, attempts: 0, retryAt: 0 });
    this.tick();
  }
  observationHealth() {
    const threads = [...this.targets.values()].map(t => ({ hostId: t.hostId, threadId: t.threadId,
      subscribed: this.backend().interactionSubscriptionReady?.(t.threadId, t.hostId) ?? false, attempts: t.attempts }));
    return { connected: threads.some(t => t.subscribed), threads };
  }
  private tick(): void {
    if (!this.running) return;
    for (const [key, target] of this.targets) {
      if (this.pending.size >= 4) return;
      if (this.pending.has(key) || target.retryAt > Date.now()
        || this.backend().interactionSubscriptionReady?.(target.threadId, target.hostId)) continue;
      this.pending.add(key); target.attempts++;
      void Promise.resolve().then(async () => {
        await this.backend().observeThreadInteractions?.(target.threadId, target.hostId, this.observer);
        if (!this.running || this.targets.get(key) !== target)
          await this.backend().unobserveThreadInteractions?.(target.threadId, target.hostId);
      }).catch(() => {
        // The native writer lock is authoritative. Missing/unavailable owners
        // retain subscription intent, without another process or input retry.
      }).finally(() => {
        target.retryAt = Date.now() + Math.min(30000, this.retryMs * 2 ** Math.min(5, target.attempts - 1));
        this.pending.delete(key);
      });
    }
  }
}
