import { createHash } from "node:crypto";
import { ApiError } from "./database.mjs";
import { parseAiRequestId } from "./ai-chat-submissions.mjs";

/** Run snapshots belong to this device's executor. The shared editable document
 * is copied once; later edits cannot change an accepted execution. */
export class WorkflowRunStore {
  constructor(database) {
    this.sql = database.database;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      record TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  }

  get(id) {
    const row = this.sql.prepare("SELECT record FROM workflow_runs WHERE id = ?").get(id);
    return row ? JSON.parse(row.record) : null;
  }

  list(projectId) {
    const rows = projectId === undefined
      ? this.sql.prepare("SELECT record FROM workflow_runs ORDER BY updated_at DESC").all()
      : this.sql.prepare("SELECT record FROM workflow_runs WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100").all(projectId);
    return rows.map(row => JSON.parse(row.record));
  }

  active() {
    return this.sql.prepare("SELECT record FROM workflow_runs WHERE json_extract(record, '$.status') IN ('running', 'stopping')")
      .all().map(row => JSON.parse(row.record));
  }

  create(input) {
    if (!parseAiRequestId(input.id)) throw new ApiError(400, "INVALID_REQUEST_ID", "clientRequestId is required");
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const timestamp = new Date().toISOString();
    const record = { ...input, status: "running", steps: {}, createdAt: timestamp, updatedAt: timestamp };
    this.sql.prepare("INSERT OR IGNORE INTO workflow_runs(id, project_id, fingerprint, record, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.id, input.projectId, fingerprint, JSON.stringify(record), timestamp);
    const saved = this.sql.prepare("SELECT fingerprint FROM workflow_runs WHERE id = ?").get(input.id);
    if (saved.fingerprint !== fingerprint) throw new ApiError(409, "REQUEST_ID_CONFLICT", "This request id already belongs to another workflow execution");
    return this.get(input.id);
  }

  update(id, mutate) {
    // Synchronous read/mutate/write on the shared connection. No async work or
    // provider calls may be placed inside this transaction.
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const record = this.get(id);
      if (!record) throw new ApiError(404, "WORKFLOW_RUN_NOT_FOUND", "Workflow run does not exist");
      mutate(record);
      record.updatedAt = new Date().toISOString();
      this.sql.prepare("UPDATE workflow_runs SET record = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(record), record.updatedAt, id);
      this.sql.exec("COMMIT");
      return record;
    } catch (error) { this.sql.exec("ROLLBACK"); throw error; }
  }
}
