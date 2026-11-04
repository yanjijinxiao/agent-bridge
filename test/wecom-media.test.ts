import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import AiBot from "@wecom/aibot-node-sdk";
import { WeComChannelAdapter } from "../src/channels/wecom.js";
import { WECOM_MEDIA_MAX_BYTES } from "../src/channels/wecom-media.js";
import { ChannelCapabilityError, ChannelDeliveryError } from "../src/channels/errors.js";
import { BridgeService } from "../src/bridge/service.js";
import { TurnResultActions } from "../src/bridge/turn-result-actions.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

const account = { channel: "wecom" as const, accountId: "fixture", botId: "fixture", secret: "fixture", enabled: true, savedAt: "" };
function directory(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-media-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function fixture(options: { upload?: unknown; result?: unknown; lost?: boolean } = {}) {
  const uploads: any[] = [], sends: any[] = [];
  const adapter = new WeComChannelAdapter(account, { wsClient: {
    async sendMessage() { return { errcode: 0, headers: { req_id: "notice" } }; },
    async uploadMedia(bytes: Buffer, input: { type: string; filename: string }) { uploads.push({ bytes, ...input });
      return options.upload === undefined ? { type: input.type, media_id: "uploaded" } : options.upload; },
    async sendMediaMessage(...args: unknown[]) { sends.push(args); if (options.lost) throw Error("lost websocket send acknowledgement");
      return options.result === undefined ? { errcode: 0, headers: { req_id: "media_confirmed" } } : options.result; }
  } as never });
  return { adapter, uploads, sends };
}

for (const kind of ["image", "file", "video"] as const) test(`WeCom ${kind} uploads original bytes and requires the native send acknowledgement`, async t => {
  const root = directory(t), file = path.join(root, "原始 ' 文件.mp4"), bytes = Buffer.from([0, 255, 10, 128]); fs.writeFileSync(file, bytes);
  for (const recipient of ["group", "person"]) {
    const f = fixture(); assert.equal(f.adapter.client.capabilities.outbound[kind], "available");
    assert.deepEqual(await f.adapter.client.sendMedia({ toUserId: recipient, path: file, kind }), { messageId: "media_confirmed" });
    assert.deepEqual(f.uploads, [{ type: kind, filename: path.basename(file), bytes }]); assert.deepEqual(f.sends, [[recipient, kind, "uploaded"]]);
  }
});

for (const kind of ["image", "file", "video"] as const) test(`WeCom ${kind} rejects missing, negative or wrong-type upload results before send`, async t => {
  const root = directory(t), file = path.join(root, "fixture.mp4"); fs.writeFileSync(file, "bytes");
  for (const upload of [null, {}, { type: kind, media_id: " " }, { type: "voice", media_id: "other-type" }, { type: kind, media_id: "key", errcode: 999 }]) {
    const f = fixture({ upload }); await assert.rejects(f.adapter.client.sendMedia({ toUserId: "group", path: file, kind }), ChannelDeliveryError);
    assert.equal(f.uploads.length, 1); assert.equal(f.sends.length, 0);
  }
});

for (const kind of ["image", "file", "video"] as const) test(`WeCom ${kind} upload cannot conceal a missing, negative or lost send acknowledgement`, async t => {
  const root = directory(t), file = path.join(root, "fixture.mp4"); fs.writeFileSync(file, "bytes");
  for (const options of [{ result: { errcode: 0 } }, { result: { errcode: 999, headers: { req_id: "key" } } }, { lost: true }]) {
    const f = fixture(options); await assert.rejects(f.adapter.client.sendMedia({ toUserId: "group", path: file, kind }));
    assert.equal(f.uploads.length, 1); assert.equal(f.sends.length, 1);
  }
});

test("WeCom media enforces the SDK chunk limit and rejects empty and non-file input before upload", async t => {
  const root = directory(t), file = path.join(root, "file.bin"); fs.writeFileSync(file, "data"); fs.truncateSync(file, WECOM_MEDIA_MAX_BYTES);
  const f = fixture(); await f.adapter.client.sendMedia({ toUserId: "person", kind: "file", path: file });
  assert.equal(f.uploads[0].bytes.length, WECOM_MEDIA_MAX_BYTES);
  fs.truncateSync(file, WECOM_MEDIA_MAX_BYTES + 1); const large = fixture();
  await assert.rejects(large.adapter.client.sendMedia({ toUserId: "person", kind: "file", path: file }), /上限/); assert.equal(large.uploads.length, 0);
  fs.truncateSync(file, 0); const empty = fixture();
  await assert.rejects(empty.adapter.client.sendMedia({ toUserId: "person", kind: "file", path: file }), /空文件/);
  await assert.rejects(empty.adapter.client.sendMedia({ toUserId: "person", kind: "file", path: root }), /普通文件/);
  assert.equal(empty.uploads.length, 0);
});

test("WeCom incomplete media SDK does not advertise a supported send route", async () => {
  for (const wsClient of [{ async sendMessage() {} }, { async sendMessage() {}, async uploadMedia() {} }]) {
    const adapter = new WeComChannelAdapter(account, { wsClient: wsClient as never });
    for (const kind of ["image", "file", "video"] as const) {
      assert.equal(adapter.client.capabilities.outbound[kind], "not-implemented");
      await assert.rejects(async () => adapter.client.sendMedia({ toUserId: "person", kind, path: "unused" }), ChannelCapabilityError);
    }
  }
});

for (const lost of [false, true]) test(`WeCom Bridge media receipts survive restart without re-upload or re-send (lost=${lost})`, async t => {
  const root = directory(t), store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const session = store.createSession("group", root, "Result", undefined, "session", undefined, { standalone: true }); store.setSessionThread(session.id, "thread");
  const f = fixture({ lost }), service = new BridgeService({ stateStore: store, config: defaultConfig(root), channel: f.adapter.client, runner: {} as never });
  const actions = ["image", "file", "video"].map(type => { const file = path.join(root, `output-${type}.mp4`); fs.writeFileSync(file, "bytes"); return { type, path: file }; });
  const text = "Result\n```codex-im-gateway-actions\n" + JSON.stringify({ send: actions }) + "\n```";
  const journal = path.join(root, "effects.json"), scope = [session.id, "thread", "turn"];
  const effect = (action: import("../src/bridge/turn-result-actions.js").TurnResultAction) => service.applyRecoveredAction(session.id, { hostId: "local", threadId: "thread" }, action);
  assert.equal(await new TurnResultActions(journal).apply(scope, text, () => {}, effect), !lost);
  assert.equal(f.uploads.length, 3); assert.equal(f.sends.length, 3);
  assert.equal(await new TurnResultActions(journal).apply(scope, text, () => {}, effect), !lost);
  assert.equal(f.uploads.length, 3); assert.equal(f.sends.length, 3);
  assert.deepEqual([...new Set(Object.values(JSON.parse(fs.readFileSync(journal, "utf8")).records))], [lost ? "started" : "done"]);
});

for (const chattype of ["single", "group", "unknown", undefined]) test(`WeCom conversation kind and participant identity come from provider fields (${chattype})`, async () => {
  const socket = new EventEmitter() as EventEmitter & { connect(): void; disconnect(): void }; socket.connect = () => {}; socket.disconnect = () => {};
  const adapter = new WeComChannelAdapter(account, { wsClient: socket as never }), controller = new AbortController(), messages: any[] = [];
  const run = adapter.monitor({ signal: controller.signal, async onMessage(message) { messages.push(message); } });
  socket.emit("message.text", { body: { msgid: "one", chatid: "group", chattype, from: { userid: "actor" }, text: { content: "hello" } } });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await run;
  assert.equal(messages[0].conversationKind, chattype === "single" ? "direct" : chattype === "group" ? "group" : undefined);
  assert.deepEqual(messages[0].mention, chattype === "group" ? { userId: "actor" } : undefined);
  assert.equal(messages[0].senderId, "actor"); assert.equal(messages[0].replyTargetId, chattype === "single" ? "actor" : "group");
  assert.equal(adapter.client.capabilities.mentions, "not-implemented", "an identity is not proof of a native outbound mention capability");
});

test("WeCom installed SDK uploads correlated chunks and sends one media message through an isolated websocket", async t => {
  const root = directory(t), file = path.join(root, "分片 文件.bin"), bytes = crypto.randomBytes(512 * 1024 + 37); fs.writeFileSync(file, bytes);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  let init: any; const chunks = new Map<number, Buffer>(), messages: any[] = [], reqIds: string[] = [];
  server.on("connection", socket => socket.on("message", data => {
    const frame = JSON.parse(data.toString()); reqIds.push(frame.headers.req_id);
    const ack = (body?: unknown) => socket.send(JSON.stringify({ headers: frame.headers, errcode: 0, errmsg: "ok", ...(body ? { body } : {}) }));
    if (frame.cmd === "aibot_subscribe" || frame.cmd === "ping") return ack();
    if (frame.cmd === "aibot_upload_media_init") { init = frame.body; return ack({ upload_id: "upload_fixture" }); }
    if (frame.cmd === "aibot_upload_media_chunk") { assert.equal(frame.body.upload_id, "upload_fixture"); chunks.set(frame.body.chunk_index, Buffer.from(frame.body.base64_data, "base64")); return ack(); }
    if (frame.cmd === "aibot_upload_media_finish") return ack({ type: "file", media_id: "media_fixture", created_at: "fixture" });
    if (frame.cmd === "aibot_send_msg") { messages.push(frame.body); return ack(); }
    assert.fail(`Unexpected isolated websocket command: ${frame.cmd}`);
  }));
  const ws = new AiBot.WSClient({ botId: "fixture", secret: "fixture", wsUrl: `ws://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
    maxReconnectAttempts: 0, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  t.after(() => ws.disconnect());
  const ready = new Promise<void>((resolve, reject) => { ws.once("authenticated", () => resolve()); ws.once("error", reject); }); ws.connect(); await ready;
  const adapter = new WeComChannelAdapter(account, { wsClient: ws });
  const receipt = await adapter.client.sendMedia({ toUserId: "group", kind: "file", path: file });
  assert.ok(receipt.messageId.startsWith("aibot_send_msg"));
  assert.equal(init.type, "file"); assert.equal(init.filename, path.basename(file)); assert.equal(init.total_size, bytes.length); assert.equal(init.total_chunks, 2);
  assert.equal(init.md5, crypto.createHash("md5").update(bytes).digest("hex"));
  assert.deepEqual(Buffer.concat([...chunks].sort(([a], [b]) => a - b).map(([, body]) => body)), bytes);
  assert.deepEqual(messages, [{ chatid: "group", msgtype: "file", file: { media_id: "media_fixture" } }]);
  assert.equal(new Set(reqIds).size, reqIds.length);
});

test("WeCom malformed participant fields do not escape durable admission or become mention authority", async () => {
  const socket = new EventEmitter() as EventEmitter & { connect(): void; disconnect(): void }; socket.connect = () => {}; socket.disconnect = () => {};
  const adapter = new WeComChannelAdapter(account, { wsClient: socket as never }), controller = new AbortController(), messages: any[] = [], errors: unknown[] = [];
  const run = adapter.monitor({ signal: controller.signal, async onMessage(message) { messages.push(message); }, onMessageError(error) { errors.push(error); } });
  for (const [index, userid] of ["all", "@all", "actor name", "<@actor>", 5, null].entries()) {
    assert.doesNotThrow(() => socket.emit("message.text", { body: { msgid: `bad-${index}`, chatid: "group", chattype: "group", from: { userid }, text: { content: "hello" } } }));
  }
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await run;
  assert.equal(errors.length, 2); assert.equal(messages.length, 4);
  assert.equal(messages.some(message => message.mention), false);
});


test("WeCom known group messages without a group target are rejected before durable admission", async () => {
  const socket = new EventEmitter() as EventEmitter & { connect(): void; disconnect(): void }; socket.connect = () => {}; socket.disconnect = () => {};
  const adapter = new WeComChannelAdapter(account, { wsClient: socket as never }), controller = new AbortController();
  let claims = 0, deliveries = 0; const errors: unknown[] = [];
  const run = adapter.monitor({ signal: controller.signal, claimMessage() { claims++; return true; },
    async onMessage() { deliveries++; }, onMessageError(error) { errors.push(error); } });
  for (const [index, chatid] of [undefined, ""].entries()) socket.emit("message.text", { body: {
    msgid: `missing-group-${index}`, chatid, chattype: "group", from: { userid: "actor" }, text: { content: "hello" } } });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await run;
  assert.equal(claims, 0); assert.equal(deliveries, 0); assert.equal(errors.length, 2);
});
