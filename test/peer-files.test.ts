import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { peerFixture, principal } from "./peer-fixture.js";
import { downloadPeerFile, PeerFiles, FILE_CHUNK_BYTES, MAX_PEER_FILE_BYTES } from "../src/peer/files.js";
import type { PeerConnection } from "../src/peer/rpc.js";
import { prepareTurnSubmission } from "../src/bridge/turn-submission.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { BridgeService } from "../src/bridge/service.js";
import { parsePrompt } from "../src/bridge/format.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";

async function fixture(t: test.TestContext) {
  const f = await peerFixture(t);
  f.thread.cwd = path.join(f.root, "device-workspace"); fs.mkdirSync(f.thread.cwd);
  await f.bind();
  const options = { hostId: f.ticket.hostId, ...principal, threadId: f.thread.threadId, scope: "test-chat-session", maxBytes: MAX_PEER_FILE_BYTES };
  const input = (file: string) => ({ ...options, path: file });
  const fileCall = <T = any>(method: string, payload: unknown) => f.as(() => f.registry.invokeFile<T>(f.ticket.hostId, method, payload, options));
  const source = (bytes: Buffer | string, label = "source.bin") => { const file = path.join(f.root, label); fs.writeFileSync(file, bytes); return { path: file, label, kind: "file" as const }; };
  return { ...f, options, input, fileCall, source };
}

for (const change of ["unchanged", "revoked", "closed"] as const)
  test(`upload publication revalidates its lease after native inspection (${change})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-upload-lease-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let finishing = false, allowed = true;
    const owner = { open: true } as PeerConnection;
    const files = new PeerFiles(root, async () => {
      if (finishing) { entered.resolve(); await release.promise; }
      return { cwd: root };
    });
    t.after(() => files.close(owner));
    const grant = { id: crypto.randomUUID(), principal, hostId: "peer:test", threadId: "thread" };
    const call = (method: string, input: unknown) => files.call(grant, owner, method, input, () => {
      if (!allowed) throw Error("grant revoked");
    });
    const lease = await call("fileUploadBegin", { threadId: "thread", scope: "source", name: "result.txt", size: 1,
      hash: crypto.createHash("sha256").update("x").digest("hex") }) as { id: string };
    await call("fileUploadChunk", { id: lease.id, offset: 0, data: "eA==" });
    finishing = true;
    const pending = call("fileUploadFinish", { id: lease.id });
    const result = pending.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    if (change === "revoked") allowed = false;
    if (change === "closed") Object.defineProperty(owner, "open", { value: false });
    release.resolve(); const outcome = await result;
    const published = fs.readdirSync(root, { recursive: true }).map(String).filter(f => f.endsWith("result.txt"));
    assert.equal(published.length, change === "unchanged" ? 1 : 0);
    assert.equal("error" in outcome, change !== "unchanged");
    assert.ok(fs.readdirSync(root, { recursive: true }).every(f => !String(f).endsWith(".part")));
  });

test("files larger than the RPC frame round-trip in bounded chunks with stable paths and private temporary copies", async t => {
  const f = await fixture(t), bytes = crypto.randomBytes(2 * 1024 * 1024 + 17), file = f.source(bytes);
  file.label = "../../中文材料.bin";
  const [staged] = await f.as(() => f.facade.stageAttachments!([file], f.options));
  assert.notEqual(staged.path, file.path); assert.ok(staged.path.startsWith(fs.realpathSync(path.join(f.root, "client", "files", "inbound"))), staged.path);
  assert.deepEqual(fs.readFileSync(staged.path), bytes); assert.equal(fs.statSync(staged.path).mode & 0o777, 0o600);
  const mtime = fs.statSync(staged.path).mtimeMs;
  assert.equal((await f.as(() => f.facade.stageAttachments!([file], f.options)))[0].path, staged.path);
  assert.equal(fs.statSync(staged.path).mtimeMs, mtime, "Retry must reuse the verified content-addressed attachment");
  const copy = await f.as(() => f.facade.fetchOutputFile!(staged.path, f.options));
  assert.notEqual(copy.path, staged.path); assert.deepEqual(fs.readFileSync(copy.path), bytes);
  assert.equal(path.basename(copy.path), "中文材料.bin");
  assert.equal(fs.statSync(copy.path).mode & 0o777, 0o600);
  await copy.dispose(); assert.equal(fs.existsSync(copy.path), false); assert.equal(fs.existsSync(staged.path), true);
  assert.equal(f.runs.length, 0, "File transfer must never execute Codex");
});

test("empty files and Unicode names survive staging and checksum verification", async t => {
  const f = await fixture(t), file = f.source("", "空文件.txt");
  const [staged] = await f.as(() => f.facade.stageAttachments!([file], f.options));
  assert.equal(fs.statSync(staged.path).size, 0);
  const copy = await f.facade.fetchOutputFile!(staged.path, f.options);
  assert.equal(fs.statSync(copy.path).size, 0); await copy.dispose();
});

test("chat identity, fixed thread grants and configured size limits apply to both transfer directions", async t => {
  const f = await fixture(t), file = f.source("test file");
  await assert.rejects(f.facade.stageAttachments!([file], f.options), /authorized chat identity/);
  for (const who of [{ ...principal, actorId: "other" }, { ...principal, conversationId: "other" }, { ...principal, accountId: "other" }]) {
    await assert.rejects(f.as(() => f.facade.stageAttachments!([file], f.options), who), /authoriz/);
    await assert.rejects(f.as(() => f.facade.fetchOutputFile!(file.path, f.options), who), /authoriz/);
  }
  await assert.rejects(f.facade.fetchOutputFile!(file.path, { ...f.options, conversationId: "another-chat" }), /authoriz/);
  await assert.rejects(f.as(() => f.facade.stageAttachments!([file], { ...f.options, threadId: "other-thread" })), /authoriz/);
  await assert.rejects(f.as(() => f.facade.stageAttachments!([file], { ...f.options, maxBytes: 2 })), /limit/);
  const output = path.join(f.thread.cwd!, "output.txt"); fs.writeFileSync(output, "too big");
  await assert.rejects(f.facade.fetchOutputFile!(output, { ...f.options, maxBytes: 2 }), /limit/);
  await assert.rejects(f.fileCall("fileUploadBegin", { threadId: f.thread.threadId, scope: "test", name: "x", size: MAX_PEER_FILE_BYTES + 1, hash: "0".repeat(64) }));
});

test("output downloads reject paths and symlinks outside the selected workspace", async t => {
  const f = await fixture(t), outside = f.source("private data", "outside.txt").path;
  const link = path.join(f.thread.cwd!, "link.txt"); fs.symlinkSync(outside, link);
  for (const file of [outside, link, path.join(f.thread.cwd!, "..", "outside.txt")])
    await assert.rejects(f.facade.fetchOutputFile!(file, f.options), /selected session workspace/);
  await assert.rejects(f.facade.fetchOutputFile!("relative.txt", f.options), /absolute/);
  await assert.rejects(f.facade.fetchOutputFile!(f.thread.cwd!, f.options));
  const regular = path.join(f.thread.cwd!, "output.txt"); fs.writeFileSync(regular, "safe output");
  const copy = await f.facade.fetchOutputFile!(regular, f.options);
  assert.equal(fs.readFileSync(copy.path, "utf8"), "safe output"); await copy.dispose();
});

test("corrupt, partial, out-of-order and oversized chunks never publish an attachment", async t => {
  const f = await fixture(t);
  const begin = () => f.fileCall<{ id: string }>("fileUploadBegin", { threadId: f.thread.threadId, scope: "test", name: "result.txt", size: 4, hash: crypto.createHash("sha256").update("good").digest("hex") });
  let lease = await begin();
  await f.fileCall("fileUploadChunk", { id: lease.id, offset: 0, data: Buffer.from("evil").toString("base64") });
  await assert.rejects(f.fileCall("fileUploadFinish", { id: lease.id }), /checksum/);
  lease = await begin(); await assert.rejects(f.fileCall("fileUploadFinish", { id: lease.id }), /incomplete/);
  lease = await begin(); await assert.rejects(f.fileCall("fileUploadChunk", { id: lease.id, offset: 1, data: "Zw==" }), /offset/);
  lease = await begin(); await assert.rejects(f.fileCall("fileUploadChunk", { id: lease.id, offset: 0, data: Buffer.alloc(FILE_CHUNK_BYTES + 1).toString("base64") }));
  await assert.rejects(f.fileCall("fileClose", { id: lease.id }), /expired/);
  const files = fs.readdirSync(path.join(f.root, "client", "files"), { recursive: true }).map(String);
  assert.ok(files.every(file => !file.endsWith("result.txt") && !file.endsWith(".part")));
});

test("uploads cannot follow a substituted storage directory and incomplete leases are removed on disconnect", async t => {
  const f = await fixture(t), file = f.source("attachment");
  const outside = path.join(f.root, "substituted"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.root, "client", "files"));
  await assert.rejects(f.as(() => f.facade.stageAttachments!([file], f.options)), /unavailable/);
  assert.deepEqual(fs.readdirSync(outside), []); fs.unlinkSync(path.join(f.root, "client", "files"));
  const lease = await f.fileCall<{ id: string }>("fileUploadBegin", { threadId: f.thread.threadId, scope: "test", name: "x", size: 10, hash: "0".repeat(64) });
  await f.fileCall("fileUploadChunk", { id: lease.id, offset: 0, data: Buffer.from("partial").toString("base64") });
  await f.reconnect();
  assert.ok(fs.readdirSync(path.join(f.root, "client", "files"), { recursive: true }).every(file => !String(file).endsWith(".part")));
  await assert.rejects(f.fileCall("fileUploadFinish", { id: lease.id }), /expired/);
});

test("an attachment prompt contains the device path and an action returns actual device bytes through the channel", async t => {
  const f = await fixture(t), source = f.source("DingTalk attachment body", "材料.txt");
  const paths = resolveStatePaths(path.join(f.root, "bridge-state")), store = new RuntimeStateStore(paths);
  const session = store.createSession(principal.conversationId, f.thread.cwd!, "File test", undefined, "session", undefined,
    { standalone: true, hostId: f.ticket.hostId });
  store.setSessionThread(session.id, f.thread.threadId);
  const selected = store.getSession(session.id)!;
  const prepared = await f.as(() => prepareTurnSubmission({ runner: f.facade, session: selected, config: defaultConfig(paths.root),
    accountId: principal.accountId, conversationId: principal.conversationId, text: "检查附件", items: [source], source: "DingTalk" }));
  assert.ok(prepared.prompt.includes(path.join(f.root, "client", "files", "inbound"))); assert.ok(!prepared.prompt.includes(source.path));
  assert.equal(parsePrompt([prepared.developerInstructions, prepared.prompt].join("\n\n")).text, "检查附件");
  const output = path.join(f.thread.cwd!, "generated.txt"); fs.writeFileSync(output, "device output body");
  const replies: string[] = [], delivered: Buffer[] = [], copies: string[] = [];
  const channel = createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, outbound: { ...TEXT_CAPABILITIES.outbound, file: "available" } }, {
    async sendText(input) { replies.push(input.text); return { messageId: crypto.randomUUID() }; },
    async sendMedia(input) { copies.push(input.path); delivered.push(fs.readFileSync(input.path)); return { messageId: "file-ack" }; }
  });
  const service = new BridgeService({ accountId: principal.accountId, stateStore: store, runner: f.facade, channel,
    config: { ...defaultConfig(paths.root), allowedSenderIds: [principal.actorId], streamReplies: false } });
  t.after(() => service.suspendUserInputs());
  const action = { kind: "send" as const, value: { type: "file" as const, path: output } };
  await service.applyRecoveredAction(selected.id, { hostId: f.ticket.hostId, threadId: f.thread.threadId }, action);
  assert.deepEqual(delivered, [Buffer.from("device output body")]); assert.equal(replies.length, 0);
  assert.notEqual(copies[0], output); assert.equal(fs.existsSync(copies[0]), false, "Gateway temporary copy is removed after channel acknowledgement");
});

test("a different approved chat cannot consume or cancel another chat's transfer", async t => {
  const f = await fixture(t), ticket = await f.reconnect(), other = { ...principal, conversationId: "another-approved-chat" };
  await f.registry.connect(ticket.code, other, () => {});
  const lease = await f.fileCall<{ id: string }>("fileUploadBegin", { threadId: f.thread.threadId, scope: "test", name: "x", size: 1,
    hash: crypto.createHash("sha256").update("x").digest("hex") });
  await assert.rejects(f.as(() => f.registry.invokeFile(f.ticket.hostId, "fileClose", { id: lease.id }, { ...f.options, conversationId: other.conversationId }), other), /another connection or chat/);
  await f.fileCall("fileUploadChunk", { id: lease.id, offset: 0, data: "eA==" });
  const complete = await f.fileCall<{ path: string }>("fileUploadFinish", { id: lease.id });
  assert.equal(fs.readFileSync(complete.path, "utf8"), "x");
});

test("modified output and corrupted download bytes are rejected without leaving a live descriptor lease", async t => {
  const f = await fixture(t), file = path.join(f.thread.cwd!, "output.txt"); fs.writeFileSync(file, "original");
  const lease = await f.fileCall<{ id: string }>("fileDownloadBegin", { threadId: f.thread.threadId, path: file, maxBytes: 100 });
  fs.writeFileSync(file, "modified"); fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  await assert.rejects(f.fileCall("fileDownloadChunk", { id: lease.id, offset: 0 }), /changed/);
  await assert.rejects(f.fileCall("fileClose", { id: lease.id }), /expired/);
  let id: string | undefined;
  await assert.rejects(downloadPeerFile(f.thread.threadId, file, 100, async <T>(method: string, payload: unknown): Promise<T> => {
    const result = await f.fileCall<any>(method, payload);
    if (method === "fileDownloadBegin") id = result.id;
    if (method === "fileDownloadChunk") result.data = Buffer.from("tampered").toString("base64");
    return result as T;
  }), /checksum/);
  assert.ok(id); await assert.rejects(f.fileCall("fileClose", { id }), /expired/);
});

test("transfer concurrency is bounded and an old Connector gets an explicit upgrade error", async t => {
  const f = await fixture(t), leases: Array<{ id: string }> = [];
  for (let n = 0; n < 8; n++) leases.push(await f.fileCall("fileUploadBegin", { threadId: f.thread.threadId, scope: "test", name: `file${n}`, size: 0, hash: "0".repeat(64) }));
  await assert.rejects(f.fileCall("fileUploadBegin", { threadId: f.thread.threadId, scope: "test", name: "ninth", size: 0, hash: "0".repeat(64) }), /Too many/);
  for (const lease of leases) await f.fileCall("fileClose", { id: lease.id });
  delete f.registry.description(f.ticket.hostId).files;
  await assert.rejects(f.as(() => f.facade.stageAttachments!([f.source("x")], f.options)), /更新 Connector/);
  await assert.rejects(f.facade.fetchOutputFile!("/nonexistent", f.options), /更新 Connector/);
});

for (const failure of ["channel-send", "binding-changed"] as const) test(`Gateway output copies are removed on ${failure}`, async t => {
  const f = await fixture(t), paths = resolveStatePaths(path.join(f.root, "bridge-state")), store = new RuntimeStateStore(paths);
  const session = store.createSession(principal.conversationId, f.thread.cwd!, "File test", undefined, "session", undefined,
    { standalone: true, hostId: f.ticket.hostId });
  store.setSessionThread(session.id, f.thread.threadId);
  const output = path.join(f.thread.cwd!, "output.txt"); fs.writeFileSync(output, "output");
  let copyPath = "", sent = 0; const replies: string[] = [];
  const runner = new Proxy(f.facade, { get(target, key) {
    if (key === "fetchOutputFile") return async (...args: Parameters<NonNullable<typeof target.fetchOutputFile>>) => {
      const copy = await target.fetchOutputFile!(...args); copyPath = copy.path;
      if (failure === "binding-changed") store.leaveSession(principal.conversationId);
      return copy;
    };
    return Reflect.get(target, key);
  } });
  const service = new BridgeService({ accountId: principal.accountId, stateStore: store, runner,
    config: { ...defaultConfig(paths.root), allowedSenderIds: [principal.actorId], streamReplies: false },
    channel: createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, outbound: { ...TEXT_CAPABILITIES.outbound, file: "available" } }, {
      async sendText(input) { replies.push(input.text); return { messageId: crypto.randomUUID() }; },
      async sendMedia() { sent++; throw new Error("Synthetic channel failure"); }
    }) });
  t.after(() => service.suspendUserInputs());
  await assert.rejects(service.applyRecoveredAction(session.id, { hostId: f.ticket.hostId, threadId: f.thread.threadId },
    { kind: "send", value: { type: "file", path: output } }), /Result media delivery was not confirmed/);
  assert.ok(copyPath); assert.equal(fs.existsSync(copyPath), false); assert.equal(sent, failure === "binding-changed" ? 0 : 1);
  // Detached conversations must not receive a late failure notice either.
  if (failure === "binding-changed") assert.deepEqual(replies, []);
  else assert.ok(replies.some(text => text.includes("Failed to send file")));
});
