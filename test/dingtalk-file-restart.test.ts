import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk.js";
import { PinnedNetworkLifecycleTransport } from "../src/channels/network-family.js";
import type { ChannelMessage } from "../src/channels/message.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-file-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "结果.txt"), bytes = Buffer.from("restart result\n");
  fs.writeFileSync(file, bytes);
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const texts: string[] = [];
  function adapter(clientId = "robot", now = Date.now()) {
    let callback!: (frame: DWClientDownStream) => void;
    const a = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId,
      clientSecret: "test-secret", createdAt: new Date().toISOString() }, {
      inboundDir: root,
      now: () => now,
      webhookSender: async ({ url }) => { texts.push(url); return { messageId: "text-confirmed" }; },
      streamClient: { registerCallbackListener(_topic, cb) { callback = cb; }, async connect() {}, disconnect() {}, off() {},
        socketCallBackResponse() {}, async getAccessToken() { return "test-access-token"; } },
      emotionClient: { async reply() {}, async recall() {} },
      apiTransport: new PinnedNetworkLifecycleTransport("ipv4", async (_family, url, init) => {
        calls.push({ url: new URL(url), init: init! });
        return Response.json(new URL(url).pathname === "/media/upload" ? { errcode: 0, media_id: "test-media" }
          : { errcode: 0, processQueryKey: "confirmed" });
      })
    });
    const receive = async (type: string, staffId: string = "confirmed-staff") => {
      const abort = new AbortController(), received = Promise.withResolvers<ChannelMessage>();
      const monitor = a.monitor({ signal: abort.signal, onMessage: async message => { received.resolve(message); } });
      try {
        callback({ specVersion: "1.0", type: "CALLBACK", headers: { appId: clientId, connectionId: "test", contentType: "application/json",
          messageId: "frame", time: "0", topic: TOPIC_ROBOT }, data: JSON.stringify({ msgId: "source", msgtype: "text", text: { content: "run" },
          conversationId: "cid-original", conversationType: type, senderStaffId: staffId, senderId: "encrypted-sender",
          robotCode: "callback-robot", sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=ephemeral-secret",
          sessionWebhookExpiredTime: Date.now() + 60_000 }) } as DWClientDownStream);
        return await received.promise;
      } finally { abort.abort(); await monitor; await new Promise<void>(resolve => setImmediate(resolve)); }
    };
    return { a, receive };
  }
  return { root, file, bytes, calls, texts, adapter };
}

for (const type of ["1", "2"]) test(`DingTalk file delivery restores confirmed ${type === "1" ? "private" : "group"} route after restart without a new inbound`, async t => {
  const fx = fixture(t), first = fx.adapter();
  await first.receive(type);
  const saved = fs.readFileSync(path.join(fx.root, "card-routing.json"), "utf8");
  assert.ok(!saved.includes("ephemeral-secret") && !saved.includes("sessionWebhook"));
  const restored = fx.adapter(); // New adapter, empty AsyncLocalStorage and replyTargets, original disk only.
  const receipt = await restored.a.client.sendMedia({ toUserId: "cid-original", path: fx.file, kind: "file" });
  assert.equal(receipt.messageId, "confirmed");
  assert.equal(fx.calls.length, 2);
  const upload = (await new Request(fx.calls[0].url, fx.calls[0].init).formData()).get("media") as File;
  assert.deepEqual(Buffer.from(await upload.arrayBuffer()), fx.bytes);
  assert.equal(fx.calls[1].url.pathname, type === "1" ? "/v1.0/robot/oToMessages/batchSend" : "/v1.0/robot/groupMessages/send");
  const body = JSON.parse(String(fx.calls[1].init.body));
  assert.equal(body.robotCode, "callback-robot");
  if (type === "1") assert.deepEqual(body.userIds, ["confirmed-staff"]);
  else assert.equal(body.openConversationId, "cid-original");
});

for (const mode of ["missing-staff", "different-bot", "unknown-recipient", "encrypted-sender"] as const)
  test(`DingTalk restart refuses an unconfirmed file destination: ${mode}`, async t => {
    const fx = fixture(t), first = fx.adapter();
    await first.receive("1", mode === "missing-staff" ? "" : "confirmed-staff");
    const restored = fx.adapter(mode === "different-bot" ? "other-robot" : "robot");
    await assert.rejects(restored.a.client.sendMedia({ toUserId: mode === "unknown-recipient" ? "cid-unknown"
      : mode === "encrypted-sender" ? "encrypted-sender" : "cid-original", path: fx.file, kind: "file" }), /会话未知/);
    assert.equal(fx.calls.length, 0, "unknown target cannot even upload a file");
  });

test("DingTalk file and text recover the still-valid private reply credential through the existing context store", async t => {
  const fx = fixture(t), first = fx.adapter(), message = await first.receive("1");
  assert.ok(message.contextToken);
  const paths = resolveStatePaths(path.join(fx.root, "state"));
  const state = new RuntimeStateStore(paths);
  state.createSession("cid-original", fx.root);
  const bridge = new BridgeService({ channel: first.a.client, stateStore: state,
    config: { ...defaultConfig(fx.root), allowedSenderIds: ["confirmed-staff"], streamReplies: false }, runner: {
      async listProjects() { return { backend: "app-server", projects: [] }; }, async listThreads() { return []; },
      async run(input: unknown) { assert.ok(!JSON.stringify(input).includes("ephemeral-secret"), "reply credentials must never enter model input");
        return { raw: "", threadId: "test-thread", text: "ready" }; }, async stop() {}
    } as never });
  await bridge.handleMessage(message);
  const contextToken = new RuntimeStateStore(paths).getContextToken("cid-original");
  assert.equal(contextToken, message.contextToken);
  assert.equal(fs.statSync(paths.statePath).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(fx.root, "card-routing.json"), "utf8").includes("ephemeral-secret"));
  const restored = fx.adapter();
  await restored.a.client.sendMedia({ toUserId: "cid-original", path: fx.file, kind: "file", contextToken });
  assert.equal(fx.calls[1].url.pathname, "/robot/sendBySession", "no proactive OTO permission is required while the original webhook is valid");
  await restored.a.client.sendText({ toUserId: "cid-original", text: "done", contextToken });
  assert.equal(fx.texts.at(-1), fx.calls[1].url.href);
});

for (const change of ["wrong-bot", "wrong-conversation", "expired", "unsafe-url", "malformed"] as const)
  test(`DingTalk recovered credential is never used outside its exact valid scope: ${change}`, async t => {
    const fx = fixture(t), message = await fx.adapter().receive("1");
    const token = JSON.parse(message.contextToken!);
    if (change === "wrong-bot") token.clientId = "another-bot";
    if (change === "wrong-conversation") token.reply.conversationId = "another-conversation";
    if (change === "expired") token.reply.expiresAt = 1;
    if (change === "unsafe-url") token.reply.webhookUrl = "https://attacker.invalid/?session=secret";
    const restored = fx.adapter();
    await restored.a.client.sendMedia({ toUserId: "cid-original", path: fx.file, kind: "file",
      contextToken: change === "malformed" ? "not-json" : JSON.stringify(token) });
    assert.equal(fx.calls[1].url.pathname, "/v1.0/robot/oToMessages/batchSend", "only the independently confirmed public route remains usable");
    assert.ok(fx.calls.every(call => call.url.hostname !== "attacker.invalid"));
  });


test("DingTalk recovered reply credential is retained by action-card mention delivery", async t => {
  const fx = fixture(t), message = await fx.adapter().receive("2");
  const restored = fx.adapter();
  await restored.a.client.sendActionCard({ toUserId: "cid-original", contextToken: message.contextToken,
    mentions: [{ userId: "confirmed-staff" }], card: { title: "Approval", template: "blue", actionGroups: [],
      body: "test approval", fallbackText: "test approval\n".repeat(600) } });
  assert.ok(fx.texts.length >= 2, "the first mention page and subsequent text pages must retain the reply credential");
  assert.ok(fx.texts.every(url => url.includes("/robot/sendBySession?session=")));
});
