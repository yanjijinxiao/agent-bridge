import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createFeishuApiClient } from "../src/channels/feishu-sdk.js";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";
import { FEISHU_FILE_MAX_BYTES, FEISHU_IMAGE_MAX_BYTES } from "../src/channels/feishu-media.js";
import { ChannelCapabilityError, ChannelDeliveryError } from "../src/channels/errors.js";
import { BridgeService } from "../src/bridge/service.js";
import { TurnResultActions } from "../src/bridge/turn-result-actions.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

const account = { channel: "feishu" as const, accountId: "fixture", appId: "fixture", appSecret: "fixture", enabled: true, savedAt: "" };
function directory(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-outbound-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function fixture(options: { upload?: unknown; result?: unknown; lost?: boolean; noFiles?: boolean } = {}) {
  const uploads: any[] = [], messages: any[] = [];
  const upload = async (input: unknown) => { uploads.push(input); return options.upload === undefined ? { file_key: "file_uploaded" } : options.upload; };
  const adapter = new FeishuChannelAdapter(account, { apiClient: { im: { v1: {
    image: { async create(input: unknown) { uploads.push(input); return options.upload === undefined ? { image_key: "image_uploaded" } : options.upload; } },
    ...(!options.noFiles ? { file: { create: upload } } : {}),
    message: { async create(input: unknown) { messages.push(input); if (options.lost) throw Error("lost message acknowledgement");
      return options.result === undefined ? { code: 0, data: { message_id: "message_confirmed" } } : options.result; } }
  } } } as never, wsClient: { async start() {}, close() {} } });
  return { adapter, uploads, messages };
}

for (const kind of ["file", "video"] as const) test(`Feishu ${kind} uses the native upload type and message receipt for group and direct recipients`, async t => {
  const root = directory(t), file = path.join(root, kind === "video" ? "演示 ' 视频.MP4" : "报告 ' 文件.pdf"), bytes = Buffer.from("原始字节\0\xff\n"); fs.writeFileSync(file, bytes);
  for (const recipient of ["oc_group", "ou_person", "employee_id"]) for (const wrapped of [false, true]) {
    const f = fixture({ ...(wrapped ? { upload: { code: 0, data: { file_key: "file_uploaded" } } } : {}) });
    assert.equal(f.adapter.client.capabilities.outbound[kind], "available");
    assert.deepEqual(await f.adapter.client.sendMedia({ toUserId: recipient, path: file, kind }), { messageId: "message_confirmed" });
    assert.equal(f.uploads.length, 1); assert.deepEqual(f.uploads[0].data,
      { file_type: kind === "video" ? "mp4" : "stream", file_name: path.basename(file), file: bytes });
    assert.deepEqual(f.messages, [{ params: { receive_id_type: recipient.startsWith("oc_") ? "chat_id" : recipient.startsWith("ou_") ? "open_id" : "user_id" },
      data: { receive_id: recipient, msg_type: kind === "video" ? "media" : "file", content: JSON.stringify({ file_key: "file_uploaded" }) } }]);
  }
});

for (const kind of ["image", "file", "video"] as const) test(`Feishu ${kind} rejects a malformed or negative upload receipt before creating a message`, async t => {
  const root = directory(t), file = path.join(root, "fixture.mp4"); fs.writeFileSync(file, "bytes");
  for (const upload of [null, {}, { code: 0, data: {} }, { [`${kind === "image" ? "image" : "file"}_key`]: " " },
    { code: 999, data: { image_key: "looks_valid", file_key: "looks_valid" }, image_key: "looks_valid", file_key: "looks_valid" }]) {
    const f = fixture({ upload });
    await assert.rejects(f.adapter.client.sendMedia({ toUserId: "oc_group", kind, path: file }), ChannelDeliveryError);
    assert.equal(f.uploads.length, 1); assert.equal(f.messages.length, 0);
  }
});

for (const kind of ["file", "video"] as const) test(`Feishu ${kind} upload success cannot conceal missing, rejected or lost message acknowledgement`, async t => {
  const root = directory(t), file = path.join(root, "fixture.mp4"); fs.writeFileSync(file, "bytes");
  for (const options of [{ result: { code: 0, data: {} } }, { result: { code: 999 } }, { lost: true }]) {
    const f = fixture(options); await assert.rejects(f.adapter.client.sendMedia({ toUserId: "oc_group", kind, path: file }));
    assert.equal(f.uploads.length, 1); assert.equal(f.messages.length, 1);
  }
});

test("Feishu media validates exact byte limits, empty/non-file input and MP4 video before upload", async t => {
  const root = directory(t);
  for (const kind of ["image", "file", "video"] as const) {
    const file = path.join(root, `fixture-${kind}.mp4`), limit = kind === "image" ? FEISHU_IMAGE_MAX_BYTES : FEISHU_FILE_MAX_BYTES;
    fs.writeFileSync(file, Buffer.from([1])); fs.truncateSync(file, limit);
    const valid = fixture(); await valid.adapter.client.sendMedia({ toUserId: "oc_group", kind, path: file });
    assert.equal((valid.uploads[0].data.file ?? valid.uploads[0].data.image).length, limit);
    fs.truncateSync(file, limit + 1); const large = fixture();
    await assert.rejects(large.adapter.client.sendMedia({ toUserId: "oc_group", kind, path: file }), /上限/); assert.equal(large.uploads.length, 0);
    fs.truncateSync(file, 0); const empty = fixture();
    await assert.rejects(empty.adapter.client.sendMedia({ toUserId: "oc_group", kind, path: file }), /空文件/); assert.equal(empty.uploads.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.adapter.client.sendMedia({ toUserId: "oc_group", kind: "file", path: root }), /普通文件/);
  await assert.rejects(f.adapter.client.sendMedia({ toUserId: "oc_group", kind: "video", path: path.join(root, "movie.mov") }), /MP4/);
  assert.equal(f.uploads.length, 0);
});

test("Feishu missing file API remains an explicit capability instead of a fake text or image send", async t => {
  const f = fixture({ noFiles: true });
  for (const kind of ["file", "video"] as const) {
    assert.equal(f.adapter.client.capabilities.outbound[kind], "not-implemented");
    await assert.rejects(async () => f.adapter.client.sendMedia({ toUserId: "oc_group", kind, path: "unused" }), ChannelCapabilityError);
  }
  assert.equal(f.messages.length, 0); assert.equal(f.uploads.length, 0);
});

for (const lost of [false, true]) test(`Feishu actual Bridge file/video effects preserve restart receipts (lost=${lost})`, async t => {
  const root = directory(t), store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const session = store.createSession("oc_group", root, "Result", undefined, "session", undefined, { standalone: true }); store.setSessionThread(session.id, "thread");
  const f = fixture({ lost }), service = new BridgeService({ config: defaultConfig(root), stateStore: store, runner: {} as never, channel: f.adapter.client });
  const file = path.join(root, "report.pdf"), video = path.join(root, "movie.mp4"); fs.writeFileSync(file, "document"); fs.writeFileSync(video, "video");
  const text = "Result\n```codex-im-gateway-actions\n" + JSON.stringify({ send: [{ type: "file", path: file }, { type: "video", path: video }] }) + "\n```";
  const journal = path.join(root, "effects.json"), scope = ["account", session.id, "local", "thread", "turn"];
  const effect = (action: import("../src/bridge/turn-result-actions.js").TurnResultAction) => service.applyRecoveredAction(session.id, { hostId: "local", threadId: "thread" }, action);
  assert.equal(await new TurnResultActions(journal).apply(scope, text, () => {}, effect), !lost);
  const uploads = f.uploads.length, sends = f.messages.length;
  assert.equal(uploads, 2);
  assert.equal(await new TurnResultActions(journal).apply(scope, text, () => {}, effect), !lost);
  assert.equal(f.uploads.length, uploads); assert.equal(f.messages.length, sends, "restart must not repeat unknown or confirmed messages");
  assert.deepEqual([...new Set(Object.values(JSON.parse(fs.readFileSync(journal, "utf8")).records))], [lost ? "started" : "done"]);
});

for (const kind of ["image", "file", "video"] as const) for (const outcome of ["confirmed", "upload-rejected", "missing-upload-code", "send-rejected"] as const)
  test(`Feishu installed SDK validates raw upload and send envelopes with original multipart bytes (${kind}, ${outcome})`, async t => {
  const root = directory(t), file = path.join(root, "演示 视频.mp4"), bytes = Buffer.from([0, 255, 10, 1, 128]); fs.writeFileSync(file, bytes);
  const received: Array<{ url: string; body: Buffer; type: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(chunk)); request.on("end", () => {
      received.push({ url: request.url!, body: Buffer.concat(chunks), type: String(request.headers["content-type"]) });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url?.includes("tenant_access_token")
        ? { code: 0, tenant_access_token: "isolated", expire: 7200 }
        : /\/im\/v1\/(?:files|images)/.test(request.url!) ? { ...(outcome === "missing-upload-code" ? {} : { code: outcome === "upload-rejected" ? 999 : 0 }),
          data: kind === "image" ? { image_key: "image_http" } : { file_key: "file_http" } }
          : { code: outcome === "send-rejected" ? 999 : 0, data: { message_id: "message_http" } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  // Keep SDK URL construction intact: its path-template parser treats a
  // custom domain's :port as a path variable. Reroute only the HTTP boundary.
  const local = (url: string) => origin + new URL(url).pathname + new URL(url).search;
  const http = { ...Lark.defaultHttpInstance,
    request: (options: Parameters<typeof Lark.defaultHttpInstance.request>[0]) => Lark.defaultHttpInstance.request({ ...options, url: local(options.url!), proxy: false }),
    post: (url: string, data?: unknown) => Lark.defaultHttpInstance.post(local(url), data, { proxy: false }) };
  const api = createFeishuApiClient({ appId: `fixture_${path.basename(root)}`, appSecret: "isolated" }, http);
  const adapter = new FeishuChannelAdapter(account, { apiClient: api, wsClient: { async start() {}, close() {} } });
  const send = adapter.client.sendMedia({ toUserId: "oc_group", kind, path: file });
  if (outcome === "confirmed") assert.deepEqual(await send, { messageId: "message_http" });
  else await assert.rejects(send, ChannelDeliveryError);
  const upload = received.find(item => /\/im\/v1\/(?:files|images)/.test(item.url))!;
  assert.match(upload.type, /^multipart\/form-data; boundary=/);
  assert.ok(upload.body.includes(bytes));
  if (kind !== "image") {
    assert.ok(upload.body.includes(Buffer.from(path.basename(file))));
    assert.match(upload.body.toString(), new RegExp(`name="file_type"\\r\\n\\r\\n${kind === "video" ? "mp4" : "stream"}`));
  }
  const message = received.find(item => item.url.includes("/im/v1/messages"));
  if (outcome === "upload-rejected" || outcome === "missing-upload-code") assert.equal(message, undefined, "SDK decoding cannot hide a nonzero upload code even with a plausible key");
  else assert.deepEqual(JSON.parse(message!.body.toString()), { receive_id: "oc_group", msg_type: kind === "video" ? "media" : kind,
    content: JSON.stringify(kind === "image" ? { image_key: "image_http" } : { file_key: "file_http" }) });
});
