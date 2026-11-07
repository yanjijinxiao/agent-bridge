import crypto from "node:crypto";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { RuntimeError, type AgentRuntimeAdapter, type RuntimeHandoff, type RuntimeWrite } from "./contracts.js";
import { RuntimeWriteGate } from "./write-gate.js";

const refSchema = z.object({ endpointId: z.string().min(1), id: z.string().min(1) }).strict();
const receiptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native-accepted"), ref: refSchema, turnId: z.string().min(1), messageId: z.string().optional() }).strict(),
  z.object({ kind: z.literal("terminal-written"), ref: refSchema, incarnation: z.string().min(1), started: z.boolean().nullable(),
    observationSequence: z.number().int().nonnegative().optional() }).strict()
]);
export const runtimeHandoffRecordSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), ref: refSchema,
  phase: z.enum(["writing", "confirmed", "not-sent", "unknown"]), receipt: receiptSchema.optional()
}).strict().refine(row => (row.phase === "confirmed") === !!row.receipt, "交接阶段与回执不一致")
  .refine(row => !row.receipt || row.ref.endpointId === row.receipt.ref.endpointId && row.ref.id === row.receipt.ref.id, "交接目标与回执不一致");
const rowSchema = runtimeHandoffRecordSchema;
export type RuntimeHandoffRecord = z.infer<typeof rowSchema>;
const journalSchema = z.object({ version: z.literal(1), records: z.record(z.string(), rowSchema) }).strict();

/** Input handoff journal only, not a task queue or completion history. The
 * owning Connector must hold its existing process lock for this stateDir.
 * Prompt text, approval answers and executable retries are never stored here. */
export class RuntimeHandoffJournal {
  private data: z.infer<typeof journalSchema>;
  constructor(private readonly file: string) {
    this.data = journalSchema.parse(readJsonFile(file, { version: 1, records: {} }));
  }
  get(key: string): RuntimeHandoffRecord | undefined {
    const row = this.data.records[key];
    if (!row) return undefined;
    // A crash may occur either side of the socket write. Never convert this to
    // not-sent because no acknowledgement was persisted.
    return structuredClone(row.phase === "writing" ? { ...row, phase: "unknown" as const } : row);
  }
  write(key: string, value: RuntimeHandoffRecord): void {
    const row = rowSchema.parse(value);
    const next = { version: 1 as const, records: { ...this.data.records, [key]: row } };
    writeJsonFile(this.file, next, { durable: true }); this.data = next;
  }
}

export type RuntimeSource = { principal: string; sourceId: string; operationId: string };
export type RuntimeSend = RuntimeWrite & { source: RuntimeSource; text: string };
const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceKey = (source: RuntimeSource) => {
  if (![source.principal, source.sourceId, source.operationId].every(value => typeof value === "string" && value.length > 0 && value.length <= 1000))
    throw new RuntimeError("scope", "交接缺少完整来源身份");
  return hash([source.principal, source.sourceId, source.operationId]);
};
/** Shared digest of the handoff intent; recovery never persists prompt text. */
export function runtimeInputFingerprint(target: RuntimeWrite["target"], text: string): string {
  return hash([target.ref.endpointId, target.ref.id, target.incarnation ?? null, target.cwd ?? null, target.machine ?? null, text]);
}

/** Serializes only handoff, never the remote task's whole lifetime. It uses
 * the same runtime adapter on recovery; get/repeat never calls send again.
 * Admission and source ownership are still checked by the Connector caller. */
export class RuntimeHandoffCoordinator {
  constructor(private readonly adapter: Pick<AgentRuntimeAdapter, "send">, private readonly journal: RuntimeHandoffJournal,
    private readonly gate = new RuntimeWriteGate()) {}
  /** A missing receipt is unknown, never permission to retry. Authorization is
   * checked even for cached evidence and absent IDs to avoid a receipt oracle. */
  lookup(source: RuntimeSource, ref: RuntimeWrite["target"]["ref"], fingerprint: string, assertCurrent: () => void): RuntimeHandoffRecord | null {
    this.checkSource(assertCurrent);
    const prior = this.journal.get(sourceKey(source));
    if (prior && (prior.fingerprint !== fingerprint || prior.ref.endpointId !== ref.endpointId || prior.ref.id !== ref.id))
      throw new RuntimeError("scope", "原交接来源与资源或输入指纹不一致");
    return prior ?? null;
  }
  async sendOnce(input: RuntimeSend): Promise<RuntimeHandoffRecord> {
    const { source, target } = input;
    const key = sourceKey(source);
    const fingerprint = runtimeInputFingerprint(target, input.text);
    const prior = this.journal.get(key);
    // Even cached receipts require current access; a stale source must not use
    // the journal as a side channel after revocation.
    this.checkSource(input.assertCurrent);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new RuntimeError("scope", "同一来源操作被用于不同目标或输入");
      return prior;
    }
    const release = this.gate.acquire(target.ref);
    const initial: RuntimeHandoffRecord = { fingerprint, ref: target.ref, phase: "writing" };
    let crossedWriteBoundary = false;
    try {
      // A disk failure here must prevent any call to the runtime's write API.
      try { this.journal.write(key, initial); }
      catch { throw new RuntimeError("transport", "输入尚未发送：无法保存交接意图"); }
      let receipt: RuntimeHandoff;
      try {
        receipt = receiptSchema.parse(await this.adapter.send({ target, text: input.text, prepareWrite: input.prepareWrite, assertCurrent: () => {
          this.checkSource(input.assertCurrent); crossedWriteBoundary = true;
        } }));
        if (receipt.ref.endpointId !== target.ref.endpointId || receipt.ref.id !== target.ref.id
          || receipt.kind === "terminal-written" && receipt.incarnation !== target.incarnation)
          throw new RuntimeError("changed", "交接回执与原目标不一致", "unknown");
      } catch (error) {
        const phase = error instanceof RuntimeError && error.submission === "not-sent" && !crossedWriteBoundary ? "not-sent" : "unknown";
        const row: RuntimeHandoffRecord = { ...initial, phase };
        try { this.journal.write(key, row); }
        catch { throw new RuntimeError("transport", "交接失败且回执未能保存，禁止自动重发", "unknown"); }
        return row;
      }
      // Persist original evidence even if the source changed during the remote
      // write. Delivery may be retired; that cannot make a sent input unsent.
      const confirmed: RuntimeHandoffRecord = { ...initial, phase: "confirmed", receipt };
      try { this.journal.write(key, confirmed); }
      catch { throw new RuntimeError("transport", "运行接口已回执，但本地记录未能保存，禁止自动重发", "unknown"); }
      return confirmed;
    } finally { release(); }
  }
  private checkSource(guard: () => void): void {
    let value: unknown;
    try { value = guard(); }
    catch { throw new RuntimeError("scope", "原交接来源已失效"); }
    if (value && typeof (value as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(value).catch(() => undefined);
      throw new RuntimeError("not-ready", "交接来源核验必须同步完成");
    }
  }
}
