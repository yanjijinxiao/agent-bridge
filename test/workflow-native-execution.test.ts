import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiChatService } from "../taskboard/server/ai-chat.mjs";
import { TaskboardDatabase } from "../taskboard/server/database.mjs";
import { WorkflowExecutionService } from "../taskboard/server/workflow-execution.mjs";
import { prepareNativeWorkflowNode } from "../taskboard/server/workflow-native-nodes.mjs";
import { workflowCommands } from "../taskboard/server/workflow-command-nodes.mjs";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { sharedNativeCore, message, tool, until } from "./fixtures/shared-native-core.mjs";

const native = { skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 40_000 };
const actor = { type: "user", id: "test", name: "Test", avatarUrl: null };
async function setup(t: any, respond: any, kind: string, data = {}) {
  const f = await sharedNativeCore(t, respond);
  const state = path.join(f.root, "device.json"), file = path.join(f.root, "workflow.sqlite");
  fs.writeFileSync(state, JSON.stringify({ "local-projects": { selected: { rootPaths: [f.root] } } }));
  let db = new TaskboardDatabase(file);
  db.createProject({ id: "selected", name: "Selected", workspacePath: f.root });
  const issue = db.createTask({ projectId: "selected", title: "Execute workflow", description: "native input", status: "todo", priority: "none", labels: [], actor, assignee: actor, dueDate: null, workflowId: null });
  const nodes = [ { id: "trigger", data: { kind: "issue-trigger" } }, { id: "work", data: { kind, ...data } },
    { id: "write", data: { kind: "issue-update", addComment: true, recordConversation: true } } ]
    .map(n => ({ ...n, type: "workflow", position: { x: 0, y: 0 } }));
  db.saveWorkflowWorkspace("selected", 0, { version: 1, tabs: [{ id: "flow", name: "Native" }], activeWorkflowId: "flow",
    snapshots: { flow: { nodes, flow: { version: 2, root: { items: nodes.map(n => ({ type: "step", nodeId: n.id })) } } } } });
  db.close();
  const clients: any[] = [];
  const open = () => {
    db = new TaskboardDatabase(file);
    const backend = new CodexAppServerGateway({ appServerBackend: f.runner() });
    const ai = new AiChatService({ database: db, nativeBackend: backend, codexStatePath: state, manageTaskboardSkillPath: path.join(f.root, "fixture.md") });
    const workflow = new WorkflowExecutionService({ database: db, aiChat: ai,
      prepareNativeNode: (input: any) => prepareNativeWorkflowNode({ ...input, aiChat: ai, nativeBackend: backend }) });
    let closed = false;
    const client = { db, ai, workflow, async close() { if (closed) return; closed = true;
      workflow.close(); await Promise.allSettled(workflow.active.values()); await ai.close(); await backend.close(); db.close(); } };
    clients.push(client); return client;
  };
  t.after(async () => { for (const c of clients) await c.close(); });
  return { ...f, open, issue, input: { projectId: "selected", workflowId: "flow", version: 1, clientRequestId: randomUUID(), input: { issueId: issue.id } } };
}

test("workflow custom code actually executes on the native core and checks its command receipt", native, async t => {
  const data = { kind: "custom-code", codeRuntime: "shell", codeContent: "printf workflow-native > workflow-result.txt" };
  const command = workflowCommands(data)[0];
  const f = await setup(t, (_body: any, n: number) => n === 1 ? tool("exec_command", { cmd: command }, n)
    : message(JSON.stringify({ ok: true, text: "workflow-native", exitCodes: [0] }), n), data.kind, data);
  const c = f.open(); const run = c.workflow.start(f.input);
  await until(() => c.workflow.get(run.id).status !== "running", 25000);
  const result = c.workflow.get(run.id); assert.equal(result.status, "completed", `${result.error}\n${JSON.stringify(c.db.listAiChatEvents(result.steps.work.threadId))}`);
  assert.equal(fs.readFileSync(path.join(f.root, "workflow-result.txt"), "utf8"), "workflow-native");
  assert.equal(c.db.listComments(f.issue.id).length, 1);
  assert.equal(c.db.getTask(f.issue.id).threadId, result.steps.work.output.nativeThreadId);
  assert.deepEqual(result.steps.work.output.exitCodes, [0]); assert.equal(f.calls.length, 2);
});

test("workflow reconnects the same native node after owner restart and advances the writeback exactly once", native, async t => {
  const release = Promise.withResolvers<void>(); t.after(() => release.resolve());
  const f = await setup(t, async (_body: any, n: number) => { await release.promise; return message("PLAN_AFTER_RESTART", n); }, "basic-planning");
  const first = f.open(); const run = first.workflow.start(f.input);
  await until(() => Boolean(first.workflow.get(run.id).steps.work?.aiRunId && f.calls.length));
  const old = first.workflow.get(run.id).steps.work;
  const receipt = first.db.getAiChatNativeReceipt(old.aiRunId);
  await first.close(); const second = f.open(); second.workflow.recover(); release.resolve();
  await until(() => second.workflow.get(run.id).status !== "running", 25000);
  const result = second.workflow.get(run.id); assert.equal(result.status, "completed", result.error);
  assert.equal(result.steps.work.aiRunId, old.aiRunId);
  assert.equal(second.db.getAiChatNativeReceipt(old.aiRunId).nativeTurnId, receipt.nativeTurnId);
  assert.equal(second.db.listComments(f.issue.id).length, 1);
  assert.equal(second.db.listComments(f.issue.id)[0].body, "PLAN_AFTER_RESTART");
  assert.equal(f.calls.length, 1); second.workflow.start(f.input);
  assert.equal(second.db.listComments(f.issue.id).length, 1);
});
