import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { classifyChannelInput } from "../src/bridge/channel-commands.js";
import type { ChannelCommandCapability } from "../src/bridge/channel-capability.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";
import type { ChannelMessage } from "../src/channels/message.js";

const extension: ChannelCommandCapability = { id: "fixture", commandName: "custom", aliases: { 别名: "custom", "file.md": "custom", alias: "custom" },
  helpLine: "/custom 参数 - 已安装扩展", aiActions: [], resolve: arg => ({ kind: "reply", text: `extension:${arg}` }) };
function fixture(t: TestContext, shared = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slash-routing-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(dir));
  const project = store.createProject("Project", dir, shared ? { hostId: "peer:device", projectKind: "remote" } : {});
  store.activateProject("actor", project.id); const session = store.createSession("actor", dir, "Session", project.id);
  store.setSessionThread(session.id, "native");
  const inputs: any[] = [], replies: string[] = [], cards: unknown[] = [];
  let failDiscovery = false, noticeHook = () => {}, stops = 0;
  const bridge = new BridgeService({ stateStore: store, config: { ...defaultConfig(dir), allowedSenderIds: shared ? [] : ["actor"], streamReplies: false },
    channel: createChannelClient("generic", { ...TEXT_CAPABILITIES, actionCards: "available" }, {
      async sendText(input) { replies.push(input.text); if (input.text.includes("未注册为 Gateway 命令")) noticeHook(); return { messageId: "text" }; },
      async sendActionCard(input) { cards.push(input.card); return { messageId: "card" }; }
    }),
    channelCapabilities: async () => { if (failDiscovery) throw Error("discovery failed"); return [extension]; },
    ...(shared ? { peer: { hosts: () => ["peer:device"], label: () => "Device", sharing: { admitted: () => true } } as any } : {}),
    runner: { backendInfo() { return { id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }; },
      async inspectThread() { return { threadId: "native", persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
      async stop() { stops++; return "not-active"; },
      async run(input: any) { inputs.push(input); return { threadId: "native", turnId: "turn", text: "done", raw: "" }; }
    } as never });
  const send = (text: string, extra: Partial<ChannelMessage> = {}) => bridge.handleMessage({ id: String(replies.length + inputs.length), senderId: "actor", text, raw: {}, ...extra });
  return { store, session, inputs, replies, cards, send, failDiscovery: () => { failDiscovery = true; },
    onNotice: (fn: () => void) => { noticeHook = fn; }, get stops() { return stops; } };
}

test("classification prioritizes built-ins and installed aliases; paths/prose are not unknown controls", () => {
  for (const text of ["/tmp/report.txt", "/queue/path", "/file.md", "//host/path", "/", "/你好", "> /stop", "`/stop`", "```text\n/stop\n```", "说明 /stop"]) {
    assert.deepEqual(classifyChannelInput(text), { kind: "message" }, text);
  }
  for (const text of ["/custom x", "/别名 x", "/file.md x", "/alias x"])
    assert.deepEqual(classifyChannelInput(text, [extension]), { kind: "command", command: { name: "custom", arg: "x" } });
  assert.deepEqual(classifyChannelInput("/stop", [{ ...extension, aliases: { stop: "custom" } }]), { kind: "command", command: { name: "stop", arg: "" } });
  assert.deepEqual(classifyChannelInput("/COMPACT  a\n b"), { kind: "message", unknownCommand: "compact" });
  assert.deepEqual(classifyChannelInput("/constructor"), { kind: "message", unknownCommand: "constructor" });
  assert.deepEqual(classifyChannelInput("/__proto__"), { kind: "message" });
  assert.deepEqual(classifyChannelInput("/constructor x", [{ ...extension, aliases: { constructor: "custom" } }]),
    { kind: "command", command: { name: "custom", arg: "x" } });
});

test("unknown slash produces only a short text notice then exact ordinary input; paths need no notice", async t => {
  const x = fixture(t);
  const text = "  /COMPACT  literal  spaces\nnext\n";
  await x.send(text);
  assert.equal(x.inputs.length, 1); assert.ok(x.inputs[0].prompt.includes(text));
  assert.equal(x.replies.filter(s => s.includes("未注册为 Gateway 命令")).length, 1); assert.equal(x.cards.length, 0);
  for (const input of ["/tmp/report.txt  内容\n下一行", "/queue/file", "/file.json", "//path", "/"]) await x.send(input);
  assert.equal(x.inputs.length, 6); assert.equal(x.replies.filter(s => s.includes("未注册为 Gateway 命令")).length, 1);
  x.failDiscovery(); await x.send("/tmp/no-discovery"); assert.equal(x.inputs.length, 7);
});

test("registered extension, builtin aliases and invalid arguments never fall through to native input", async t => {
  const x = fixture(t);
  for (const text of ["/custom a", "/别名 b", "/file.md c", "/alias d", "/str off", "/prompt invalid", "/x"]) await x.send(text);
  assert.equal(x.inputs.length, 0); assert.equal(x.stops, 1);
  assert.ok(x.replies.includes("extension:a")); assert.ok(x.replies.includes("extension:b"));
  assert.ok(!x.replies.some(s => s.includes("未注册为 Gateway 命令")));
});

test("unknown slash participates in prompt buffering instead of starting a turn", async t => {
  const x = fixture(t); await x.send("/prompt start"); await x.send("/compact  content\nline");
  assert.equal(x.inputs.length, 0); await x.send("/prompt done");
  assert.equal(x.inputs.length, 1); assert.ok(x.inputs[0].prompt.includes("/compact  content\nline"));
});

test("discovery failure, stale UI action and missing binding never become native input", async t => {
  const x = fixture(t);
  await x.send("/unknown", { source: "native-menu" });
  await x.send("/unknown", { interaction: { kind: "card", messageId: "old" } });
  assert.equal(x.inputs.length, 0); assert.equal(x.cards.length, 0);
  x.failDiscovery(); await assert.rejects(x.send("/unknown"), /discovery failed/); assert.equal(x.inputs.length, 0);
});

test("unknown slash honors viewer denial and rechecks binding after the text notice", async t => {
  const x = fixture(t); x.store.setRole("actor", "actor", "viewer"); await x.send("/unknown");
  assert.equal(x.inputs.length, 0); assert.ok(!x.replies.some(s => s.includes("未注册为 Gateway 命令")));
  x.store.setRole("actor", "actor", "participant");
  x.onNotice(() => x.store.resetSession(x.session.id));
  await x.send("/unknown").catch(error => assert.match(error.message, /绑定.*已改变/));
  assert.equal(x.inputs.length, 0);
});

test("shared participant forwards unknown input without interpreting --host, but cannot run extensions", async t => {
  const x = fixture(t, true);
  await x.send("/compact --host forbidden content");
  assert.equal(x.inputs.length, 1); assert.equal(x.inputs[0].hostId, "peer:device");
  assert.ok(x.inputs[0].prompt.includes("/compact --host forbidden content"));
  await x.send("/custom work"); assert.equal(x.inputs.length, 1);
  assert.ok(x.replies.some(s => s.includes("共享授权不包含")));
  await x.send("/sessions --host forbidden"); assert.equal(x.inputs.length, 1);
  assert.ok(x.replies.some(s => s.includes("指定会话的资源授权")));
});
