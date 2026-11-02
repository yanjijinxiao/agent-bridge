import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskboardServer } from "../server/index.mjs";
import { fakeNativeCore } from "./helpers/native-backend.mjs";
import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

for (const backend of ["sqlite", "d1"]) test(`Task mutations retain atomic idempotency receipts (${backend})`, async t => {
  let request, projectId, database;
  if (backend === "d1") {
    const cloud = await createCloudWorkerHarness(); t.after(() => cloud.dispose());
    database = cloud.db;
    request = (pathname, { body, actor = "Alice", ...options } = {}) => cloud.request(pathname,
      { ...options, actorName: actor, ...(body ? { json: body } : {}) });
    projectId = "receipts";
    assert.equal((await request("/api/projects", { method: "POST", body: { id: projectId, name: "Receipts" } })).response.status, 201);
  } else {
    const directory = await mkdtemp(path.join(os.tmpdir(), "task-submissions-"));
    const app = createTaskboardServer({ dataDirectory: directory, nativeBackend: fakeNativeCore().client() });
    const address = await app.listen({ port: 0 });
    t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    database = app.database.database;
    request = async (pathname, { body, actor = "alice", ...options } = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, { ...options,
        headers: { "content-type": "application/json", "x-taskboard-user-id": actor.toLowerCase(), "x-taskboard-user-name": actor },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { response, body: await response.json() };
    };
    projectId = "local";
  }
  const id = digit => digit.repeat(64);
  const create = { projectId, title: "One task", status: "todo", threadId: "thread", clientRequestId: id("a") };
  const results = await Promise.all(Array.from({ length: 6 }, () => request("/api/tasks", { method: "POST", body: create })));
  for (const result of results) assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal(new Set(results.map(result => result.body.task.id)).size, 1, "concurrent retries create one task");
  const task = results[0].body.task;
  assert.equal((await request(`/api/tasks?projectId=${projectId}`)).body.tasks.length, 1);
  assert.equal((await request("/api/tasks", { method: "POST", body: { ...create, title: "Changed" } })).response.status, 409);
  assert.equal((await request("/api/tasks", { method: "POST", actor: "Bob", body: create })).response.status, 409);

  const commentBody = { body: "Progress", threadId: "thread", clientRequestId: id("b") };
  const comments = await Promise.all(Array.from({ length: 3 }, () => request(`/api/tasks/${task.id}/comments`, { method: "POST", body: commentBody })));
  for (const result of comments) assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal(new Set(comments.map(result => result.body.comment.id)).size, 1);

  const transitionBody = { status: "in_progress", version: 1, threadId: "thread", body: "Start evidence", clientRequestId: id("c") };
  const transition = await request(`/api/tasks/${task.id}/transition`, { method: "POST", body: transitionBody });
  assert.equal(transition.response.status, 200, JSON.stringify(transition.body));
  const replay = await request(`/api/tasks/${task.id}/transition`, { method: "POST", body: transitionBody });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.task.version, 2);
  assert.equal(replay.body.comment.id, transition.body.comment.id);
  assert.equal((await request(`/api/tasks/${task.id}/comments`)).body.comments.length, 2);

  const moveBody = { status: "blocked", version: 2, threadId: "thread", clientRequestId: id("d") };
  const moves = await Promise.all(Array.from({ length: 3 }, () => request(`/api/tasks/${task.id}/move`, { method: "POST", body: moveBody })));
  // A racing caller may observe a version conflict before the winning batch's
  // receipt is visible. Retrying that same identity must then recover it.
  for (const result of moves) assert.ok([200, 409].includes(result.response.status), JSON.stringify(result.body));
  const moved = await request(`/api/tasks/${task.id}/move`, { method: "POST", body: moveBody });
  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.task.version, 3);

  const rejectedBody = { status: "done", version: 1, clientRequestId: id("e") };
  assert.equal((await request(`/api/tasks/${task.id}/move`, { method: "POST", body: rejectedBody })).response.status, 409);
  assert.equal((await request(`/api/task-submissions/${id("e")}`)).body.submission, null, "failed CAS cannot claim acceptance");

  // Retained receipts are independent of task/comment lifetime.
  if (backend === "sqlite") database.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
  else await database.prepare("DELETE FROM tasks WHERE id = ?").bind(task.id).run();
  assert.equal((await request(`/api/task-submissions/${id("a")}`)).body.submission.taskId, task.id);
  const removed = await request("/api/tasks", { method: "POST", body: create });
  assert.equal(removed.response.status, 409);
  assert.equal(removed.body.error.code, "SUBMISSION_TARGET_REMOVED");
  assert.equal((await request(`/api/tasks?projectId=${projectId}`)).body.tasks.length, 0);
});

test("receipt persistence failure rolls back the business mutation and migration preserves accepted identities", async t => {
  const { createCloudMigrationBundle, createCloudD1ImportPlan, writeCloudMigrationBundle, readCloudMigrationBundle } = await import("../scripts/migrate-to-cloud.mjs");
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-receipt-transaction-"));
  const app = createTaskboardServer({ dataDirectory: directory, nativeBackend: fakeNativeCore().client() });
  const address = await app.listen({ port: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const raw = app.database.database;
  const create = { title: "Atomic", clientRequestId: "f".repeat(64) };
  const send = async () => { const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create) }); return { response, body: await response.json() }; };
  raw.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON task_submissions BEGIN SELECT RAISE(FAIL, 'receipt disk fault'); END;");
  assert.equal((await send()).response.status, 500);
  assert.equal(app.database.listTasks({}).length, 0, "receipt failure must undo task and number allocation");
  raw.exec("DROP TRIGGER fail_receipt;");
  const accepted = await send(); assert.equal(accepted.response.status, 201);
  assert.match(accepted.body.task.identifier, /-1$/);
  const bundle = await createCloudMigrationBundle({ databasePath: app.options.databasePath, attachmentsDirectory: app.options.attachmentsDirectory });
  assert.equal(bundle.tables.task_submissions.length, 1);
  const output = path.join(directory, "migration"); await writeCloudMigrationBundle(bundle, output);
  const restored = await readCloudMigrationBundle(output);
  assert.deepEqual(restored.tables.task_submissions, bundle.tables.task_submissions.map(row => ({ ...row })));
  const cloud = await createCloudWorkerHarness(); t.after(() => cloud.dispose());
  await cloud.db.batch(createCloudD1ImportPlan(restored.tables).map(item => cloud.db.prepare(item.sql).bind(item.json)));
  const receipt = await cloud.request(`/api/task-submissions/${create.clientRequestId}`, { actorName: "Alice" });
  assert.equal(receipt.body.submission.taskId, accepted.body.task.id);
});
