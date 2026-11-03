import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WeComChannelAdapter } from "../src/channels/wecom.js";
import { decodeWeComContent, decodeWeComQuote, resolveWeComAttachments } from "../src/channels/wecom-inbound.js";
import type { ChannelMessage } from "../src/channels/message.js";

const key = Buffer.alloc(32, 7), aeskey = key.toString("base64");
function encrypted(bytes: Buffer) {
  const padding = 32 - bytes.length % 32;
  const cipher = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([bytes, Buffer.alloc(padding, padding)])), cipher.final()]);
}
const fixture = (type = "file"): ChannelMessage => ({ id: "message", senderId: "human", text: "", raw: {},
  attachments: decodeWeComContent({ msgtype: type, [type]: { url: "https://wecom.test.invalid/asset?ticket=private", aeskey } }).attachments });

for (const kind of ["image", "file", "video"] as const) test(`WeCom ${kind} decrypts exact binary bytes only after explicit attachment resolution`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-inbound-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("完整二进制\0\xff\r\n"), socket = new EventEmitter() as any;
  socket.connect = () => {}; socket.disconnect = () => {}; socket.sendMessage = async () => { throw Error("not used"); };
  let downloads = 0, claims = 0;
  const got = Promise.withResolvers<ChannelMessage>();
  const adapter = new WeComChannelAdapter({ botId: "synthetic", secret: "synthetic" } as never, { inboundDir: root, wsClient: socket, maxInboundBytes: 1024,
    fetch: async () => { downloads++; return new Response(encrypted(bytes), { headers: { "Content-Disposition": "attachment; filename*=UTF-8''%E8%B5%84%E6%96%99.bin" } }); } });
  const signal = new AbortController(); t.after(() => signal.abort());
  const monitor = adapter.monitor({ signal: signal.signal, claimMessage: () => { claims++; return true; }, onMessage: async m => { got.resolve(m); } });
  socket.emit(`message.${kind}`, { body: { msgid: "msg", chattype: "group", chatid: "group", from: { userid: "human" }, msgtype: kind,
    [kind]: { url: "https://wecom.test.invalid/file", aeskey }, quote: { msgtype: "text", text: { content: "/stop" } } } });
  const message = await got.promise;
  assert.equal(claims, 1); assert.equal(downloads, 0, "admission decides before downloading");
  assert.equal(message.text, ""); assert.equal(message.references?.[0].text, "/stop"); assert.equal(message.replyTargetId, "group");
  const resolved = await adapter.client.resolveAttachments(message);
  assert.equal(downloads, 1); assert.equal(resolved.length, 1); assert.equal(resolved[0].label, "资料.bin");
  assert.deepEqual(fs.readFileSync(resolved[0].path!), bytes); assert.equal(fs.statSync(resolved[0].path!).mode & 0o777, 0o600);
  assert.deepEqual(resolved[0].item, {}, "signed URL and decryption key leave the resolved envelope");
  signal.abort(); await monitor;
  for (const type of ["text", "image", "mixed", "file", "video", "voice"]) assert.equal(socket.listenerCount(`message.${type}`), 0);
});

test("WeCom mixed/voice/quoted input preserves command boundaries and unsupported metadata", () => {
  const mixed = decodeWeComContent({ msgtype: "mixed", mixed: { msg_item: [
    { msgtype: "text", text: { content: "explain @Alice" } },
    { msgtype: "image", image: { url: "https://wecom.test.invalid/image", aeskey } },
    { msgtype: "text", text: { content: "and @Bob" } }
  ] } });
  assert.equal(mixed.text, "explain @Alice\nand @Bob"); assert.equal(mixed.attachments.length, 1);
  const quoted = decodeWeComQuote({ msgtype: "mixed", mixed: { msg_item: [{ msgtype: "text", text: { content: "/approve A1 accept" } }] } });
  assert.equal(quoted?.[0].text, "/approve A1 accept"); assert.equal(quoted?.[0].availability, "available");
  assert.equal(decodeWeComQuote({ msgtype: "file" })?.[0].availability, "metadata-only");
  assert.deepEqual(decodeWeComContent({ msgtype: "voice", voice: { content: "speech transcript" } }), { text: "speech transcript", attachments: [] });
  assert.equal(decodeWeComContent({ msgtype: "unsupported" }).unsupportedMessageType, "unsupported");
  assert.throws(() => decodeWeComContent({ msgtype: "mixed", mixed: { msg_item: [{ msgtype: "mixed", mixed: { msg_item: [] } }] } }), /无效/);
});

for (const failure of ["missing-key", "insecure-url", "oversize", "corrupt", "http", "timeout", "storage", "partial-write", "second-file"] as const)
  test(`WeCom inbound ${failure} never returns partial content or leaks signed credentials`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-inbound-error-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const message = fixture(); let calls = 0;
    if (failure === "missing-key") delete message.attachments[0].item.aeskey;
    if (failure === "insecure-url") message.attachments[0].item.url = "http://wecom.test.invalid/asset";
    if (failure === "second-file") message.attachments.push({ ...message.attachments[0] });
    const dir = path.join(root, "files"); if (failure === "storage") fs.writeFileSync(dir, "not a directory");
    if (failure === "partial-write") {
      const original = fs.writeFileSync;
      t.mock.method(fs, "writeFileSync", (file: fs.PathOrFileDescriptor, ...args: any[]) => {
        if (typeof file === "number") {
          fs.writeSync(file, Buffer.from("partial")); throw Object.assign(Error("isolated disk full"), { code: "ENOSPC" });
        }
        return (original as any)(file, ...args);
      });
    }
    const request: typeof fetch = async () => {
      calls++;
      if (failure === "timeout") return new Promise<Response>(() => {});
      if (failure === "http" || failure === "second-file" && calls === 2) return new Response(null, { status: 403 });
      if (failure === "corrupt") return new Response(Buffer.from("invalid AES"));
      return new Response(encrypted(Buffer.alloc(failure === "oversize" ? 1000 : 4)));
    };
    await assert.rejects(resolveWeComAttachments(message, { inboundDir: dir, maxInboundBytes: 100, fetch: request, timeoutMs: 20 }), error => {
      assert.match(String(error), /消息未提交/); assert.doesNotMatch(String(error), /private|ticket|https|BwcH/); return true;
    });
    if (["missing-key", "insecure-url"].includes(failure)) assert.equal(calls, 0);
    if (failure !== "storage" && fs.existsSync(dir)) assert.deepEqual(fs.readdirSync(dir), []);
  });
