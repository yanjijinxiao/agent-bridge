import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { TaskboardClient } from "../src/taskboard/client.js";
import { TaskboardSubmissionDeduplicator } from "../src/bridge/taskboard-channel-dedup.js";
// @ts-expect-error Taskboard's JavaScript test adapter has no declaration file.
import { fakeNativeCore } from "../taskboard/test/helpers/native-backend.mjs";
import { createTaskboardServer } from "codex-taskboard/server";

for (const restart of [false, true]) test(`IM task creation recovers a lost committed response without another POST (restart=${restart})`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "im-task-receipt-"));
  let app = createTaskboardServer({ dataDirectory: path.join(root, "backend"), nativeBackend: fakeNativeCore().client() });
  let address = await app.listen({ port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const paths = resolveStatePaths(path.join(root, "gateway"));
  let store = new RuntimeStateStore(paths);
  const project = store.createProject("Project", root); store.activateProject("room", project.id);
  const cards: unknown[] = []; let writes = 0, lost = false;
  const makeService = () => new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["room"] }, stateStore: store,
    taskboard: new TaskboardClient({ baseUrl: `http://127.0.0.1:${address.port}`, fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(input).pathname === "/api/tasks" && init?.method === "POST") {
        writes++; assert.equal(response.status, 201);
        assert.match(JSON.parse(String(init.body)).clientRequestId, /^[a-f0-9]{64}$/);
        if (!lost) { await response.text(); lost = true; throw Error("response lost after commit"); }
      }
      return response;
    } }), weixin: { async sendText() { return { messageId: "text" }; },
      async sendTaskCard(input: { card: unknown }) { cards.push(input.card); return { messageId: "card" }; } } });
  let service = makeService();
  const query = new URLSearchParams({ operation: "create_todo", title: "One task", request_id: "00000000-0000-4000-8000-000000000031" });
  const message = (id: string) => ({ id, senderId: "alice", replyTargetId: "room", text: `/task submit ${query}`, attachments: [], raw: {} });
  await assert.rejects(service.handleMessage(message("first")), /response lost/);
  if (restart) {
    await app.close();
    app = createTaskboardServer({ dataDirectory: path.join(root, "backend"), nativeBackend: fakeNativeCore().client() });
    address = await app.listen({ port: 0 });
    store = new RuntimeStateStore(paths); service = makeService();
  }
  await service.handleMessage(message("retry"));
  assert.equal(writes, 1, "reconciliation reads the original receipt instead of posting another creation");
  assert.equal(app.database.listTasks({ projectId: project.id }).length, 1);
  assert.equal(cards.length, 1);
  await makeService().handleMessage(message("confirmed-retry-after-restart"));
  assert.equal(writes, 1);
});

test("IM journal retains uncertain native starts and rejects identity reuse after restart", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-handoff-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "receipts.json");
  const form = { operation: "create_start" as const, title: "Task", description: "", priority: "none" as const, labels: "", request_id: "request" };
  const initial = new TaskboardSubmissionDeduplicator(file).reserve("request", "project", form, "account/conversation/actor");
  assert.equal(initial.kind, "owner");
  if (initial.kind !== "owner") throw Error("expected owner");
  initial.beginWorkflow();
  const restored = new TaskboardSubmissionDeduplicator(file);
  assert.equal(restored.reserve("request", "project", form, "account/conversation/actor").kind, "workflow-unknown");
  assert.equal(restored.reserve("request", "project", { ...form, title: "Changed" }, "account/conversation/actor").kind, "mismatch");
  assert.equal(restored.reserve("request", "project", form, "another actor").kind, "owner");
});

test("IM journal retries a definitively unsubmitted native start with the same task identity", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-negative-handoff-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "receipts.json");
  const form = { operation: "create_start" as const, title: "Task", description: "", priority: "none" as const, labels: "" };
  const first = new TaskboardSubmissionDeduplicator(file).reserve("id", "project", form);
  if (first.kind !== "owner") throw Error("expected owner");
  first.beginWorkflow(); first.finish(false, { nativeNotSubmitted: true });
  const retry = new TaskboardSubmissionDeduplicator(file).reserve("id", "project", form);
  assert.equal(retry.kind, "owner");
  if (retry.kind !== "owner") throw Error("expected owner");
  assert.equal(retry.operationId, first.operationId); assert.equal(retry.recovering, true);
});

test("IM state mutation with a lost accepted response remains uncertain and recovers without false conflict or repeated evidence", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "im-state-receipt-"));
  const app = createTaskboardServer({ dataDirectory: path.join(root, "backend"), nativeBackend: fakeNativeCore().client() });
  const address = await app.listen({ port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "gateway"))), project = store.createProject("Project", root);
  store.activateProject("room", project.id); const session = store.createSession("room", root, "Task", project.id); store.setSessionThread(session.id, "thread");
  const origin = `http://127.0.0.1:${address.port}`;
  const raw = new TaskboardClient({ baseUrl: origin }); await raw.ensureProjectForWorkspace(project);
  const created = await fetch(`${origin}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, title: "Task", status: "in_progress", threadId: "thread" }) }).then(response => response.json());
  let writes = 0; const cards: any[] = [];
  const service = () => new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["room"] }, stateStore: store,
    taskboard: new TaskboardClient({ baseUrl: origin, fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(input).pathname.endsWith("/transition") && init?.method === "POST") {
        writes++; await response.text(); throw Error("accepted state response lost");
      } return response;
    } }), weixin: { async sendText() { return { messageId: "text" }; }, async sendTaskCard(input: { card: unknown }) { cards.push(input.card); return { messageId: "card" }; } } });
  const query = new URLSearchParams({ operation: "review", identifier: created.task.identifier, version: "1", body: "Evidence",
    request_id: "00000000-0000-4000-8000-000000000032" });
  const message = (id: string) => ({ id, senderId: "alice", replyTargetId: "room", text: `/task submit ${query}`, attachments: [], raw: {} });
  await assert.rejects(service().handleMessage(message("first")), /accepted state response lost/);
  assert.equal(cards.length, 0, "an uncertain accepted mutation cannot be displayed as an unexecuted stale-card conflict");
  await service().handleMessage(message("retry"));
  assert.equal(writes, 1); assert.equal(app.database.getTask(created.task.id).status, "in_review");
  assert.equal(app.database.listComments(created.task.id).length, 1);
});
