import crypto from "node:crypto";
import { z } from "zod";
import type { RuntimeResource, RuntimeOutput } from "../agents/contracts.js";
import { assertSameReadTarget } from "../agents/contracts.js";
import { runtimeResourceSchema } from "../agents/protocol.js";
import type { RuntimeHandoffRecord } from "../agents/handoff.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { ChannelStreamCheckpoint } from "../channels/progress.js";
import { channelStreamCheckpointSchema } from "../channels/stream-checkpoint.js";
import type { TurnReplyStream } from "../channels/turn-presentation.js";

const scopeSchema = z.object({ sessionId: z.string().min(1), conversationId: z.string().min(1), actorId: z.string().min(1),
  accountId: z.string().min(1), hostId: z.string().min(1), threadId: z.string().min(1), bindingStamp: z.string().min(1),
  origin: z.literal("web").optional(),
  mention: z.object({ userId: z.string().min(1), name: z.string().optional() }).strict().optional() }).strict();
export type RuntimeObservationScope = z.infer<typeof scopeSchema>;
/** Presentation metadata is not part of a Connector grant identity. In
 * particular Web origin and binding stamps must never cross that wire schema. */
export function runtimeObservationPrincipal(scope: RuntimeObservationScope) {
  return { accountId: scope.accountId, conversationId: scope.conversationId, actorId: scope.actorId };
}
const rowSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), scope: scopeSchema, target: runtimeResourceSchema,
  phase: z.enum(["writing", "confirmed", "unknown", "not-sent"]), startedAt: z.number(), seenWorking: z.boolean(),
  /** Absence is a legacy/per-input observation, never a passive subscription. */
  following: z.object({ active: z.boolean() }).strict().optional(),
  lastSequence: z.number().optional(), lastSyncedAt: z.number().optional(),
  display: z.object({ version: z.literal(1), boundary: z.string().optional(), published: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1024) }).strict().optional(),
  recovery: z.object({ clientUserMessageId: z.string().min(1).max(512), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  lastState: z.string().optional(), checkpoint: channelStreamCheckpointSchema.optional(), notificationAttempted: z.boolean().optional() }).strict();
export type RuntimeObservation = Omit<z.infer<typeof rowSchema>, "checkpoint"> & { checkpoint?: ChannelStreamCheckpoint };
const storeSchema = z.object({ version: z.literal(1), rows: z.record(z.string(), rowSchema) }).strict();

/** A read-only presentation obligation, not an execution queue. No prompt,
 * native turn ID, retry instruction or approval answer is persisted here. */
export class RuntimeObservationJournal {
  private rows: Record<string, RuntimeObservation>;
  constructor(private readonly file: string) {
    const raw = storeSchema.parse(readJsonFile(file, { version: 1, rows: {} }));
    if (Object.entries(raw.rows).some(([key, row]) => key !== row.id)) throw Error("Runtime observation identity mismatch");
    this.rows = raw.rows as Record<string, RuntimeObservation>;
  }
  list(): RuntimeObservation[] { return structuredClone(Object.values(this.rows)); }
  get(id: string): RuntimeObservation | undefined { return this.rows[id] && structuredClone(this.rows[id]); }
  put(row: RuntimeObservation): void {
    rowSchema.parse(row);
    const next = { ...this.rows, [row.id]: structuredClone(row) };
    writeJsonFile(this.file, { version: 1, rows: next }, { durable: true }); this.rows = next;
  }
  remove(id: string): void {
    const next = { ...this.rows }; delete next[id];
    writeJsonFile(this.file, { version: 1, rows: next }, { durable: true }); this.rows = next;
  }
}

/** Screen bytes are display-only. Escaping fences, images and links also
 * prevents copied terminal examples from becoming action/copy widgets. */
export function terminalScreenText(output: RuntimeOutput, limit = 1600): string {
  const text = Array.from(output.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""));
  const truncated = text.length > limit || !output.complete;
  const safe = text.slice(-limit).join("").replace(/[\\`*{}\[\]()#+.!>|_~-]/g, "\\$&").split("\n").map(line => `> ${line}`).join("\n");
  return `终端画面${truncated ? "（仅显示末尾片段）" : ""}：\n\n${safe || "> 当前画面为空"}`;
}

type RuntimeObservationOptions = {
  journal: RuntimeObservationJournal;
  current(scope: RuntimeObservationScope): boolean;
  followEnabled?(scope: RuntimeObservationScope): boolean;
  progressEnabled?(scope: RuntimeObservationScope): boolean;
  inspect(scope: RuntimeObservationScope): Promise<RuntimeResource>;
  read(scope: RuntimeObservationScope): Promise<RuntimeOutput>;
  receipt?(row: RuntimeObservation): Promise<RuntimeHandoffRecord | null>;
  recovered?(row: RuntimeObservation, receipt: RuntimeHandoffRecord): void;
  presentation(row: RuntimeObservation, save: (checkpoint: ChannelStreamCheckpoint) => void): TurnReplyStream;
  notify?: (row: RuntimeObservation) => Promise<void>;
  now?: () => number; intervalMs?: number;
  diagnostic?: (code: string) => void;
  decorateText?: (scope: RuntimeObservationScope, text: string) => string;
};

/** Reads only the selected runtime. Closing this observer never interrupts an
 * agent, and resuming it never calls send(). Terminal idle is explicitly not
 * a proof that a requested task succeeded. */
export class RuntimeObservationController {
  private readonly streams = new Map<string, TurnReplyStream>();
  private readonly busy = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly handoffs = new Set<string>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly options: RuntimeObservationOptions) { this.now = options.now ?? Date.now; }
  private sameBinding(a: RuntimeObservationScope, b: RuntimeObservationScope): boolean {
    return a.accountId === b.accountId && a.conversationId === b.conversationId && a.sessionId === b.sessionId
      && a.hostId === b.hostId && a.threadId === b.threadId && a.bindingStamp === b.bindingStamp;
  }
  /** Establish a read-only subscription. The original authorized actor remains
   * its owner; another participant's sync must not silently rewrite authority. */
  follow(scope: RuntimeObservationScope, target: RuntimeResource): string {
    if (this.closed || !this.options.current(scope)) throw Error("Runtime follow source is no longer authorized");
    const existing = this.options.journal.list().find(row => row.following && this.sameBinding(row.scope, scope)
      && this.options.current(row.scope));
    if (existing) { assertSameReadTarget(existing.target, target); return existing.id; }
    const id = crypto.createHash("sha256").update(JSON.stringify(["follow", scope])).digest("hex");
    this.options.journal.put({ id, scope, target, phase: "confirmed", startedAt: this.now(), seenWorking: false,
      following: { active: false } });
    this.start(); return id;
  }
  followStatus(scope: RuntimeObservationScope): RuntimeObservation | undefined {
    return this.options.journal.list().find(row => row.following && this.sameBinding(row.scope, scope));
  }
  /** Drop local timers while preserving the card handle and delivery evidence.
   * Reconstructing presentation permits /stream changes without a new card. */
  async refreshPresentation(scope: RuntimeObservationScope): Promise<void> {
    for (const row of this.options.journal.list().filter(row => this.sameBinding(row.scope, scope))) {
      await this.inFlight.get(row.id);
      this.busy.add(row.id);
      try {
        const stream = this.streams.get(row.id);
        if (stream) { await stream.suspend(); this.streams.delete(row.id); }
      } finally { this.busy.delete(row.id); }
    }
  }
  async synchronize(scope: RuntimeObservationScope, retryDelivery = false): Promise<void> {
    // Passive rows must observe input ownership before an input result is
    // retired in this pass, including a fast error/idle or reconnect.
    const rows = this.options.journal.list().filter(row => this.sameBinding(row.scope, scope))
      .sort((a, b) => Number(Boolean(b.following)) - Number(Boolean(a.following)));
    for (const row of rows) {
      await this.observe(row);
      const saved = this.options.journal.get(row.id);
      if (!saved || this.busy.has(row.id) || !this.options.current(saved.scope)
        || saved.following && this.options.followEnabled?.(saved.scope) === false) continue;
      this.busy.add(row.id);
      try {
        const terminal = saved.checkpoint?.terminal;
        if (terminal && retryDelivery) {
          if (await this.stream(saved).finalize(terminal.text, terminal.error,
            { outcome: terminal.outcome, recoverBootstrap: true, confirmUncertainDelivery: true })) await this.finish(row.id);
        } else if (!terminal && this.options.progressEnabled?.(saved.scope) !== false && (!saved.following || saved.following.active)) {
          await this.stream(saved).synchronize({ confirmUncertainDelivery: retryDelivery });
        }
      } finally { this.busy.delete(row.id); }
    }
  }
  begin(scope: RuntimeObservationScope, target: RuntimeResource, sourceId: string, fingerprint?: string): string {
    if (this.closed) throw Error("Runtime observation is closed");
    const id = crypto.createHash("sha256").update(JSON.stringify([scope.accountId, scope.conversationId, scope.actorId, sourceId])).digest("hex");
    const old = this.options.journal.get(id);
    if (old) {
      if (JSON.stringify(old.scope) !== JSON.stringify(scope) || JSON.stringify(old.target.ref) !== JSON.stringify(target.ref)
        || old.recovery && old.recovery.fingerprint !== fingerprint)
        throw Error("Runtime observation source belongs to another binding");
      return id;
    }
    if (!this.options.current(scope)) throw Error("Runtime observation source is no longer authorized");
    this.options.journal.put({ id, scope, target, phase: "writing", startedAt: this.now(), seenWorking: false,
      ...(fingerprint ? { recovery: { clientUserMessageId: sourceId, fingerprint } } : {}) });
    this.handoffs.add(id);
    return id;
  }
  handed(id: string, receipt: RuntimeHandoffRecord): void {
    const row = this.options.journal.get(id); if (!row) throw Error("Runtime observation intent missing");
    this.validateHandoff(row, receipt);
    row.phase = receipt.phase === "writing" ? "unknown" : receipt.phase;
    row.seenWorking ||= receipt.receipt?.kind === "terminal-written" && receipt.receipt.started === true;
    this.options.journal.put(row);
    this.handoffs.delete(id);
  }
  private validateHandoff(row: RuntimeObservation, receipt: RuntimeHandoffRecord): void {
    if (receipt.ref.endpointId !== row.target.ref.endpointId || receipt.ref.id !== row.target.ref.id)
      throw Error("Runtime handoff observation target mismatch");
    if (row.recovery && receipt.fingerprint !== row.recovery.fingerprint
      || receipt.receipt && (receipt.receipt.kind !== "terminal-written" || receipt.receipt.incarnation !== row.target.incarnation))
      throw Error("Runtime handoff evidence mismatch");
  }
  uncertain(id: string, phase: "unknown" | "not-sent" = "unknown"): void {
    const row = this.options.journal.get(id); if (!row) return;
    this.options.journal.put({ ...row, phase }); this.handoffs.delete(id);
  }
  start(): void {
    if (this.closed || this.timer || !this.options.journal.list().length) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().finally(() => this.start()); }, this.options.intervalMs ?? 1500);
    this.timer.unref();
  }
  private stream(row: RuntimeObservation): TurnReplyStream {
    let stream = this.streams.get(row.id);
    if (!stream) {
      stream = this.options.presentation(row, checkpoint => {
        const saved = this.options.journal.get(row.id);
        if (saved) this.options.journal.put({ ...saved, checkpoint });
      });
      if (this.options.decorateText) {
        const finalize = stream.finalize.bind(stream);
        stream.finalize = (text, error, options) => finalize(this.options.decorateText!(row.scope, text), error, options);
      }
      this.streams.set(row.id, stream);
    }
    return stream;
  }
  async tick(): Promise<void> {
    const rows = this.options.journal.list();
    await Promise.allSettled(rows.filter(row => row.following).map(row => this.observe(row)));
    await Promise.allSettled(rows.filter(row => !row.following).map(row => this.observe(row)));
  }
  private observe(row: RuntimeObservation): Promise<void> {
    const previous = this.inFlight.get(row.id); if (previous) return previous;
    if (this.closed || this.busy.has(row.id) || this.handoffs.has(row.id)) return Promise.resolve();
    // A prior row may have been retired while this tick's snapshot awaited
    // another observation. Never revive it from the stale snapshot.
    const current = this.options.journal.get(row.id); if (!current) return Promise.resolve();
    const work = this.observeNow(current).finally(() => this.inFlight.delete(row.id));
    this.inFlight.set(row.id, work); return work;
  }
  private async observeNow(row: RuntimeObservation): Promise<void> {
    if (this.closed || this.busy.has(row.id) || this.handoffs.has(row.id)) return;
    this.busy.add(row.id);
    try {
      const valid = () => !this.closed && this.options.current(row.scope)
        && (!row.following || this.options.followEnabled?.(row.scope) !== false);
      if (!valid()) {
        const stream = this.streams.get(row.id);
        let retired = true;
        if (row.checkpoint?.messageId || stream?.checkpoint().messageId)
          retired = await this.stream(row).finalize("跟随已关闭或原绑定、准入已改变，已停止同步终端；没有停止远端任务。", false, { existingOnly: true, outcome: "detached" });
        if (!this.closed && retired) this.options.journal.remove(row.id);
        if (!retired) return;
        await stream?.suspend(); this.streams.delete(row.id); return;
      }
      // A passive subscription owns no task/input receipt. Keep idle baseline
      // quiet and share presentation with any current input observation.
      if (row.following && !row.checkpoint?.terminal) {
        const actual = await this.options.inspect(row.scope); if (!valid()) return;
        try { assertSameReadTarget(row.target, actual); }
        catch {
          if (!row.checkpoint?.messageId || await this.stream(row).finalize("终端程序或目录已改变，已停止跟随原目标。请重新核对绑定。", false, { existingOnly: true, outcome: "detached" })) {
            this.options.journal.remove(row.id); await this.streams.get(row.id)?.suspend(); this.streams.delete(row.id);
          }
          return;
        }
        const inputOwnsPresentation = this.options.journal.list().some(other => !other.following && this.sameBinding(other.scope, row.scope));
        if (inputOwnsPresentation) {
          if (row.following.active && (row.checkpoint?.messageId || row.checkpoint?.creationAttempted || row.checkpoint?.bootstrap)) {
            if (!await this.stream(row).finalize("新的输入由对应结果卡继续展示；此跟随订阅仍保留。", false, { existingOnly: true, outcome: "continued" })) return;
          }
          await this.resetFollow(row.id, actual); return;
        }
        if (!row.following.active) {
          const sequenceChanged = row.lastSequence !== undefined && actual.observationSequence !== undefined
            && actual.observationSequence > row.lastSequence;
          const changed = row.lastState !== actual.state;
          const active = (actual.state === "working" || actual.state === "blocked") && (changed || sequenceChanged)
            || row.lastState !== undefined && changed && (actual.state === "error" || actual.state === "exited")
            || sequenceChanged && (actual.state === "idle" || actual.state === "done");
          row = { ...row, following: { active }, lastSyncedAt: this.now() };
          if (!active) {
            this.options.journal.put({ ...row, lastState: actual.state, lastSequence: actual.observationSequence }); return;
          }
          row.startedAt = this.now(); row.seenWorking = true;
          this.options.journal.put(row);
        }
      }
      const stream = this.stream(row);
      if (row.checkpoint?.terminal) {
        if (await stream.finalize(row.checkpoint.terminal.text, row.checkpoint.terminal.error, { outcome: row.checkpoint.terminal.outcome }))
          await this.finish(row.id);
        return;
      }
      // A read of the original Connector journal can repair a lost Gateway ack.
      // Absence remains unknown, and a legacy row without a digest cannot guess
      // a matching operation. No retry or send method is available here.
      if ((row.phase === "writing" || row.phase === "unknown") && row.recovery && this.options.receipt) {
        const proof = await this.options.receipt(row); if (!valid()) return;
        if (proof) {
          this.validateHandoff(row, proof);
          this.options.recovered?.(row, proof);
          this.handed(row.id, proof);
          row = this.options.journal.get(row.id)!;
        }
      }
      if (row.phase === "not-sent") {
        if (await stream.finalize("输入未发送到终端，原任务未改变。", false, { outcome: "input-not-sent" })) await this.finish(row.id);
        return;
      }
      const actual = await this.options.inspect(row.scope); if (!valid()) return;
      try { assertSameReadTarget(row.target, actual); }
      catch {
        if (await stream.finalize("终端程序或目录已改变，已停止同步原目标；没有向新目标发送输入。", false, { outcome: "detached" })) await this.finish(row.id);
        return;
      }
      const output = await this.options.read(row.scope); if (!valid()) return;
      if (output.ref.endpointId !== row.target.ref.endpointId || output.ref.id !== row.target.ref.id) throw Error("Runtime screen identity changed");
      // read() fences its own snapshot, but its first check may already see a
      // replacement created after our inspect. Fence against the saved target
      // again before publishing any bytes from that snapshot.
      const after = await this.options.inspect(row.scope); if (!valid()) return;
      assertSameReadTarget(row.target, after);
      const latest = this.options.journal.get(row.id)!;
      latest.seenWorking ||= after.state === "working";
      // Legacy display hashes described heuristic stages. A terminal window
      // replaces them; keep execution and delivery identities unchanged.
      delete latest.display;
      latest.lastState = after.state; latest.lastSequence = after.observationSequence; latest.lastSyncedAt = this.now(); this.options.journal.put(latest);
      actual.state = after.state;
      const idle = actual.state === "idle" || actual.state === "done";
      const status = actual.state === "working" ? "终端报告正在运行" : actual.state === "blocked" ? "终端正在等待人工处理，请在 Herdr 中查看"
        : actual.state === "idle" || actual.state === "done" ? "终端当前空闲" : actual.state === "exited" ? "终端进程已退出" : actual.state === "error" ? "终端报告错误" : "终端执行状态未确认";
      if (this.options.progressEnabled?.(row.scope) !== false) {
        await stream.setActivity(actual.state === "blocked" ? "waiting-external" : actual.state === "working" ? "running" : "unconfirmed");
      }
      // A snapshot replaces the same bounded card; no agent-specific parsing,
      // phase accumulation or rotation. Even with /stream off retain the tail
      // for the final result, without emitting ordinary per-frame messages.
      await stream.terminalScreen(output.text, this.options.progressEnabled?.(row.scope) !== false);
      if (actual.state === "exited" || actual.state === "error" || idle && (latest.seenWorking || this.now() - row.startedAt >= 20000)) {
        const outcome = actual.state === "exited" ? "terminal-exited" : actual.state === "error" ? "terminal-error" : "terminal-idle";
        const evidence = row.following ? "这是只读跟随观察，未提交输入。"
          : row.phase === "confirmed" ? "输入交接已确认。" : "本次输入交接未确认，未自动重发。";
        const body = `${status}。${evidence}终端状态不代表任务成功验收。`;
        if (await stream.finalize(body, false, { outcome })) await this.finish(row.id);
      }
    } catch {
      this.options.diagnostic?.("runtime-observation-unconfirmed");
      if (!this.closed && this.options.current(row.scope) && this.options.progressEnabled?.(row.scope) !== false)
        await this.streams.get(row.id)?.waitForBackend("终端连接或状态暂未确认；原输入未重发，原任务未停止。").catch(() => {});
    } finally { this.busy.delete(row.id); }
  }
  private async finish(id: string): Promise<void> {
    if (this.closed) return;
    const row = this.options.journal.get(id);
    if (row && !row.following && row.lastState !== undefined && row.lastSyncedAt !== undefined) {
      // The terminal may finish after the passive read but before the input's
      // read in the same tick. Commit the input's verified baseline before
      // retiring its ownership; otherwise the next tick mistakes that same
      // completion sequence for an unseen external run and sends another card.
      for (const follower of this.options.journal.list().filter(other => other.following && this.sameBinding(other.scope, row.scope))) {
        await this.inFlight.get(follower.id);
        if (this.closed) return;
        const saved = this.options.journal.get(follower.id);
        if (!saved?.following || saved.following.active || saved.checkpoint || !this.options.current(saved.scope)
          || (saved.lastSyncedAt ?? 0) > row.lastSyncedAt
          || saved.lastSequence !== undefined && row.lastSequence !== undefined && saved.lastSequence > row.lastSequence) continue;
        try { assertSameReadTarget(saved.target, row.target); } catch { continue; }
        this.options.journal.put({ ...saved, lastState: row.lastState, lastSequence: row.lastSequence, lastSyncedAt: row.lastSyncedAt });
      }
    }
    if (row && !row.following && this.options.notify && !row.notificationAttempted && this.options.current(row.scope)) {
      // Notification APIs have no idempotency key. Preserve the acknowledged
      // result and never repeat an ambiguous @ after a process crash.
      this.options.journal.put({ ...row, notificationAttempted: true });
      try { await this.options.notify(row); } catch { this.options.diagnostic?.("runtime-notification-unconfirmed"); }
    }
    if (row?.following) await this.resetFollow(id);
    else { this.options.journal.remove(id); this.streams.delete(id); }
  }
  private async resetFollow(id: string, actual?: RuntimeResource): Promise<void> {
    const row = this.options.journal.get(id); if (!row?.following) return;
    const { checkpoint: _checkpoint, notificationAttempted: _notification, display: _display, ...rest } = row;
    this.options.journal.put({ ...rest, following: { active: false }, seenWorking: false, startedAt: this.now(),
      ...(actual ? { lastState: actual.state, lastSequence: actual.observationSequence, lastSyncedAt: this.now() } : {}) });
    await this.streams.get(id)?.suspend(); this.streams.delete(id);
  }
  close(): void {
    this.closed = true; clearTimeout(this.timer); this.timer = undefined;
    for (const stream of this.streams.values()) void stream.suspend().catch(() => {});
    this.streams.clear();
    this.handoffs.clear();
  }
}
