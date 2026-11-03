import assert from "node:assert/strict";
import test from "node:test";
import { importCloudMigrationBundle, verifyCloudMigrationBundle, createCloudBindingMigrationAdapters, writeCloudMigrationBundle, readCloudMigrationBundle } from "../scripts/migrate-to-cloud.mjs";
import { createWranglerCloudAdapters } from "../scripts/wrangler-cloud-adapter.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const receipt = { id: "receipt-one", fingerprint: "exact-input-hash", task_id: "deleted-task", comment_id: null, created_at: "2026-11-03T00:00:00Z" };
function bundle(receipts = [receipt]) {
  return { schemaVersion: 1, tables: { projects: [], tasks: [], comments: [], task_relations: [], attachments: [], workflow_workspaces: [], task_submissions: receipts }, counts: { byProject: {} }, attachments: [] };
}
function adapters(rows) {
  return { d1: { async countByProject() { return {}; }, async readTaskSubmissions() { return rows; } }, r2: { async head() { throw new Error("no attachments expected"); } } };
}
for (const [name, rows] of [
  ["missing", []], ["changed fingerprint", [{ ...receipt, fingerprint: "different" }]],
  ["changed target", [{ ...receipt, task_id: "other-task" }]], ["extra", [receipt, { ...receipt, id: "extra" }]],
]) test(`matching business counts cannot hide ${name} submission receipts`, async () => {
  await assert.rejects(verifyCloudMigrationBundle(bundle(), adapters(rows)), /submission.*mismatch/i);
});
test("matching tombstone receipts verify without replaying any write", async () => {
  const result = await verifyCloudMigrationBundle(bundle(), adapters([receipt]));
  assert.equal(result.submissions.verified, 1);
});
test("receipt order is irrelevant but every full identity must match", async () => {
  const other = { ...receipt, id: "receipt-two" };
  assert.equal((await verifyCloudMigrationBundle(bundle([receipt, other]), adapters([other, receipt]))).submissions.verified, 2);
  await assert.rejects(verifyCloudMigrationBundle(bundle(), adapters(undefined)), /submission.*mismatch/i);
});
test("a new bundle retains an empty receipt-table contract through its manifest", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-empty-receipts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "bundle"); await writeCloudMigrationBundle(bundle([]), directory);
  const restored = await readCloudMigrationBundle(directory);
  assert.deepEqual(restored.tables.task_submissions, []);
  await assert.rejects(verifyCloudMigrationBundle(restored, adapters([receipt])), /submission.*mismatch/i);
});
test("a receipt-bearing bundle fails before import when its adapter cannot verify receipts", async () => {
  let imports = 0;
  const adapter = adapters([]); delete adapter.d1.readTaskSubmissions;
  adapter.d1.importTables = async () => { imports++; };
  await assert.rejects(importCloudMigrationBundle(bundle(), adapter), /readTaskSubmissions/);
  assert.equal(imports, 0);
});
test("an import with matching counts but missing receipts cannot report success", async () => {
  let imports = 0;
  const adapter = adapters([]); adapter.d1.importTables = async () => { imports++; };
  await assert.rejects(importCloudMigrationBundle(bundle(), adapter), /submission.*mismatch/i);
  assert.equal(imports, 1, "verification does not retry the import");
});
test("receipt-only existing targets are rejected before import", async () => {
  let imports = 0;
  const adapter = adapters([receipt]); adapter.d1.importTables = async () => { imports++; };
  await assert.rejects(importCloudMigrationBundle(bundle(), adapter), /not empty/);
  assert.equal(imports, 0);
});
test("legacy bundles retain their explicitly narrower verification contract", async () => {
  const legacy = bundle(); delete legacy.tables.task_submissions;
  const adapter = adapters([]); delete adapter.d1.readTaskSubmissions;
  assert.equal((await verifyCloudMigrationBundle(legacy, adapter)).submissions, undefined);
});
test("binding receipt reads include tombstones using the real SQLite schema", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE task_submissions (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,task_id TEXT NOT NULL,comment_id TEXT,created_at TEXT NOT NULL)");
  db.prepare("INSERT INTO task_submissions VALUES (?,?,?,?,?)").run(...Object.values(receipt));
  const binding = { prepare(sql) { return { async all() { return { results: db.prepare(sql).all() }; } }; } };
  const adapter = createCloudBindingMigrationAdapters({ d1: binding, r2: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.d1.readTaskSubmissions())), [receipt]);
});
test("Wrangler verifies the same receipt columns through a read-only command", async () => {
  const calls = [];
  const adapter = createWranglerCloudAdapters({ remote: false, persistTo: "/tmp/unused-fixture-path", environment: {},
    async runCommand(_bin, args) { calls.push(args); return { stdout: JSON.stringify([{ results: [receipt] }]) }; } });
  try {
    assert.deepEqual(await adapter.d1.readTaskSubmissions(), [receipt]);
    assert.equal(calls.length, 1); assert.ok(calls[0].includes("--local"));
    assert.match(calls[0][calls[0].indexOf("--command") + 1], /SELECT id, fingerprint, task_id, comment_id, created_at FROM task_submissions/);
  } finally { await adapter.cleanup(); }
});
