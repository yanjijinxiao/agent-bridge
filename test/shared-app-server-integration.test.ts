import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { AccountManager } from "../src/server/account-manager.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths, accountStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { withIDEEntry } from "../src/ide/completion.js";
import { sharedNativeCore, message, tool, until } from "./fixtures/shared-native-core.mjs";
import { CodexMetadataReader } from "../src/codex/metadata-reader.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { defaultConfig } from "../src/state/config.js";

const native = { skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30000 };

test("CAT-03.3: real IM creation persists the native thread before model completion and keeps the native title free of channel instructions", native, async t => {
  const release = Promise.withResolvers<void>(); t.after(() => release.resolve());
  const f = await sharedNativeCore(t, async () => { await release.promise; return message("done"); });
  const gateway = new CodexAppServerGateway({ appServerBackend: f.runner() }); t.after(() => gateway.close());
  const paths = resolveStatePaths(path.join(f.root, "bridge-state")), state = new RuntimeStateStore(paths);
  const session = state.createSession("room", f.root, "Clean user title", undefined, "session", undefined, { standalone: true });
  const service = new BridgeService({ stateStore: state, runner: gateway, config: { ...defaultConfig(f.root), allowedSenderIds: ["actor"], streamReplies: false },
    channel: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText() { return { messageId: "fixture" }; } }) });
  t.after(() => service.suspendUserInputs());
  const pending = service.handleMessage({ id: "create-once", senderId: "actor", replyTargetId: "room", text: "Inspect this project", raw: {} });
  await until(() => f.calls.length === 1);
  const persisted = new RuntimeStateStore(paths).getSession(session.id)!;
  assert.ok(persisted.threadId, "early creation receipt is durable while the model is still blocked");
  const peer = await f.rpc("created_title");
  const { thread } = await peer.request("thread/read", { threadId: persisted.threadId, includeTurns: false });
  assert.equal(thread.name, "Clean user title");
  assert.doesNotMatch(thread.name, /DingTalk|Bridge|gateway-actions|Inspect the saved/);
  release.resolve(); await pending;
  assert.equal(state.getSession(session.id)?.threadId, persisted.threadId);
  assert.equal(f.calls.length, 1);
});

test("NATIVE-04.2: retiring a real read-only connection preserves the same native core PID, accepted turn and input count", native, async t => {
  const release = Promise.withResolvers<void>(); t.after(() => release.resolve());
  const f = await sharedNativeCore(t, async (_body, n) => { if (n === 2) await release.promise; return message(`DONE_${n}`, n); });
  const peer = await f.rpc("metadata_rebuild");
  const { thread } = await peer.request("thread/start", { cwd: f.root });
  await peer.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "initialize", text_elements: [] }] });
  await until(() => peer.events.some(m => m.method === "turn/completed"));
  const accepted = await peer.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "hold once", text_elements: [] }] });
  await until(() => f.calls.length === 2);
  const corePid = (await peer.request("server/diagnostics")).process.id;
  let connections = 0;
  const reader = new CodexMetadataReader(() => {
    const runner = f.runner({ metadataOnly: true }), first = ++connections === 1;
    return { close: () => runner.close(), listProjects: () => runner.listProjects(), async inspectThread(id, observation) {
      const state = await runner.inspectThread(id, observation);
      if (first) { runner.close(); throw new CodexCommunicationError("preflight", "thread/read", id, undefined, Error("observer connection closed")); }
      return state;
    } };
  }); t.after(() => reader.close());
  const observed = await reader.inspect(thread.id, "local", { includeTurns: false, timeoutMs: 3000 });
  assert.equal(connections, 2); assert.equal(observed.runtimeStatus, "active");
  const current = await peer.request("thread/read", { threadId: thread.id, includeTurns: true });
  assert.equal(current.thread.turns.find(turn => turn.status === "inProgress")?.id, accepted.turn.id);
  assert.equal((await peer.request("server/diagnostics")).process.id, corePid);
  assert.equal(f.calls.length, 2);
  release.resolve();
  await until(() => peer.events.filter(m => m.method === "turn/completed").length === 2);
  const history = await f.runner().getHistory(thread.id);
  assert.equal(history.filter(item => item.role === "user" && item.text === "hold once").length, 1);
  assert.equal(f.calls.length, 2);
});

test("real native project membership reaches IDE enrichment with the existing stable project identity", native, async t => {
  const f = await sharedNativeCore(t), desktop = await f.rpc("desktop_ide");
  const workspace = fs.realpathSync(f.root);
  const { project } = await desktop.request("project/create", { name: "Native project", roots: [{ path: workspace }], idempotencyKey: "isolated-ide-project" });
  const { thread } = await desktop.request("thread/start", { cwd: workspace, projectId: project.id });
  await desktop.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "initialize", text_elements: [] }] });
  await until(() => desktop.events.some(m => m.method === "turn/completed"));
  const backend = f.runner(), gateway = new CodexAppServerGateway({ appServerBackend: backend });
  t.after(() => gateway.close());
  const paths = resolveStatePaths(path.join(f.root, "gateway-state"));
  saveAccount(paths, { accountId: "account", token: "isolated-fixture", baseUrl: "http://localhost" });
  const store = new RuntimeStateStore(accountStatePaths(paths, "account"));
  const hostId = "remote:isolated";
  const managed = store.createProject("Existing project", workspace, { sourceProjectId: "desktop-project", hostId, projectKind: "remote" });
  const session = store.createSession("group", workspace, "Task", managed.id);
  store.setSessionThread(session.id, thread.id);
  const manager = new AccountManager({ paths,
    ideProjectsProvider: () => [{ projectId: "desktop-project", hostId, workspace,
      name: "Existing project", projectKind: "remote", available: true, sessionCount: 1, lastUsedAt: "" }],
    runnerFactory: () => ({ async warmUp() {}, inspectThread: (id: string) => gateway.inspectThread(id),
      listProjects: () => gateway.listProjects() }) as never });
  manager.ide.configStore.save({ ...manager.ide.config(), enabled: true,
    hosts: [{ hostId, enabled: true, binary: "code-server" }] });
  const original = manager.ide.entry("account", session.id)!;
  const observed = await gateway.inspectThread(thread.id);
  assert.equal(observed.projectId, project.id);
  assert.equal(observed.projectMembership, "assigned");
  const fresh = await manager.ide.freshEntry("account", session.id);
  assert.equal(fresh?.url, original.url, "transport migration must preserve the project URL and existing authorization identity");
  assert.match(withIDEEntry("完整答复", fresh?.url), /\[打开项目 Web IDE\]/);
  assert.equal(new RuntimeStateStore(accountStatePaths(paths, "account")).getSession(session.id)!.projectId, managed.id);
  assert.equal(f.calls.length, 1, "membership and IDE reads never submit or repeat a task");
  await desktop.request("thread/metadata/update", { threadId: thread.id, projectId: "" });
  const independent = await gateway.inspectThread(thread.id);
  assert.equal(independent.projectId, undefined);
  assert.equal(independent.projectMembership, "none", "explicit removal cannot inherit stale Desktop or Gateway membership");
  assert.equal(await manager.ide.freshEntry("account", session.id), undefined);
  assert.throws(() => manager.ide.resolve(original.id), /失效/);
  assert.equal(f.calls.length, 1);
});

test("a CLI-only native service provides a local project IDE without any Desktop membership registry", native, async t => {
  const f = await sharedNativeCore(t), desktop = await f.rpc("headless_ide"), workspace = fs.realpathSync(f.root);
  const { project } = await desktop.request("project/create", { name: "Server project", roots: [{ path: workspace }], idempotencyKey: "headless-ide-project" });
  const { thread } = await desktop.request("thread/start", { cwd: workspace, projectId: project.id });
  await desktop.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "initialize", text_elements: [] }] });
  await until(() => desktop.events.some(m => m.method === "turn/completed"));
  const gateway = new CodexAppServerGateway({ appServerBackend: f.runner() });
  t.after(() => gateway.close());
  const paths = resolveStatePaths(path.join(f.root, "gateway-state"));
  saveAccount(paths, { accountId: "account", token: "isolated-fixture", baseUrl: "http://localhost" });
  const store = new RuntimeStateStore(accountStatePaths(paths, "account"));
  const managed = store.createProject("Server project", workspace, { sourceProjectId: project.id, hostId: "local" });
  const session = store.createSession("group", workspace, "Task", managed.id);
  store.setSessionThread(session.id, thread.id);
  const manager = new AccountManager({ paths, ideProjectsProvider: () => [],
    runnerFactory: () => ({ async warmUp() {}, inspectThread: (id: string) => gateway.inspectThread(id) }) as never });
  manager.ide.configStore.save({ ...manager.ide.config(), enabled: true, hosts: [{ hostId: "local", enabled: true, binary: "code-server" }] });
  const entry = await manager.ide.freshEntry("account", session.id);
  assert.ok(entry, "confirmed native assignment must not depend on a Desktop UI registry");
  assert.equal(manager.ide.resolve(entry.id).projectId, managed.id);
  assert.equal(new RuntimeStateStore(accountStatePaths(paths, "account")).getSession(session.id)!.projectId, managed.id);
  await desktop.request("thread/metadata/update", { threadId: thread.id, projectId: "" });
  assert.equal(await manager.ide.freshEntry("account", session.id), undefined);
  assert.throws(() => manager.ide.resolve(entry.id), /失效/);
  assert.equal(f.calls.length, 1);
});

test("one native core provides creation, unloaded continuation, goals, lifecycle, catalog and queue for both peers", native, async t => {
  const f = await sharedNativeCore(t), desktop = await f.rpc("desktop");
  const created = await desktop.request("thread/start", { cwd: f.root }); const id = created.thread.id;
  await desktop.request("turn/start", { threadId: id, input: [{ type: "text", text: "initialize", text_elements: [] }] });
  await until(() => desktop.events.some(m => m.method === "turn/completed"));
  const backend = f.runner(), gateway = new CodexAppServerGateway({ appServerBackend: backend });
  t.after(() => gateway.close());
  assert.equal((await gateway.serverIdentity()).processId, (await desktop.request("server/diagnostics")).process.id);
  assert.equal((await gateway.run({ threadId: id, cwd: f.root, prompt: "continue existing peer conversation" })).text, "DONE_2");
  assert.equal((await gateway.setGoal(id, { objective: "paused verification goal", status: "paused" }))?.status, "paused");
  assert.equal((await gateway.getGoal(id))?.objective, "paused verification goal");
  await gateway.clearGoal(id); assert.equal(await gateway.getGoal(id), undefined);
  await gateway.archiveThread(id); assert.equal((await gateway.inspectThread(id)).persistence, "archived");
  await gateway.unarchiveThread(id);
  assert.equal((await gateway.run({ threadId: id, cwd: f.root, prompt: "continue without opening in Desktop" })).text, "DONE_3");
  const newThread = await gateway.run({ cwd: f.root, prompt: "create through IM adapter", threadTitle: "Native creation" });
  assert.notEqual(newThread.threadId, id);
  assert.ok((await gateway.listSessionCatalog()).threads.some(t => t.threadId === newThread.threadId));
  const queued = await gateway.addQueuedSubmission({ threadId: id, prompt: "queued once", clientUserMessageId: "shared-core-queue" });
  const completed = await gateway.runQueuedSubmission({ threadId: id, cwd: f.root, queuedSubmissionId: queued.id, clientUserMessageId: "shared-core-queue" });
  assert.equal((await gateway.readTurnLifecycle(id, completed.turnId!)).status, "completed");
  assert.equal((await gateway.getHistory(id)).filter(m => m.clientUserMessageId === "shared-core-queue").length, 1);
  assert.equal(f.calls.length, 5);
});

test("a shared-core approval survives observer restart with the exact native request id and no synthetic refusal", native, async t => {
  const f = await sharedNativeCore(t, (_body, n) => n === 2 ? tool("exec_command", {
    cmd: "printf isolated_native_test", sandbox_permissions: "require_escalated", justification: "Isolated protocol verification"
  }, n) : message(`DONE_${n}`, n));
  const desktop = await f.rpc("desktop"), created = await desktop.request("thread/start", {
    cwd: f.root, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only"
  });
  const id = created.thread.id;
  await desktop.request("turn/start", { threadId: id, input: [{ type: "text", text: "initialize", text_elements: [] }] });
  await until(() => desktop.events.some(m => m.method === "turn/completed"));
  let observer = f.runner(); let observed = 0;
  await observer.observeThreadInteractions(id, { onApproval: async () => { observed++; return undefined; } });
  await desktop.request("turn/start", { threadId: id, input: [{ type: "text", text: "isolated tool", text_elements: [] }] });
  await until(() => observed === 1 && desktop.requests.length > 0);
  assert.equal(f.calls.length, 2); assert.equal(desktop.events.filter(m => m.method === "serverRequest/resolved").length, 0);
  assert.equal(observer.hasRestartBlockingWork(), false, "waiting for a human is not a transport handoff");
  await observer.close(); observer = f.runner();
  const decision = Promise.withResolvers<import("../src/codex/approval.js").CodexApprovalDecision>(), received = Promise.withResolvers<unknown>(); const results: string[] = [];
  await observer.observeThreadInteractions(id, {
    async onApproval(request) { received.resolve(request); return decision.promise; },
    onResult(_request, result) { results.push(result); }
  });
  const request = await received.promise as { requestId: string | number; request: import("../src/codex/approval.js").CodexApprovalRequest };
  assert.equal(request.requestId, desktop.requests[0].id); assert.equal(request.request.threadId, id);
  assert.equal(f.calls.length, 2, "a reconnect neither approves nor restarts the tool");
  const denial = request.request.options?.find(option => option.id === "decline" || option.id === "cancel")?.id ?? "decline";
  decision.resolve(denial);
  await until(() => results.includes("confirmed"));
  assert.equal(desktop.events.filter(m => m.method === "serverRequest/resolved").length, 1);
});

test("Gateway disconnect after acceptance does not interrupt a peer-visible native turn or repeat its input", native, async t => {
  const release = Promise.withResolvers<void>();
  const f = await sharedNativeCore(t, async (_body, n) => { if (n === 2) await release.promise; return message(`DONE_${n}`, n); });
  t.after(() => release.resolve());
  const backend = f.runner(), gateway = new CodexAppServerGateway({ appServerBackend: backend });
  const first = await gateway.run({ cwd: f.root, prompt: "initialize" });
  const accepted = Promise.withResolvers<{ threadId: string; turnId: string }>();
  const run = gateway.run({ cwd: f.root, threadId: first.threadId, prompt: "continue once", clientUserMessageId: "restart-exact-source",
    onTurnStarted: event => { accepted.resolve(event); } });
  const ended = assert.rejects(run, { submission: "accepted" });
  const identity = await accepted.promise; await until(() => f.calls.length === 2);
  assert.equal(gateway.hasRestartBlockingWork(), false);
  const process = await gateway.serverIdentity(); gateway.detachIndependentObservations(); await ended; await gateway.close();
  const next = new CodexAppServerGateway({ appServerBackend: f.runner() }); t.after(() => next.close());
  assert.deepEqual(await next.serverIdentity(), process);
  assert.equal((await next.inspectThread(identity.threadId)).activeTurnId, identity.turnId);
  release.resolve();
  const deadline = Date.now() + 8000; let observed = await next.readTurnLifecycle(identity.threadId, identity.turnId);
  while (observed.status !== "completed" && Date.now() < deadline) { await new Promise(r => setTimeout(r, 20)); observed = await next.readTurnLifecycle(identity.threadId, identity.turnId); }
  assert.equal(observed.status, "completed"); assert.equal(f.calls.length, 2);
  assert.equal((await next.getHistory(identity.threadId)).filter(m => m.clientUserMessageId === "restart-exact-source").length, 1);
});

test("the same native adapter retains dynamic tools and structured ephemeral output", native, async t => {
  const f = await sharedNativeCore(t, (_body, n) => n === 1 ? tool("gateway_echo", { text: "native" }, n)
    : message(n === 3 ? '{"ok":true}' : "DYNAMIC_DONE", n));
  const gateway = new CodexAppServerGateway({ appServerBackend: f.runner() }); t.after(() => gateway.close());
  const calls: string[] = [];
  const result = await gateway.run({ cwd: f.root, prompt: "use native dynamic tool", dynamicTools: [{ name: "gateway_echo",
    description: "Isolated echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
    onDynamicToolCall: call => { calls.push(call.tool); return "ECHO_NATIVE"; } });
  assert.equal(result.text, "DYNAMIC_DONE"); assert.deepEqual(calls, ["gateway_echo"]);
  const ephemeral = await gateway.runEphemeral({ cwd: f.root, prompt: "return JSON", outputSchema: {
    type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false
  } });
  assert.deepEqual(JSON.parse(ephemeral.text), { ok: true });
  assert.equal(gateway.backendInfo().capabilities.dynamicTools, true);
  assert.equal(gateway.backendInfo().capabilities.threadLifecycle, true);
});

test("Gateway continuation inherits the peer's permissions and reviewer instead of deriving them from callback presence", native, async t => {
  const f = await sharedNativeCore(t), desktop = await f.rpc("desktop");
  const created = await desktop.request("thread/start", { cwd: f.root,
    approvalPolicy: "never", approvalsReviewer: "auto_review", sandbox: "workspace-write" });
  const id = created.thread.id;
  await desktop.request("turn/start", { threadId: id, input: [{ type: "text", text: "initialize", text_elements: [] }] });
  await until(() => desktop.events.some(m => m.method === "turn/completed"));
  const gateway = new CodexAppServerGateway({ appServerBackend: f.runner({ sandbox: "read-only" }) }); t.after(() => gateway.close());
  await gateway.run({ threadId: id, cwd: f.root, prompt: "continue", onApproval: async () => "decline" });
  const current = await desktop.request("thread/resume", { threadId: id, excludeTurns: true });
  assert.equal(current.approvalPolicy, "never"); assert.equal(current.approvalsReviewer, "auto_review");
  assert.equal(current.sandbox.type, "workspaceWrite");
});
