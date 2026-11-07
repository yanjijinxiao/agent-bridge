import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { RuntimeError, type AgentRuntimeAdapter, type ResourceRef } from "./contracts.js";
import { runtimeRefSchema, runtimeResourceSchema } from "./protocol.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { RuntimeSource } from "./handoff.js";
import { RuntimeWriteGate } from "./write-gate.js";

const sourceId = z.string().min(1).max(512);
const title = z.string().trim().min(1).max(120).refine(s => !/[\x00-\x1f]/.test(s));
export const runtimeLifecycleSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), cwd: z.string().min(1).max(4096).refine(s => path.isAbsolute(s) && !s.includes("\0")),
    title, program: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/), args: z.array(z.string().max(8192).refine(s => !s.includes("\0"))).max(100),
    projectId: sourceId.optional(), clientUserMessageId: sourceId }).strict(),
  z.object({ action: z.literal("rename"), threadId: sourceId, target: runtimeResourceSchema, title, clientUserMessageId: sourceId }).strict(),
  z.object({ action: z.literal("close"), threadId: sourceId, target: runtimeResourceSchema, clientUserMessageId: sourceId }).strict()
]);
export type RuntimeLifecycleAction = z.infer<typeof runtimeLifecycleSchema>;
export type RuntimeLifecycleInput = RuntimeLifecycleAction & { assertCurrent: () => void };
const resultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["created", "renamed"]), resource: runtimeResourceSchema }).strict(),
  z.object({ kind: z.literal("closed"), ref: runtimeRefSchema, scope: z.enum(["terminal-process", "pane"]) }).strict()
]);
export const runtimeLifecycleRecordSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.enum(["create", "rename", "close"]), phase: z.enum(["writing", "confirmed", "partial", "not-sent", "unknown"]),
  created: runtimeRefSchema.optional(), result: resultSchema.optional()
}).strict().refine(r => (r.phase === "confirmed") === !!r.result)
  .refine(r => !r.created || r.action === "create")
  .refine(r => r.phase !== "partial" || !!r.created)
  .refine(r => !r.result || r.result.kind === ({ create: "created", rename: "renamed", close: "closed" })[r.action])
  .refine(r => !r.created || !r.result || r.result.kind !== "created"
    || JSON.stringify(r.created) === JSON.stringify(r.result.resource.ref));
export type RuntimeLifecycleRecord = z.infer<typeof runtimeLifecycleRecordSchema>;
const journalSchema = z.object({ version: z.literal(1), records: z.record(z.string(), runtimeLifecycleRecordSchema) }).strict();
const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Parser canonicalizes property order. No raw argv, directory or command is
 * retained as an executable replay plan. */
export const lifecycleFingerprint = (input: RuntimeLifecycleAction) => hash(runtimeLifecycleSchema.parse(input));

/** Connector process lock owns this file. Each remote write is preceded by
 * durable intent; intermediate topology is saved synchronously before launch.
 * All repeated sources, including known failures, are read-only receipts. */
export class RuntimeLifecycleCoordinator {
  private data: z.infer<typeof journalSchema>;
  constructor(private readonly adapter: AgentRuntimeAdapter, private readonly file: string, private readonly gate = new RuntimeWriteGate()) {
    this.data = journalSchema.parse(readJsonFile(file, { version: 1, records: {} }));
  }
  private save(key: string, row: RuntimeLifecycleRecord) {
    const records = { ...this.data.records, [key]: runtimeLifecycleRecordSchema.parse(row) };
    const next = { version: 1 as const, records };
    writeJsonFile(this.file, next, { durable: true }); this.data = next;
  }
  async execute(raw: RuntimeLifecycleAction, source: RuntimeSource, guard: () => void,
    prepareWrite?: () => Promise<void>): Promise<RuntimeLifecycleRecord> {
    const input = runtimeLifecycleSchema.parse(raw);
    for (const value of [source.principal, source.operationId, source.sourceId])
      if (!value || value.length > 1000) throw new RuntimeError("scope", "生命周期操作缺少来源身份");
    guard();
    const key = hash([source.principal, source.operationId, source.sourceId]);
    const fingerprint = lifecycleFingerprint(input), old = this.data.records[key];
    if (old) {
      if (old.fingerprint !== fingerprint) throw new RuntimeError("scope", "原来源对应另一项生命周期操作");
      return structuredClone(old.phase === "writing" ? { ...old, phase: "unknown" } : old);
    }
    const release = this.gate.acquire(input.action === "create" ? input.projectId ?? input.cwd : input.target.ref);
    let row: RuntimeLifecycleRecord = { fingerprint, action: input.action, phase: "writing" };
    let crossed = false;
    const assertCurrent = () => {
      const result: unknown = guard();
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        throw new RuntimeError("scope", "生命周期最终核验必须同步完成");
      }
      crossed = true;
    };
    try {
      try { this.save(key, row); }
      catch { throw new RuntimeError("transport", "生命周期意图无法保存，未写入运行接口"); }
      try {
        if (input.action === "create") {
          if (!this.adapter.create) throw new RuntimeError("unsupported", "运行接口没有新建资源能力");
          const resource = await this.adapter.create({ ...input, assertCurrent, prepareWrite, onCreated: (ref: ResourceRef) => {
            row = { ...row, created: runtimeRefSchema.parse(ref) }; this.save(key, row);
          } });
          row = { ...row, phase: "confirmed", result: { kind: "created", resource } };
        } else if (input.action === "rename") {
          if (!this.adapter.rename) throw new RuntimeError("unsupported", "运行接口没有资源命名能力");
          const resource = await this.adapter.rename({ target: input.target, title: input.title, assertCurrent, prepareWrite });
          if (JSON.stringify(resource.ref) !== JSON.stringify(input.target.ref)) throw new RuntimeError("changed", "命名回执来自其他资源", "unknown");
          row = { ...row, phase: "confirmed", result: { kind: "renamed", resource } };
        } else {
          if (!this.adapter.closeResource) throw new RuntimeError("unsupported", "运行接口没有资源关闭能力");
          const result = await this.adapter.closeResource({ target: input.target, assertCurrent, prepareWrite });
          if (JSON.stringify(result.ref) !== JSON.stringify(input.target.ref)) throw new RuntimeError("changed", "关闭回执来自其他资源", "unknown");
          row = { ...row, phase: "confirmed", result };
        }
        row = runtimeLifecycleRecordSchema.parse(row);
      } catch (error) {
        row = { fingerprint, action: input.action, created: row.created,
          phase: row.created && error instanceof RuntimeError && error.submission === "not-sent" ? "partial"
            : !crossed && error instanceof RuntimeError && error.submission === "not-sent" ? "not-sent" : "unknown" };
      }
      try { this.save(key, row); }
      catch { throw new RuntimeError("transport", "生命周期回执无法保存，禁止重放操作", "unknown"); }
      return structuredClone(row);
    } finally { release(); }
  }
}
