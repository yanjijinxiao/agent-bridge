import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { TaskboardDatabase } from "../server/database.mjs";
import { WorkflowExecutionService } from "../server/workflow-execution.mjs";

const actor = { type: "user", id: "test", name: "Test", avatarUrl: null };
const node = (id, kind, data = {}) => ({ id, type: "workflow", position: { x: 0, y: 0 }, data: { kind, title: id, ...data } });
const step = nodeId => ({ type: "step", nodeId });
async function fixture(t, extra = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workflow-executor-"));
  const database = new TaskboardDatabase(path.join(dir, "state.sqlite"));
  const issue = database.createTask({ projectId: "local", title: "Original", description: "upstream input", status: "todo", priority: "none", labels: [], actor, assignee: actor, workflowId: null, dueDate: null });
  const service = new WorkflowExecutionService({ database, ...extra });
  t.after(async () => { service.close(); database.close(); await rm(dir, { recursive: true, force: true }); });
  const save = (nodes, items, version = 0) => database.saveWorkflowWorkspace("local", version, { version: 1, tabs: [{ id: "flow", name: "Test" }], activeWorkflowId: "flow", snapshots: { flow: { nodes, flow: { version: 2, root: { items } }, selectedNodeId: null } } });
  const start = (clientRequestId = randomUUID(), version = 1) => service.start({ projectId: "local", workflowId: "flow", version, clientRequestId, input: { issueId: issue.id } });
  return { dir, database, issue, service, save, start, async drain(id) { await service.active.get(id); return service.get(id); } };
}

test("workflow run follows the selected branch, creates an issue and writes the original issue once", async t => {
  const f = await fixture(t);
  f.save([node("trigger", "issue-trigger", { triggerStatus: "todo" }), node("if", "condition", { conditionField: "issue-status", conditionOperator: "equals", conditionValue: "todo" }),
    node("create", "issue-create", { createIssueTitle: "Created on true" }), node("wrong", "issue-create", { createIssueTitle: "Must not exist" }),
    node("update", "issue-update", { changeStatus: true, targetStatus: "in_review", addComment: true, issueTarget: "trigger" })],
    [step("trigger"), { type: "condition", nodeId: "if", branches: { true: { items: [step("create")] }, false: { items: [step("wrong")] } } }, step("update")]);
  const created = f.start(), result = await f.drain(created.id);
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.steps.if.output.branch, true);
  assert.equal(result.steps.wrong, undefined);
  assert.equal(f.database.getTask(f.issue.id).status, "in_review");
  assert.equal(f.database.listComments(f.issue.id).length, 1);
  assert.equal(f.database.listTasks({ projectId: "local" }).length, 2);
  assert.equal(f.start(created.id).id, created.id);
  assert.equal(f.database.listComments(f.issue.id).length, 1);
});

test("workflow business receipt survives losing the node projection and later document edits", async t => {
  const f = await fixture(t);
  const nodes = [node("trigger", "issue-trigger"), node("update", "issue-update", { addComment: true })];
  const items = [step("trigger"), step("update")]; f.save(nodes, items);
  const created = f.start(); const result = await f.drain(created.id); assert.equal(result.status, "completed", result.error);
  f.service.update(created.id, run => { run.status = "running"; run.steps.update.status = "prepared"; delete run.steps.update.output; });
  f.save([nodes[0], node("update", "issue-update", { changeStatus: true, targetStatus: "done" })], items, 1);
  f.service.recover(); await f.drain(created.id);
  assert.equal(f.database.listComments(f.issue.id).length, 1);
  assert.equal(f.database.getTask(f.issue.id).status, "todo");
  assert.equal(f.start(created.id, 1).id, created.id);
  assert.throws(() => f.start(created.id, 2), /another workflow/);
});

test("workflow false branch and invalid node configuration stop before later effects", async t => {
  const f = await fixture(t);
  f.save([node("trigger", "issue-trigger"), node("if", "condition", { conditionField: "issue-priority", conditionOperator: "equals", conditionValue: "urgent" }),
    node("true", "issue-create", { createIssueTitle: "Never" }), node("invalid", "issue-create"), node("later", "issue-create", { createIssueTitle: "Later" })],
    [step("trigger"), { type: "condition", nodeId: "if", branches: { true: { items: [step("true")] }, false: { items: [step("invalid")] } } }, step("later")]);
  const created = f.start(); const result = await f.drain(created.id);
  assert.equal(result.status, "failed"); assert.match(result.error, /title/);
  assert.equal(result.steps.if.output.branch, false); assert.equal(result.steps.later, undefined);
  assert.equal(f.database.listTasks({ projectId: "local" }).length, 1);
});

test("native node resumes the same acknowledged submission after projection loss without a second turn", async t => {
  let submissions = 0, prepared = 0; const receipts = new Map(); let nativeRun;
  const aiChat = { recover() {}, getSubmission(id) { return receipts.get(id) ?? { status: "unknown" }; },
    async createThread() { return { id: "native-thread" }; },
    async startTurn(threadId, input) { submissions++; nativeRun = { id: "native-run", threadId, status: "running" }; receipts.set(input.clientRequestId, { status: "acknowledged", kind: "turn", run: nativeRun }); return nativeRun; },
    getRun() { return nativeRun; } };
  const f = await fixture(t, { aiChat, prepareNativeNode: async () => { prepared++; return { turn: { message: "plan" } }; } });
  f.save([node("trigger", "issue-trigger"), node("plan", "basic-planning"), node("update", "issue-update", { changeStatus: true, targetStatus: "done" })], [step("trigger"), step("plan"), step("update")]);
  const created = f.start(); let result = await f.drain(created.id);
  assert.equal(result.status, "running"); assert.equal(submissions, 1);
  f.service.update(created.id, run => { delete run.steps.plan.aiRunId; delete run.steps.plan.threadId; });
  nativeRun.status = "completed";
  const original = f.database.listAiChatEvents.bind(f.database);
  f.database.listAiChatEvents = id => id === "native-thread" ? [{ role: "assistant", runId: "native-run", content: "planned" }] : original(id);
  f.service.recover(); result = await f.drain(created.id);
  assert.equal(result.status, "completed", result.error); assert.equal(result.steps.plan.output.text, "planned");
  assert.equal(submissions, 1); assert.equal(prepared, 1); assert.equal(f.database.getTask(f.issue.id).status, "done");
});

test("stop waits for the original native receipt and does not mistake a rejected handoff for termination", async t => {
  let nativeRun = { id: "native-run", threadId: "native-thread", status: "running" }, ready = false, interrupts = 0;
  const aiChat = { recover() {}, getSubmission() { return { status: "unknown" }; },
    async createThread() { return { id: "native-thread" }; }, async startTurn() { return nativeRun; },
    getRun() { return nativeRun; }, async interrupt() { interrupts++; if (!ready) throw Error("Native identity pending"); } };
  const f = await fixture(t, { aiChat, prepareNativeNode: async () => ({ turn: { message: "plan" } }) });
  f.save([node("trigger", "issue-trigger"), node("plan", "basic-planning"), node("later", "issue-create", { createIssueTitle: "Must not run" })],
    [step("trigger"), step("plan"), step("later")]);
  const run = f.start(); await f.drain(run.id);
  await f.service.stop(run.id, "local"); let stopped = await f.drain(run.id);
  assert.equal(stopped.status, "stopping"); assert.match(stopped.error, /identity pending/);
  assert.equal(stopped.steps.plan.stopDispatched, undefined);
  ready = true; f.service.recover(); stopped = await f.drain(run.id);
  assert.equal(interrupts, 2); assert.equal(stopped.steps.plan.stopDispatched, true);
  nativeRun.status = "interrupted"; f.service.recover(); stopped = await f.drain(run.id);
  assert.equal(stopped.status, "cancelled"); assert.equal(stopped.steps.later, undefined);
});

test("planned children use saved visual order and a reserved identity cannot corrupt run state", async t => {
  const f = await fixture(t, { aiChat: { recover() {}, getSubmission() { return { status: "unknown" }; },
    async createThread() { return { id: "thread" }; }, async startTurn() { return { id: "run" }; }, getRun() { return { status: "completed" }; } },
    prepareNativeNode: async () => ({ turn: { message: "plan" } }) });
  const children = [Object.assign(node("last", "issue-update", { addComment: true, commentSource: "custom", customComment: "second" }), { parentId: "plan", position: { x: 0, y: 200 } }),
    Object.assign(node("first", "issue-update", { addComment: true, commentSource: "custom", customComment: "first" }), { parentId: "plan", position: { x: 0, y: 100 } })];
  f.save([node("trigger", "issue-trigger"), node("plan", "basic-planning", { acceptsChildren: true }), ...children], [step("trigger"), step("plan")]);
  const created = f.start(); const run = await f.drain(created.id);
  assert.equal(run.status, "completed", run.error);
  assert.deepEqual(f.database.listComments(f.issue.id).map(c => c.body), ["first", "second"]);
  f.save([node("trigger", "issue-trigger"), node("__proto__", "issue-create", { createIssueTitle: "Unsafe identity" })], [step("trigger"), step("__proto__")], 1);
  assert.throws(() => f.start(randomUUID(), 2), /reserved/);
});

test("unsupported artifact action rolls back all changes before task mutation", async t => {
  const f = await fixture(t);
  f.save([node("trigger", "issue-trigger"), node("update", "issue-update", { attachArtifacts: true, changeStatus: true, targetStatus: "done" })], [step("trigger"), step("update")]);
  const run = f.start(); assert.equal((await f.drain(run.id)).status, "failed");
  assert.equal(f.database.getTask(f.issue.id).status, "todo");
});

test("a transient native receipt read does not fail an accepted node or run its successor", async t => {
  let readable = false, submissions = 0;
  const aiChat = { recover() {}, getSubmission() { return { status: "unknown" }; },
    async createThread() { return { id: "thread" }; }, async startTurn() { submissions++; return { id: "run" }; },
    getRun() { if (!readable) throw Error("receipt database temporarily unavailable"); return { status: "completed" }; } };
  const f = await fixture(t, { aiChat, prepareNativeNode: async () => ({ turn: { message: "plan" } }) });
  f.save([node("trigger", "issue-trigger"), node("plan", "basic-planning"), node("later", "issue-update", { changeStatus: true, targetStatus: "done" })],
    [step("trigger"), step("plan"), step("later")]);
  const run = f.start(); let current = await f.drain(run.id);
  assert.equal(current.status, "running"); assert.equal(current.steps.plan.aiRunId, "run");
  assert.equal(current.steps.later, undefined); assert.match(current.error, /temporarily unavailable/);
  readable = true; f.service.recover(); current = await f.drain(run.id);
  assert.equal(current.status, "completed"); assert.equal(submissions, 1);
  assert.equal(f.database.getTask(f.issue.id).status, "done");
});

test("cloud authority refusal cannot write a local shadow issue", async t => {
  const f = await fixture(t, { assertDataAuthority: async () => { throw Error("cloud authority unavailable"); } });
  f.save([node("trigger", "issue-trigger"), node("write", "issue-update", { changeStatus: true, targetStatus: "done" })], [step("trigger"), step("write")]);
  const run = f.start(); const result = await f.drain(run.id);
  assert.equal(result.status, "running"); assert.match(result.error, /cloud authority/);
  assert.deepEqual(result.steps, {}); assert.equal(f.database.getTask(f.issue.id).status, "todo");
});

test("manual input supplements the issue instead of being discarded by the trigger", async t => {
  const f = await fixture(t);
  f.save([node("trigger", "issue-trigger"), node("write", "issue-update", { addComment: true })], [step("trigger"), step("write")]);
  const run = f.service.start({ projectId: "local", workflowId: "flow", version: 1, clientRequestId: randomUUID(), input: { issueId: f.issue.id, text: "additional requirements" } });
  assert.equal((await f.drain(run.id)).status, "completed");
  assert.equal(f.database.listComments(f.issue.id)[0].body, "upstream input\n\nadditional requirements");
});
