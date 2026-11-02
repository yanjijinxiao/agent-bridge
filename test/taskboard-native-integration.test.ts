import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AiChatService } from "../taskboard/server/ai-chat.mjs";
import { TaskboardDatabase } from "../taskboard/server/database.mjs";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { sharedNativeCore, message, tool, until } from "./fixtures/shared-native-core.mjs";
import { createIssueAutomation } from "../taskboard/server/issue-automation.mjs";

const native = { skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30_000 };
async function setup(t: any, response?: any) {
  const f = await sharedNativeCore(t, response), cwd = fs.realpathSync(f.root);
  const databasePath = path.join(f.root, "taskboard.sqlite"), codexStatePath = path.join(f.root, "device.json");
  fs.writeFileSync(codexStatePath, JSON.stringify({ "local-projects": { selected: { rootPaths: [cwd] } } }));
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "selected", name: "Selected", workspacePath: cwd });
  const create = (db = database) => {
    const backend = new CodexAppServerGateway({ appServerBackend: f.runner() });
    const service = new AiChatService({ database: db, nativeBackend: backend, codexStatePath,
      manageTaskboardSkillPath: path.join(cwd, "fixture-skill.md") });
    return { service, backend, async close() { await service.close(); await backend.close(); } };
  };
  return { ...f, database, databasePath, create };
}

test("Taskboard uses the shared native core for selected catalogs, settings and public items", native, async t => {
  const f = await setup(t), client = f.create();
  try {
    const catalog = await client.service.getCatalog("selected");
    assert.ok(catalog.models.length > 0);
    const thread = await client.service.createThread({ projectId: "selected", sandbox: "read-only" });
    const run = await client.service.startTurn(thread.id, { message: "one selected native task" });
    await until(() => client.service.getRun(run.id).status !== "running");
    assert.equal(client.service.getRun(run.id).status, "completed");
    const snapshot = client.service.getThreadSnapshot(thread.id);
    assert.equal(snapshot.events.filter((event: any) => event.role === "assistant").length, 1);
    assert.equal(f.calls.length, 1);
    const receipt = f.database.getAiChatNativeReceipt(run.id);
    assert.equal(receipt.phase, "accepted"); assert.ok(receipt.nativeTurnId);
    const peer = await f.rpc("taskboard-settings");
    const resumed = await peer.request("thread/resume", { threadId: receipt.nativeThreadId, excludeTurns: true });
    assert.equal(resumed.approvalPolicy, "on-request");
    assert.equal(resumed.approvalsReviewer, "user");
    assert.equal(resumed.sandbox.type, "workspaceWrite");
  } finally { await client.close(); f.database.close(); }
});

test("Taskboard restart detaches observation, restores the exact accepted run and never repeats input", native, async t => {
  const release = Promise.withResolvers<void>();
  const f = await setup(t, async (_body: any, n: number) => { await release.promise; return message(`DONE_${n}`, n); });
  t.after(() => release.resolve());
  let client = f.create(), db = f.database;
  try {
    const thread = await client.service.createThread({ projectId: "selected" });
    const run = await client.service.startTurn(thread.id, { message: "continue through Gateway restart" });
    await until(() => Boolean(db.getAiChatNativeReceipt(run.id)?.nativeTurnId) && f.calls.length === 1);
    const receipt = db.getAiChatNativeReceipt(run.id);
    await client.close(); db.close();
    db = new TaskboardDatabase(f.databasePath);
    assert.equal(db.getAiChatRun(run.id).status, "running", "native-owned runs are not marked interrupted by reopening SQLite");
    client = f.create(db); client.service.recover();
    release.resolve();
    await until(() => client.service.getRun(run.id).status !== "running");
    assert.equal(client.service.getRun(run.id).status, "completed");
    assert.equal(db.getAiChatNativeReceipt(run.id).nativeTurnId, receipt.nativeTurnId);
    assert.equal(f.calls.length, 1);
    assert.equal(client.service.getThreadSnapshot(thread.id).events.filter((event: any) => event.role === "assistant").length, 1);
  } finally { release.resolve(); await client.close(); db.close(); }
});

test("Taskboard native approval is delivered as original choices and resolved without storing an answer", native, async t => {
  const f = await setup(t, (_body: any, n: number) => n === 1 ? tool("exec_command", {
    cmd: "printf isolated_taskboard_approval", sandbox_permissions: "require_escalated", justification: "Isolated Taskboard protocol verification"
  }, n) : message("APPROVAL_DONE", n));
  const client = f.create();
  try {
    const thread = await client.service.createThread({ projectId: "selected", sandbox: "read-only" });
    const run = await client.service.startTurn(thread.id, { message: "isolated approval roundtrip" });
    await until(() => client.service.getThreadSnapshot(thread.id).interactions.length > 0);
    const request = client.service.getThreadSnapshot(thread.id).interactions[0];
    assert.equal(request.kind, "approval");
    const denial = request.options.find((option: any) => option.id === "decline" || option.id === "cancel");
    assert.ok(denial);
    assert.throws(() => client.service.answerInteraction(thread.id, request.id, "invented-choice"), /原生请求/);
    client.service.answerInteraction(thread.id, request.id, denial.id);
    await until(() => client.service.getRun(run.id).status !== "running");
    assert.equal(client.service.getRun(run.id).status, denial.id === "cancel" ? "interrupted" : "completed");
    assert.equal(client.service.getThreadSnapshot(thread.id).interactions.length, 0);
    assert.equal(f.calls.length, denial.id === "cancel" ? 1 : 2);
    assert.equal(client.service.getThreadSnapshot(thread.id).events.some((event: any) => event.content === denial.id), false);
  } finally { await client.close(); f.database.close(); }
});

for (const disabled of [false, true]) test(`native automatic worker retains its durable claim through Taskboard restart (disabled=${disabled})`, native, async t => {
  const release = Promise.withResolvers<void>();
  const f = await setup(t, async (_body: any, n: number) => { await release.promise; return message(`DONE_${n}`, n); });
  t.after(() => release.resolve());
  let db = f.database, client = f.create(), automation: ReturnType<typeof createIssueAutomation> | undefined;
  const file = path.join(f.root, "event-policy.json");
  const catalog = await client.service.getCatalog("selected"), selected = catalog.models[0];
  const policy = { taskboardProjectId: "selected", codexProjectId: "isolated", projectName: "Selected",
    workspacePath: fs.realpathSync(f.root), skillPath: path.join(f.root, "fixture-skill.md"),
    enabledByUser: true, quotaAware: false, model: selected.slug, reasoningEffort: selected.defaultReasoningEffort };
  const build = () => createIssueAutomation({ database: db, aiChat: client.service, nativeBackend: client.backend,
    automationPoliciesPath: file, logger: { info() {}, error() {} } });
  try {
    fs.writeFileSync(file, JSON.stringify({ selected: policy })); automation = build();
    assert.deepEqual(await automation.trigger({ projectId: "selected" }), { started: true });
    await until(() => Boolean(db.getAutomationRun("selected")?.runId && db.getAiChatNativeReceipt(db.getAutomationRun("selected").runId)?.nativeTurnId));
    const runId = db.getAutomationRun("selected").runId;
    await automation.trigger({ projectId: "selected" });
    await automation.close(); await client.close(); db.close();
    if (disabled) fs.writeFileSync(file, JSON.stringify({ selected: { ...policy, enabledByUser: false } }));
    db = new TaskboardDatabase(f.databasePath); client = f.create(db); automation = build(); automation.recover();
    assert.equal(db.getAutomationRun("selected").runId, runId);
    release.resolve(); await until(() => db.getAiChatRun(runId).status === "completed");
    if (!disabled) await until(() => f.calls.length === 2);
    else await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.calls.length, disabled ? 1 : 2, "accepted input is never repeated; only the durable subsequent event can start another worker");
  } finally { release.resolve(); await automation?.close(); await client.close(); db.close(); }
});

for (const detachUi of [false, true]) test(`one native adapter preserves UI and late IM approval subscribers (detachUi=${detachUi})`, native, async t => {
  const f = await setup(t, (_body: any, n: number) => n === 1 ? tool("exec_command", {
    cmd: "printf isolated_multi_surface", sandbox_permissions: "require_escalated", justification: "Isolated multi-surface approval verification"
  }, n) : message("DONE", n));
  const client = f.create(), decision = Promise.withResolvers<any>(), observed = Promise.withResolvers<any>(), results: string[] = [];
  try {
    const thread = await client.service.createThread({ projectId: "selected", sandbox: "read-only" });
    const run = await client.service.startTurn(thread.id, { message: "one pending native approval" });
    await until(() => client.service.getThreadSnapshot(thread.id).interactions.length > 0);
    const receipt = f.database.getAiChatNativeReceipt(run.id), peer = await f.rpc("multi_surface");
    await peer.request("thread/resume", { threadId: receipt.nativeThreadId, excludeTurns: true });
    await client.backend.observeThreadInteractions(receipt.nativeThreadId, "local", {
      async onApproval(envelope) { observed.resolve(envelope); return decision.promise; },
      onResult(_envelope, result) { results.push(result); }
    });
    const envelope = await observed.promise;
    assert.equal(envelope.request.turnId, receipt.nativeTurnId);
    assert.ok(client.backend.interactionSubscriptionReady(receipt.nativeThreadId, "local"));
    if (detachUi) await client.service.close();
    assert.ok(client.backend.interactionSubscriptionReady(receipt.nativeThreadId, "local"), "detaching UI must retain the IM native subscription");
    const denial = envelope.request.options.find((option: any) => option.id === "cancel" || option.id === "decline");
    decision.resolve(denial.id);
    await until(() => results.includes("confirmed"));
    await until(() => peer.events.some(event => event.method === "turn/completed"));
    if (!detachUi) {
      await until(() => client.service.getRun(run.id).status !== "running");
      assert.equal(client.service.getThreadSnapshot(thread.id).interactions.length, 0);
    }
    assert.equal(f.calls.length, denial.id === "cancel" ? 1 : 2);
    assert.equal(results.filter(result => result === "confirmed").length, 1);
  } finally { decision.resolve(undefined); await client.close(); f.database.close(); }
});
