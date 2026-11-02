import type { TaskboardSubmission } from "./taskboard-channel-command.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readJsonObjectFile, writeJsonFile } from "../state/json-store.js";

const receiptSchema = z.object({ projectId: z.string(), payloadHash: z.string(), createdAt: z.number(),
  status: z.enum(["pending", "workflow", "completed"]) });
type Receipt = z.infer<typeof receiptSchema>;
type ProcessedSubmission = Receipt & { owning: boolean; completion: SubmissionCompletion };

export type TaskboardSubmissionReservation =
  | { readonly kind: "owner"; readonly operationId?: string; readonly recovering: boolean;
      readonly finish: (success: boolean, options?: { nativeNotSubmitted: true }) => void; readonly beginWorkflow: () => void }
  | { readonly kind: "duplicate"; readonly completion: Promise<boolean> }
  | { readonly kind: "workflow-unknown" }
  | { readonly kind: "mismatch" };

/** The journal protects the IM/native handoff; Taskboard's atomic receipts are
 * authoritative for data writes. A failed HTTP request never means unwritten. */
export class TaskboardSubmissionDeduplicator {
  private readonly processed = new Map<string, ProcessedSubmission>();
  constructor(private readonly filePath?: string) {
    if (!filePath) return;
    const saved = z.object({ version: z.literal(1), receipts: z.record(z.string().regex(/^[a-f0-9]{64}$/), receiptSchema) })
      .parse(readJsonObjectFile(filePath, { version: 1, receipts: {} }));
    for (const [key, receipt] of Object.entries(saved.receipts)) {
      const completion = new SubmissionCompletion();
      completion.resolve(receipt.status === "completed");
      this.processed.set(key, { ...receipt, owning: false, completion });
    }
  }

  reserve(requestId: string | undefined, projectId: string, submission: TaskboardSubmission, scope = ""): TaskboardSubmissionReservation {
    if (!requestId) return { kind: "owner", recovering: false, finish() {}, beginWorkflow() {} };
    const key = hash(JSON.stringify([scope, requestId]));
    const payloadHash = hash(JSON.stringify(Object.entries(submission)
      .filter(([name]) => name !== "request_id").sort(([a], [b]) => a.localeCompare(b))));
    const existing = this.processed.get(key);
    if (existing) {
      if (existing.projectId !== projectId || existing.payloadHash !== payloadHash) return { kind: "mismatch" };
      if (existing.owning || existing.status === "completed") return { kind: "duplicate", completion: existing.completion.promise };
      if (existing.status === "workflow") return { kind: "workflow-unknown" };
    }
    const entry: ProcessedSubmission = { projectId, payloadHash, createdAt: existing?.createdAt ?? Date.now(),
      status: "pending", owning: true, completion: new SubmissionCompletion() };
    this.processed.set(key, entry);
    // Persist before any business request or native submission can start.
    try { this.persist(); } catch (error) {
      if (existing) this.processed.set(key, existing); else this.processed.delete(key);
      throw error;
    }
    return { kind: "owner", operationId: key, recovering: Boolean(existing), beginWorkflow: () => {
      entry.status = "workflow"; this.persist();
    }, finish: (success, options) => {
      if (this.processed.get(key) !== entry) return;
      // Retain an uncertain workflow handoff; never restart it by creating a task.
      if (success) entry.status = "completed";
      else if (options?.nativeNotSubmitted) entry.status = "pending";
      entry.owning = false;
      try { this.persist(); } finally { entry.completion.resolve(success); }
    } };
  }

  private persist(): void {
    if (!this.filePath) return;
    const receipts = Object.fromEntries([...this.processed].map(([key, entry]) => [key,
      { projectId: entry.projectId, payloadHash: entry.payloadHash, createdAt: entry.createdAt, status: entry.status }]));
    writeJsonFile(this.filePath, { version: 1, receipts }, { durable: true });
  }
}

class SubmissionCompletion {
  private resolver?: (success: boolean) => void;
  readonly promise = new Promise<boolean>((resolve) => { this.resolver = resolve; });
  resolve(success: boolean): void { const resolve = this.resolver; this.resolver = undefined; resolve?.(success); }
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
