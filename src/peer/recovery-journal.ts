import path from "node:path";
import { z } from "zod";
import type { CodexBridgeBackend } from "../codex/backend.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";

const row = z.object({ threadId: z.string(), failedTurnId: z.string(), archiveConfirmed: z.boolean(), restored: z.boolean() }).strict();
type Restore = z.infer<typeof row>;
/** Device-local rollback obligation survives loss of the Gateway or Connector.
 * Restoring persistence never grants permission to resume inference. */
export class PeerRecoveryJournal {
  private readonly file: string;
  private rows: Restore[];
  constructor(stateDir: string) {
    this.file = path.join(stateDir, "recovery-restores.json");
    this.rows = z.array(row).parse(readJsonFile(this.file, []));
  }
  get(threadId: string, failedTurnId: string): Restore | undefined {
    return this.rows.find(r => r.threadId === threadId && r.failedTurnId === failedTurnId);
  }
  start(threadId: string, failedTurnId: string): void {
    const existing = this.rows.find(r => r.threadId === threadId);
    if (existing && existing.failedTurnId !== failedTurnId) throw Error("An earlier native persistence restoration is still pending");
    if (!existing) this.save([...this.rows, { threadId, failedTurnId, archiveConfirmed: false, restored: false }]);
  }
  confirmed(threadId: string): void { this.update(threadId, { archiveConfirmed: true }); }
  restored(threadId: string): void { this.update(threadId, { restored: true }); }
  acknowledged(threadId: string): void { this.save(this.rows.filter(r => r.threadId !== threadId)); }
  private update(threadId: string, change: Partial<Restore>): void {
    this.save(this.rows.map(r => r.threadId === threadId ? { ...r, ...change } : r));
  }
  private save(rows: Restore[]): void { writeJsonFile(this.file, rows, { durable: true }); this.rows = rows; }
  async restorePending(backend: CodexBridgeBackend): Promise<void> {
    for (const pending of this.rows.filter(r => !r.restored)) {
      if (!backend.recoverSystemError) throw Error("Native restoration port unavailable");
      try {
        await backend.recoverSystemError({ threadId: pending.threadId, failedTurnId: pending.failedTurnId,
          assertCurrent: () => { throw Error("Startup rollback cannot continue execution"); },
          lifecycle: { restoring: true, archiveConfirmed: pending.archiveConfirmed,
            beforeArchive: () => { throw Error("Startup rollback cannot archive again"); },
            archived: () => this.confirmed(pending.threadId), restored: () => this.restored(pending.threadId) } });
      } catch (error) { if (!this.get(pending.threadId, pending.failedTurnId)?.restored) throw error; }
      if (!this.get(pending.threadId, pending.failedTurnId)?.restored) throw Error("Native restoration is still unconfirmed");
    }
  }
}
