import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadInboundAttachments } from "../src/weixin/media.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-weixin-inbound-")), inbound = path.join(root, "inbound");
  fs.mkdirSync(inbound); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const download = () => downloadInboundAttachments({ rootDir: inbound, senderId: "actor", messageId: "message", maxBytes: 100,
    attachments: [{ kind: "file", label: "input.txt", item: { file_item: { media: { full_url: "https://isolated.invalid/file" } } } }],
    fetch: async () => new Response("private body") });
  return { root, inbound, download };
}

test("downloaded WeChat attachments have private file permissions independent of the process umask", async t => {
  const f = fixture(t), previous = process.umask(0o022);
  try { const [file] = await f.download(); assert.equal(fs.statSync(file.path).mode & 0o777, 0o600); }
  finally { process.umask(previous); }
});

test("a dangling inbound filename symlink cannot redirect a downloaded body outside its account", async t => {
  const f = fixture(t), target = path.join(f.root, "outside.txt"), dir = path.join(f.inbound, "actor");
  fs.mkdirSync(dir); fs.symlinkSync(target, path.join(dir, "message-1-input.txt"));
  const [file] = await f.download();
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.lstatSync(file.path).isSymbolicLink(), false); assert.equal(fs.readFileSync(file.path, "utf8"), "private body");
});

test("a sender directory symlink cannot write downloaded contents outside the configured inbound root", async t => {
  const f = fixture(t), outside = path.join(f.root, "other-account"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.inbound, "actor"));
  await assert.rejects(f.download(), /outside|目录/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
