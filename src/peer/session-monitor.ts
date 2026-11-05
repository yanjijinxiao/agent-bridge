import crypto from "node:crypto";
import { z } from "zod";
import type { CodexSessionCompletionMonitorOptions } from "../server/codex-session-monitor.js";
import type { PeerRegistry } from "./registry.js";

const common = { sessionId: z.string(), turnId: z.string() };
const completion = z.object({ ...common, workspace: z.string(), taskTitle: z.string(), text: z.string(), success: z.boolean(),
  outcome: z.enum(["completed", "failed", "interrupted"]).optional(), failureCode: z.string().optional(), completedAt: z.string() }).strict();
const task = z.object({ ...common, workspace: z.string(), title: z.string(), status: z.enum(["running", "completed", "failed", "interrupted"]), startedAt: z.string(), updatedAt: z.string() }).strict();
const activity = z.object({ ...common, text: z.string(), updatedAt: z.string() }).strict();

/** Preserve the existing local external-task feed without reading Codex files
 * in Gateway. Bound sessions on every host continue using native subscriptions.
 * Only the explicitly migrated local host can export this whole-profile feed. */
export class ConnectorSessionMonitor {
  private active = false;
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private pending?: Promise<void>;
  private initializing?: Promise<void>;
  constructor(private readonly registry: PeerRegistry, private readonly handlers: CodexSessionCompletionMonitorOptions) {}
  start(): void {
    if (this.active) return;
    this.active = true; void this.scanNow();
    this.timer = setInterval(() => void this.scanNow(), 2000); this.timer.unref();
  }
  async scanNow(): Promise<void> {
    if (!this.active || this.pending || !this.registry.managedRoute("local") || !this.registry.isOnline("local")) return;
    const controller = this.controller = new AbortController();
    const id = crypto.randomBytes(32).toString("hex");
    let initialized!: () => void;
    this.initializing = new Promise<void>(resolve => { initialized = resolve; });
    this.pending = this.registry.invoke("local", "monitorSessionEvents", [], false, id, async (name, args) => {
      if (!this.active || this.controller !== controller) throw Error("Monitor retired");
      if (name === "onReady") initialized();
      else if (name === "onCompletion" || name === "onRecoveredCompletion") await this.handlers[name]?.(completion.parse(args[0]) as Parameters<NonNullable<typeof this.handlers.onCompletion>>[0]);
      else if (name === "onTaskChanged") await this.handlers.onTaskChanged?.(task.parse(args[0]));
      else if (name === "onActivity") await this.handlers.onActivity?.(activity.parse(args[0]));
      else throw Error("Unknown monitor event");
      return null;
    }, controller.signal).then(() => {}, () => {}).finally(async () => {
      initialized();
      try { await this.registry.invoke("local", "unmonitorSessionEvents", [id]); } catch { /* Disconnect also retires it. */ }
      if (this.controller === controller) { this.controller = undefined; this.pending = undefined; }
    });
  }
  async ready(): Promise<void> { await this.scanNow(); await this.initializing; }
  async stop(): Promise<void> {
    this.active = false; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.controller?.abort(); await this.pending;
  }
}
