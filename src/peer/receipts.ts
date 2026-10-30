import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { PeerError } from "./rpc.js";

const row = z.object({ fingerprint: z.string(), phase: z.enum(["submitting", "accepted", "completed", "not-submitted", "failed"]),
  threadId: z.string(), turnId: z.string().optional(), operation: z.string().optional(), result: z.unknown().optional() });
export type PeerReceipt = z.infer<typeof row>;
/** No executable prompts; intent and native receipts are flushed before ack. */
export class PeerReceipts {
  private rows: Record<string, PeerReceipt>;
  constructor(private readonly file: string) {
    this.rows = z.object({ version: z.literal(1), rows: z.record(z.string(), row) }).parse(readJsonFile(file, { version: 1, rows: {} })).rows;
  }
  get(id: string): PeerReceipt | undefined { const r = this.rows[id]; return r && structuredClone(r); }
  begin(id: string, fingerprint: string, threadId: string, operation?: string): PeerReceipt | undefined {
    const prior = this.get(id);
    if (prior && prior.fingerprint !== fingerprint) throw new PeerError("identity", "The source identity was reused for different input");
    if (prior && prior.phase !== "not-submitted") return prior;
    this.write(id, { fingerprint, phase: "submitting", threadId, ...(operation ? { operation } : {}) }); return undefined;
  }
  created(id: string, threadId: string): void { this.write(id, { ...this.rows[id], phase: "accepted", threadId }); }
  createdThreads(): string[] { return Object.values(this.rows).filter(r => r.operation === "createThread" && ["accepted", "completed"].includes(r.phase)).map(r => r.threadId).slice(-200); }
  accepted(id: string, turnId: string): void { this.write(id, { ...this.rows[id], phase: "accepted", turnId }); }
  complete(id: string, result: unknown): void { this.write(id, { ...this.rows[id], phase: "completed", result }); }
  failed(id: string, notSubmitted: boolean): void { this.write(id, { ...this.rows[id], phase: notSubmitted ? "not-submitted" : "failed" }); }
  private write(id: string, value: PeerReceipt): void {
    const next = { ...this.rows, [id]: value };
    writeJsonFile(this.file, { version: 1, rows: next }, { durable: true }); this.rows = next;
  }
}
