import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const recordSchema = z.object({ id: z.string(), recipientId: z.string(), threadId: z.string(), hostId: z.string(),
  version: z.string(), createdAt: z.number(), updatedAt: z.number(),
  choice: z.string().optional(), label: z.string().optional(),
  phase: z.enum(["pending", "unconfirmed", "confirmed", "failed", "withdrawn"]) }).strict();
type Record = z.infer<typeof recordSchema>;
const presentationSchema = z.object({ id: z.string(), hostId: z.string(), threadId: z.string(), turnId: z.string(),
  kind: z.literal("approval"), acceptedAt: z.number() }).strict();
type Presentation = z.infer<typeof presentationSchema>;
const noticeSchema = z.object({
  messageId: z.string().optional(),
  sourceKey: z.string().optional(),
  outcome: z.enum(["confirmed", "failed", "withdrawn"]).optional(),
  delivery: z.enum(["ready", "pending", "delivered", "unconfirmed"]),
  attempts: z.number().int().nonnegative(), retryAt: z.number().finite().optional(),
  mentions: z.array(z.object({ userId: z.string(), name: z.string().optional() })).optional(),
}).strict();
export type ApprovalNoticeRecord = z.infer<typeof noticeSchema>;

/** Audit only: no commands, tool arguments, credentials, reusable grants or
 * execution replay. Native Codex/MCP remains the sole permission authority. */
export class ApprovalJournal {
  private records: Record[] = [];
  private presentations: { [approvalId: string]: Presentation } = {};
  private notices: { [approvalId: string]: ApprovalNoticeRecord } = {};
  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      const loaded = z.object({ version: z.literal(1), records: z.array(recordSchema).max(1000),
        presentations: z.record(z.string(), presentationSchema).optional(),
        notices: z.record(z.string(), noticeSchema).optional() }).parse(JSON.parse(fs.readFileSync(file, "utf8")));
      this.records = loaded.records; this.presentations = loaded.presentations ?? {};
      this.notices = loaded.notices ?? {};
    }
  }
  add(input: Omit<Record, "phase" | "updatedAt">): void {
    this.commit([...this.records, { ...input, phase: "pending" as const, updatedAt: Date.now() }].slice(-1000));
  }
  update(id: string, change: Pick<Record, "phase"> & Partial<Pick<Record, "choice" | "label">> & { presentation?: Presentation; notice?: ApprovalNoticeRecord }): void {
    const { presentation, notice, ...audit } = change;
    this.commit(this.records.map(record => record.id === id ? { ...record, ...audit, updatedAt: Date.now() } : record),
      presentation ? { ...this.presentations, [id]: presentation } : this.presentations,
      notice ? { ...this.notices, [id]: notice } : this.notices);
  }
  notice(id: string): ApprovalNoticeRecord | undefined { return this.notices[id] && structuredClone(this.notices[id]); }
  updateNotice(id: string, notice: ApprovalNoticeRecord): void {
    this.commit(this.records, this.presentations, { ...this.notices, [id]: notice });
  }
  snapshot(): Record[] { return structuredClone(this.records); }
  confirmedPresentation(id: string): Presentation | undefined {
    return this.records.some(record => record.id === id && record.phase === "confirmed") && this.presentations[id]
      ? structuredClone(this.presentations[id]) : undefined;
  }
  confirmedPresentations(): Presentation[] {
    return this.records.flatMap(record => record.phase === "confirmed" && this.presentations[record.id]
      ? [structuredClone(this.presentations[record.id])] : []);
  }
  private commit(records: Record[], presentations = this.presentations, notices = this.notices): void {
    const retained = Object.fromEntries(records.flatMap(record => record.phase === "confirmed" && presentations[record.id]
      ? [[record.id, presentations[record.id]]] : []));
    const retainedNotices = Object.fromEntries(records.flatMap(record => notices[record.id] ? [[record.id, notices[record.id]]] : []));
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        // Keep the strict v1 audit rows unchanged for rollback readers. Older
        // readers ignore this optional top-level projection; one atomic write
        // still commits native confirmation and its presentation together.
        fs.writeFileSync(temp, JSON.stringify({ version: 1, records, ...(Object.keys(retained).length ? { presentations: retained } : {}),
          ...(Object.keys(retainedNotices).length ? { notices: retainedNotices } : {}) }), { mode: 0o600 });
        fs.renameSync(temp, this.file);
      } finally { fs.rmSync(temp, { force: true }); }
    }
    this.records = records;
    this.presentations = retained;
    this.notices = retainedNotices;
  }
}
