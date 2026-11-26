import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { parseCommand } from "../src/bridge/channel-commands.js";
import { addressedCommandText } from "../src/channels/command-text.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";
import { CodexBackendRouter } from "../src/codex/runner.js";

function fixture(t: TestContext, options: { slow?: boolean; slowTaskboard?: boolean; offline?: boolean; devicePolicy?: "create-when-unbound" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "command-status-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const project = store.createProject("Gateway", root, options.offline ? { hostId: "peer:old:herdr-app" } : undefined), session = store.createSession("group", root, "Original", project.id);
  store.setSessionThread(session.id, "thread");
  const replies: string[] = [], prompts: string[] = [], reads: unknown[] = [];
  const never = () => new Promise<never>(() => {});
  const state = { threadId: "thread", persistence: "active", runtimeStatus: "active", activeFlags: [], activeTurnId: "turn", executionOwner: "desktop" };
  const items: any[] = [];
  const runner = { backendInfo: () => ({ id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
    async inspectThread(_id: string, _host: string, observation: unknown) { reads.push(observation); if (options.slow && observation) return never(); return state; },
    async getRuntimeInfo(_cwd: string, _id: string, _host: string, observation: unknown) { reads.push(observation); return options.slow ? never() : { model: "native-model", effort: "high" }; },
    async addQueuedSubmission(input: any) { input.assertCurrent(); prompts.push(input.prompt); const item = { id: "q-1", clientUserMessageId: input.clientUserMessageId, input: [{ type: "text", text: input.prompt }] }; items.push(item); return item; },
    async listQueuedSubmissions() { return { data: items }; },
    async run() { assert.fail("must not start a direct task"); }, async submitThreadMessage() { assert.fail("explicit queue must not become steer"); } };
  const service = new BridgeService({ stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["alice"], model: "configured-model" }, runner: runner as never,
    peer: options.offline ? { isOnline: () => false, label: () => "原 Herdr 设备", hosts: () => [], connect: never } : options.devicePolicy ? { unboundSessionPolicy: () => options.devicePolicy, hosts: () => [], label: (id: string) => id, connect: never } : undefined,
    forwardingStatus: () => ({ waiting: 2, unconfirmed: 0, held: 1 }),
    channelCapabilities: never,
    taskboard: options.slow || options.slowTaskboard ? { projectForWorkspace: never } as never : undefined,
    channel: createChannelClient("generic", TEXT_CAPABILITIES, { async resolveReferences(message) { if (options.slow) assert.fail("diagnostics must not fetch quoted messages"); return message; }, async sendText(input) { replies.push(input.text); return { messageId: "sent" }; } }) });
  const send = (text: string, id = "message") => service.handleMessage({ id, senderId: "alice", replyTargetId: "group", text: addressedCommandText(text), attachments: [], raw: {} });
  return { send, replies, prompts, reads, store, session, service, runner };
}

test("compact Chinese queue syntax has exact boundaries and cannot be shadowed by an extension alias", () => {
  assert.deepEqual(parseCommand("/queue这是在干啥？\n请核对"), { name: "queue", arg: "这是在干啥？\n请核对" });
  assert.deepEqual(parseCommand("/iv请检查"), { name: "steer", arg: "请检查" });
  assert.deepEqual(parseCommand("/status", { status: "extension" }), { name: "status", arg: "" });
  assert.deepEqual(parseCommand("/custom arg", { custom: "extension" }), { name: "extension", arg: "arg" });
  for (const name of ["queueing", "queue.md", "queue/path"]) assert.notEqual(parseCommand("/" + name)?.name, "queue");
  for (const text of ["普通问题里提到 /queue", "> /queue 请检查", "`/queue 请检查`", "```text\n/queue 请检查\n``` "]) assert.equal(parseCommand(text), undefined);
});

for (const text of ["@头头/queue这是在干啥？", "@头头\n/queue 这是在干啥？", "<@bot>/queue这是在干啥？"]) test(`addressed input enters native queue exactly once: ${JSON.stringify(text)}`, async t => {
  const f = fixture(t); await f.send(text);
  assert.equal(f.prompts.length, 1); assert.ok(f.prompts[0].includes("这是在干啥？")); assert.ok(!f.prompts[0].includes("/queue"));
  assert.match(f.replies[0], /加入原生队列/); assert.ok(!f.replies[0].includes("补充输入"));
});

test("status bypasses stalled skill discovery and uses only bounded, isolated diagnostic reads", { timeout: 3500 }, async t => {
  const f = fixture(t, { slow: true }); const start = performance.now();
  await f.send("@头头/status");
  assert.ok(performance.now() - start < 2500);
  assert.match(f.replies[0], /运行状态：暂未确认/); assert.match(f.replies[0], /model: \(暂未读取\)/);
  assert.match(f.replies[0], /关联信息暂不可读取/); assert.ok(!f.replies[0].includes("model: (Codex default)"));
  assert.equal(f.prompts.length, 0);
  assert.equal(f.reads.length, 2); for (const observation of f.reads as any[]) { assert.equal(observation.purpose, "status"); assert.equal(observation.timeoutMs, 3000); }
});

test("offline binding answers status/where locally before discovery and preserves the original receipt target", async t => {
  const f = fixture(t, { offline: true });
  const discover = t.mock.method(f.runner, "backendInfo", () => { throw Error("peer/discover"); });
  for (const command of ["/status", "/where"]) {
    await f.send(command, command);
    const reply = f.replies.at(-1)!;
    assert.match(reply, /Original/); assert.match(reply, /原 Herdr 设备（离线）/);
    assert.match(reply, /运行状态：暂未确认/); assert.match(reply, /2 条已保存待转发/);
  }
  assert.equal(discover.mock.callCount(), 0); assert.deepEqual(f.reads, []);
  assert.equal(f.store.getBoundSession("group")?.threadId, "thread");
  const message = { id: "input", text: "hi", senderId: "alice", replyTargetId: "group", attachments: [], raw: {} };
  assert.equal(f.service.offlineForwardingDevice(message, "peer:old:herdr-app"), "原 Herdr 设备");
  assert.equal(f.service.offlineForwardingDevice({ ...message, senderId: "stranger" }, "peer:old:herdr-app"), undefined);
});

test("unavailable discovery still shows saved binding without guessing Codex capabilities", async t => {
  const f = fixture(t);
  t.mock.method(f.runner, "backendInfo", () => { throw Error("peer/discover"); });
  await f.send("/status");
  assert.match(f.replies[0], /Original/); assert.match(f.replies[0], /状态暂不可读取/);
  assert.doesNotMatch(f.replies[0], /正在执行|Codex default/); assert.deepEqual(f.reads, []);
});

test("help remains a local control with both the bound device offline and extension discovery stalled", { timeout: 4000 }, async t => {
  const f = fixture(t, { offline: true, slow: true });
  const discover = t.mock.method(f.runner, "backendInfo", () => { throw Error("peer/discover"); });
  await f.send("/h");
  const reply = f.replies.join("\n");
  assert.match(reply, /常用命令/); assert.match(reply, /运行能力暂不可读取/);
  assert.match(reply, /\/connect/); assert.match(reply, /\/status/); assert.match(reply, /扩展清单暂时无法读取/);
  assert.doesNotMatch(reply, /默认安全插话|^\/model\b/m);
  assert.equal(discover.mock.callCount(), 0); assert.deepEqual(f.prompts, []);
  assert.equal(f.store.getBoundSession("group")?.threadId, "thread");
});

test("status distinguishes an unbound chat eligible for a default session from an explicit detach", async t => {
  const f = fixture(t);
  f.service.configureFirstContact({ onUnbound: "create", groupScope: "member", connector: "host29" });
  await f.service.handleMessage({ id: "fresh", senderId: "alice", conversationKind: "direct", text: "/status", attachments: [], raw: {} });
  assert.match(f.replies.at(-1)!, /发送普通消息即可创建默认会话/);
  f.store.leaveSession("group");
  await f.send("/status");
  assert.doesNotMatch(f.replies.at(-1)!, /即可创建默认会话/);
  assert.equal(f.store.getBoundSession("group"), undefined);
});

test("after idle expiry an allowed ordinary message reserves a new session and a status command leaves it unbound", async t => {
  const f = fixture(t, { devicePolicy: "create-when-unbound" });
  f.store.leaveSession("group", "idle");
  f.service.configureFirstContact({ groupScope: "conversation", connector: "host29" });
  const input = { id: "new-input", senderId: "alice", conversationKind: "group" as const, replyTargetId: "group", text: "/status", attachments: [], raw: {} };
  assert.equal(f.service.addressInbound(input).firstContactId, undefined);
  await f.send("/status");
  assert.match(f.replies.at(-1)!, /发送普通消息即可创建默认会话/);
  assert.equal(f.store.firstContactReservation("group"), undefined);
  assert.equal(f.service.addressInbound({ ...input, senderId: "stranger", text: "hi" }).firstContactHost, undefined);
  assert.equal(f.service.addressInbound({ ...input, text: "hi" }).firstContactHost, "host29");
  assert.equal(f.store.getBoundSession("group"), undefined);
});

test("status cannot present a late observation after binding reset", async t => {
  const f = fixture(t), release = Promise.withResolvers<any>(), entered = Promise.withResolvers<void>();
  f.runner.inspectThread = async () => { entered.resolve(); return release.promise; };
  const pending = f.send("/status"); await entered.promise; f.store.resetSession(f.session.id); release.resolve({ threadId: "thread", runtimeStatus: "active", activeFlags: [] }); await pending;
  assert.match(f.replies[0], /绑定已改变/); assert.ok(!f.replies[0].includes("正在执行"));
});

test("status returns native execution details while only the Taskboard lookup hangs", { timeout: 3500 }, async t => {
  const f = fixture(t, { slowTaskboard: true });
  const start = performance.now();
  await f.send("/status");
  assert.ok(performance.now() - start < 2500);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0], /native-model/);
  assert.match(f.replies[0], /关联信息暂不可读取/);
  assert.doesNotMatch(f.replies[0], /运行状态：暂未确认/);
  assert.equal(f.reads.length, 2);
  assert.deepEqual(f.prompts, []);
});

test("queue admission rejects reset/rebind ABA during preparation", async t => {
  const f = fixture(t), release = Promise.withResolvers<any>(), entered = Promise.withResolvers<void>();
  f.runner.inspectThread = async () => { entered.resolve(); return release.promise; };
  const pending = f.send("/queue请核对"), rejected = assert.rejects(pending, /绑定已改变/);
  await entered.promise; f.store.resetSession(f.session.id); f.store.setSessionThread(f.session.id, "thread"); release.resolve({ threadId: "thread", persistence: "active", runtimeStatus: "active", activeFlags: [] }); await rejected;
  assert.equal(f.prompts.length, 0);
});

test("status reader timeout cannot retire a concurrent membership/authorization reader", async t => {
  let created = 0, closed: number[] = [];
  const membership = Promise.withResolvers<any>();
  const router = new CodexBackendRouter({ backend: "app-server", metadataConnectionFactory: () => {
    const id = ++created; return { async inspectThread() { if (id === 1) return membership.promise; return new Promise<any>(() => {}); },
      async getRuntimeInfo() { return { model: "readonly" }; }, async listProjects() { return { backend: "app-server", projects: [] }; }, close() { closed.push(id); } };
  } });
  t.after(() => router.close());
  const background = router.inspectThread("thread", "remote", { includeTurns: false, timeoutMs: 2000 });
  // Start background construction before the separate interactive connection.
  await new Promise(resolve => setImmediate(resolve));
  const status = router.inspectThread("thread", "remote", { includeTurns: false, timeoutMs: 10, purpose: "status" });
  await assert.rejects(status); assert.ok(closed.length >= 1); assert.ok(!closed.includes(1));
  membership.resolve({ threadId: "thread", runtimeStatus: "idle", persistence: "active", activeFlags: [] });
  assert.equal((await background).runtimeStatus, "idle"); assert.ok(!closed.includes(1));
  assert.equal((await router.getRuntimeInfo("/work", "thread", "remote", { timeoutMs: 50, purpose: "status" })).model, "readonly");
});

test("queue list returns local receipts promptly and coalesces repeated slow checks", { timeout: 3500 }, async t => {
  const f = fixture(t); await f.send("/queue请检查", "enqueue"); await new Promise(resolve => setImmediate(resolve));
  let reads = 0;
  f.runner.listQueuedSubmissions = async () => { reads++; return new Promise<any>(() => {}); };
  const start = performance.now();
  await Promise.all([f.send("/queue list", "list-1"), f.send("/queue list", "list-2")]);
  assert.ok(performance.now() - start < 2500); assert.equal(reads, 1);
  for (const text of f.replies.slice(-2)) { assert.match(text, /持久化回执/); assert.match(text, /不代表已确认的当前状态/); assert.ok(text.includes("q-1")); }
  assert.equal(f.prompts.length, 1);
});
