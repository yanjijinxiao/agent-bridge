import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { NativeQueueCoordinator } from "../src/bridge/native-queue.js";
import { parsePrompt } from "../src/bridge/format.js";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
// @ts-expect-error JS fixture owns a real installed native daemon and local model.
import { sharedNativeCore, until } from "./fixtures/shared-native-core.mjs";

for (const [channelId, source] of [["dingtalk", "DingTalk"], ["weixin", "WeChat"], ["feishu", "Feishu"], ["wecom", "WeCom"]] as const) {
test(`queued first input receives ${source} rules in the actual native model request`, {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30_000
}, async t => {
  const core = await sharedNativeCore(t), runner = core.runner();
  const backend = new CodexAppServerGateway({ appServerBackend: runner });
  const thread = await backend.createThread({ cwd: core.root, projectBinding: "none", title: "Queued context regression" });
  const before = await backend.getRuntimeInfo(core.root, thread.threadId);
  const state = new RuntimeStateStore(resolveStatePaths(path.join(core.root, "bridge")));
  const session = state.createSession("room", core.root, "Queued context regression", undefined, "session", undefined, { standalone: true });
  state.setSessionThread(session.id, thread.threadId);
  const journalPath = path.join(core.root, "queue-receipts.json"), queue = new NativeQueueCoordinator(journalPath);
  const replies: string[] = [], channel = createChannelClient(channelId, TEXT_CAPABILITIES, {
    async sendText(input) { replies.push(input.text); return { messageId: `reply-${replies.length}` }; }
  });
  const wire = runner as unknown as { request(method: string, params: unknown, ...args: unknown[]): Promise<unknown> };
  const request = wire.request.bind(runner), methods: string[] = [];
  wire.request = (method, params, ...args) => { methods.push(method); return request(method, params, ...args); };
  const bridge = new BridgeService({ runner: backend, channel, stateStore: state, nativeQueue: queue,
    config: { ...defaultConfig(core.root), allowedSenderIds: ["room"], streamReplies: false } });
  const prompt = "QUEUE-CONTEXT-FIRST-INPUT: reply done";
  await bridge.handleMessage({ id: "queue-context-source", senderId: "room", text: `/queue ${prompt}`, attachments: [], raw: {} });
  assert.equal(queue.list("standalone").length, 1, JSON.stringify(replies));
  await until(() => core.calls.length === 1, 15000);
  // AccountManager normally drives these recovery ticks; keep the real Bridge
  // and coordinator here without starting an unrelated account monitor.
  for (let attempt = 0; attempt < 60 && !queue.list("standalone")[0].delivered; attempt++) {
    await bridge.recoverNativeQueue();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(queue.list("standalone")[0].delivered, JSON.stringify({ receipts: queue.list("standalone"), replies }));
  assert.equal(core.calls.length, 1);
  const actual = JSON.stringify(core.calls[0]);
  assert.ok(actual.includes(`${source} bridge rule:`), "check the actual model request, not an ignored dispatch parameter");
  assert.ok(actual.includes("codex-im-gateway-actions"));
  assert.ok(actual.includes("Gateway owns the automatic project Web IDE footer"));
  assert.ok(actual.includes(prompt));
  assert.doesNotMatch(actual, /private-knowledge|Known reusable knowledge|under remember/);
  const receipt = queue.list("standalone")[0];
  const history = await backend.getHistory(thread.threadId);
  const user = history.filter(item => item.clientUserMessageId === receipt.clientUserMessageId);
  assert.equal(user.length, 1, "exactly one native user input");
  assert.equal(parsePrompt(user[0].text).text, prompt, "history/preview expose the user's request without policy blocks");
  assert.equal(state.getSession(session.id)?.lastPromptPreview, prompt);
  assert.equal(methods.filter(method => method === "thread/queue/add").length, 1);
  assert.equal(methods.filter(method => ["turn/start", "turn/interrupt", "thread/injectItems", "config/value/write"].includes(method)).length, 0);
  assert.deepEqual(await backend.getRuntimeInfo(core.root, thread.threadId), before, "queue context never changes native permissions or model settings");
  assert.ok(!fs.readFileSync(journalPath, "utf8").includes(`${source} bridge rule:`), "Gateway's queue journal stores receipts, not a replay backlog");
  assert.ok(!fs.readFileSync(journalPath, "utf8").includes("QUEUE_KNOWLEDGE_AT_ADMISSION"));
  assert.ok(replies.some(text => text.includes("DONE_1")));
});
}
