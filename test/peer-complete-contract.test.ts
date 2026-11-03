import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { peerFixture, principal } from "./peer-fixture.js";
import { guardNativeWrite } from "../src/codex/write-guard.js";
import { CodexQueueAdmissionError, type CodexBridgeBackend, type CodexQueueAddInput } from "../src/codex/backend.js";
import { PeerRecoveryJournal } from "../src/peer/recovery-journal.js";
import { withPeerBackend } from "../src/peer/backend.js";
import { PEER_BACKEND_CONTRACT } from "../src/peer/contract.js";

test("all public backend ports have an explicit peer transport policy", () => {
  assert.equal(Object.keys(PEER_BACKEND_CONTRACT).length, 51);
  assert.deepEqual(Object.entries(PEER_BACKEND_CONTRACT).filter(([, policy]) => policy === "gateway-local").map(([method]) => method), ["runEphemeral"]);
});

test("queue callbacks remain live after queue/add returns and retain original request objects", async t => {
  const f = await peerFixture(t); await f.bind(); let queued!: CodexQueueAddInput;
  f.backend.addQueuedSubmission = async input => { queued = input; return { id: "queued", clientUserMessageId: input.clientUserMessageId, input: [] }; };
  const seen: unknown[] = [], confirmed: unknown[] = [], accepted: string[] = [];
  await f.as(() => f.facade.addQueuedSubmission!({ threadId: f.thread.threadId, prompt: "later", clientUserMessageId: "late-source",
    onAccepted: turn => { accepted.push(turn); }, onApproval: async request => { seen.push(request); return "accept"; },
    onApprovalResult: (request, result) => { confirmed.push([request, result]); } }, f.ticket.hostId));
  await queued.onAccepted!("late-turn");
  const request = { kind: "command" as const, threadId: f.thread.threadId, turnId: "late-turn", itemId: "late-item", command: "pwd" };
  assert.equal(await queued.onApproval!(request), "accept");
  await queued.onApprovalResult!(request, "confirmed");
  assert.deepEqual(accepted, ["late-turn"]); assert.equal((confirmed[0] as any)[0], seen[0]);
  f.client.close(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await queued.onApproval!(request), undefined, "a disconnected callback cannot manufacture a rejection");
});

test("queue admission classification survives RPC and a definitive rejection may be retried", async t => {
  const f = await peerFixture(t); await f.bind(); let writes = 0;
  f.backend.addQueuedSubmission = async () => { throw new CodexQueueAdmissionError("not submitted"); };
  const input = { threadId: f.thread.threadId, prompt: "one", clientUserMessageId: "source" };
  await assert.rejects(f.as(() => f.facade.addQueuedSubmission!(input, f.ticket.hostId)), CodexQueueAdmissionError);
  f.backend.addQueuedSubmission = async value => { writes++; return { id: "q", clientUserMessageId: value.clientUserMessageId, input: [] }; };
  assert.equal((await f.as(() => f.facade.addQueuedSubmission!(input, f.ticket.hostId))).id, "q");
  assert.equal((await f.as(() => f.facade.addQueuedSubmission!(input, f.ticket.hostId))).id, "q");
  assert.equal(writes, 1);
});

for (const method of ["resumeAfterCapacity", "recoverSystemError"] as const) test(`${method} rechecks the source after native preparation`, async t => {
  const f = await peerFixture(t); await f.bind();
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let writes = 0, current = true;
  (f.backend as any)[method] = async (input: any) => { ready.resolve(); await release.promise; await guardNativeWrite(input.assertCurrent, async () => { writes++; }); return {}; };
  const guard = () => { if (!current) throw Error("revoked"); };
  const input = { threadId: f.thread.threadId, hostId: f.ticket.hostId, failedTurnId: "failed", clientUserMessageId: "resume", assertCurrent: guard, onTurnStarted() {} };
  const work = f.as(() => method === "resumeAfterCapacity" ? f.facade.resumeAfterCapacity!(input)
    : f.facade.recoverSystemError!({ threadId: input.threadId, failedTurnId: input.failedTurnId, assertCurrent: guard }, f.ticket.hostId));
  const rejected = assert.rejects(work); await ready.promise; current = false; release.resolve(); await rejected; assert.equal(writes, 0);
});

test("background recovery requires a concrete authorized source, not any paired actor", async t => {
  const f = await peerFixture(t); await f.bind(); let writes = 0;
  f.backend.recoverSystemError = async input => { await guardNativeWrite(input.assertCurrent, async () => { writes++; }); return { status: "recovered" }; };
  const input = { threadId: f.thread.threadId, failedTurnId: "failed", assertCurrent() {} };
  await assert.rejects(f.facade.recoverSystemError!(input, f.ticket.hostId)); assert.equal(writes, 0);
  let current = true;
  const scoped = withPeerBackend(f.backend, f.registry, () => ({ source: principal, assertCurrent() { if (!current) throw Error("revoked"); } }));
  assert.equal((await scoped.recoverSystemError!(input, f.ticket.hostId)).status, "recovered");
  current = false; await assert.rejects(scoped.recoverSystemError!(input, f.ticket.hostId)); assert.equal(writes, 1);
});

test("device rollback journal survives restart and never grants a new turn", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-restore-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  new PeerRecoveryJournal(root).start("thread", "failed");
  const reloaded = new PeerRecoveryJournal(root); let restored = 0;
  await reloaded.restorePending({ async recoverSystemError(input) {
    assert.equal(input.lifecycle?.restoring, true); assert.throws(input.lifecycle!.beforeArchive);
    restored++; await input.lifecycle!.restored(); input.assertCurrent(); return { status: "recovered" };
  } } as CodexBridgeBackend);
  assert.equal(restored, 1); assert.equal(new PeerRecoveryJournal(root).get("thread", "failed")?.restored, true);
  reloaded.acknowledged("thread"); assert.equal(new PeerRecoveryJournal(root).get("thread", "failed"), undefined);
});

test("runtime query preserves the metadata observation options", async t => {
  const f = await peerFixture(t); await f.bind(); let received: unknown, inspected: unknown;
  const inspect = f.backend.inspectThread.bind(f.backend);
  f.backend.inspectThread = async (id, host, observation) => { inspected = observation; return inspect(id, host, observation); };
  f.backend.getRuntimeInfo = async (_cwd, _id, _host, observation) => { received = observation; return {}; };
  const observation = { timeoutMs: 1234, purpose: "status" as const };
  await f.as(() => f.facade.getRuntimeInfo(f.thread.cwd!, f.thread.threadId, f.ticket.hostId, observation));
  assert.deepEqual(received, observation);
  assert.deepEqual(inspected, { ...observation, includeTurns: false });
});

test("optional native results retain undefined across JSON transport", async t => {
  const f = await peerFixture(t); await f.bind();
  f.backend.getGoal = async () => undefined;
  f.backend.setGoal = async () => undefined;
  f.backend.readThreadProvenance = async () => undefined;
  assert.equal(await f.as(() => f.facade.getGoal(f.thread.threadId, f.ticket.hostId)), undefined);
  assert.equal(await f.as(() => f.facade.setGoal(f.thread.threadId, { objective: "goal" }, f.ticket.hostId)), undefined);
  assert.equal(await f.as(() => f.facade.readThreadProvenance!(f.thread.threadId, f.ticket.hostId)), undefined);
});

test("native queue cancellation releases callbacks without answering pending approval", async t => {
  const f = await peerFixture(t); await f.bind(); let queued!: CodexQueueAddInput;
  f.backend.addQueuedSubmission = async input => { queued = input; return { id: "cancelled", clientUserMessageId: input.clientUserMessageId, input: [] }; };
  f.backend.deleteQueuedSubmission = async () => true;
  let asked = 0;
  await f.as(() => f.facade.addQueuedSubmission!({ threadId: f.thread.threadId, prompt: "later", clientUserMessageId: "cancel-source",
    onApproval: async () => { asked++; return "accept"; } }, f.ticket.hostId));
  await f.as(() => f.facade.deleteQueuedSubmission!(f.thread.threadId, "cancelled", f.ticket.hostId));
  await queued.onAccepted!("already-retired");
  assert.equal(await queued.onApproval!({ kind: "command", threadId: f.thread.threadId, turnId: "already-retired", itemId: "i", command: "pwd" }), undefined);
  assert.equal(asked, 0);
});

test("native execution options pass through without inventing a dynamic tool handler", async t => {
  const f = await peerFixture(t); await f.bind(); f.thread.cwd = f.root; let received: any;
  f.backend.run = async input => { received = input; return { threadId: input.threadId, text: "done", raw: "" }; };
  const options = { outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    nativeSettings: { sandbox: "workspace-write" as const, approvalPolicy: "on-request" as const, approvalsReviewer: "user" as const, runtimeWorkspaceRoots: [f.thread.cwd!] } };
  await f.as(() => f.facade.run({ threadId: f.thread.threadId, cwd: f.thread.cwd!, hostId: f.ticket.hostId, prompt: "schema", ...options }));
  assert.deepEqual(received.outputSchema, options.outputSchema);
  assert.deepEqual(received.nativeSettings, options.nativeSettings);
  assert.equal(received.onDynamicToolCall, undefined);
  await assert.rejects(f.as(() => f.facade.run({ threadId: f.thread.threadId, cwd: f.thread.cwd!, hostId: f.ticket.hostId,
    prompt: "image", imagePaths: [process.execPath] })), /outside the granted workspace/);
});

test("capacity snapshot restores its original source receipt", async t => {
  const f = await peerFixture(t); await f.bind(); let nativeId = "";
  f.backend.resumeAfterCapacity = async input => { nativeId = input.clientUserMessageId; return { threadId: input.threadId, text: "done", raw: "" }; };
  await f.as(() => f.facade.resumeAfterCapacity!({ hostId: f.ticket.hostId, threadId: f.thread.threadId, failedTurnId: "failed", clientUserMessageId: "capacity-original", assertCurrent() {} }));
  f.backend.readThreadSnapshot = async () => ({ state: f.thread, turns: [{ id: "resumed", status: "completed", messages: [{ role: "user", text: "resume", clientUserMessageId: nativeId }] }] });
  const snapshot = await f.as(() => f.facade.readThreadSnapshot(f.thread.threadId, f.ticket.hostId));
  assert.equal(snapshot.turns[0].messages[0].clientUserMessageId, "capacity-original");
});

 test("source translation separates actor queues from the thread capacity coordinator", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-receipts-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { PeerReceipts } = await import("../src/peer/receipts.js");
  const receipts = new PeerReceipts(path.join(root, "receipts.json"));
  receipts.begin("capacity", "a", "thread", "resumeAfterCapacity", { sourceId: "capacity-original", principal: "actor-a" });
  receipts.begin("queue", "b", "thread", "addQueuedSubmission", { sourceId: "queue-original", principal: "actor-a" });
  assert.equal(receipts.originalSource("peer-capacity", "actor-b", "thread"), "capacity-original");
  assert.equal(receipts.originalSource("peer-capacity", "actor-b", "other-thread"), "peer-capacity");
  assert.equal(receipts.originalSource("peer-queue", "actor-b", "thread"), "peer-queue");
  assert.equal(receipts.originalSource("peer-queue", "actor-a", "thread"), "queue-original");
});

 test("queue reconciliation preserves each actor source on the same native thread", async t => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const { NativeQueueCoordinator } = await import("../src/bridge/native-queue.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-queue-actors-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = new AsyncLocalStorage<{ actorId: string }>();
  const journal = new NativeQueueCoordinator(path.join(root, "queue.json"));
  const items: any[] = []; let history = false;
  const backend = { backendInfo: () => ({ id: "app-server", capabilities: { nativeQueue: true } }),
    withSource: (identity: { actorId: string }, action: () => any) => source.run(identity, action),
    addQueuedSubmission: async (input: any) => { const item = { id: String(items.length), clientUserMessageId: input.clientUserMessageId, input: [], owner: source.getStore()!.actorId }; items.push(item); return item; },
    listQueuedSubmissions: async () => ({ data: history ? [] : items.map(item => ({ ...item, clientUserMessageId: item.owner === source.getStore()?.actorId ? item.clientUserMessageId : "opaque-foreign" })) }),
    getHistoryPage: async () => ({ messages: items.filter(item => item.owner === source.getStore()?.actorId).map(item => ({ role: "user", text: "same", turnId: "turn-" + item.id, clientUserMessageId: item.clientUserMessageId })) }),
    readTurnLifecycle: async () => ({ status: "completed", source: "owner" }) } as unknown as CodexBridgeBackend;
  for (const actorId of ["one", "two"]) await source.run({ actorId }, () => journal.enqueue({ accountId: "bot", conversationId: "room", actorId, messageId: actorId, sessionId: "session", hostId: "peer:device", backend: "app-server", threadId: "thread" }, "same", backend));
  await journal.reconcile("bot", backend);
  assert.deepEqual(journal.list("bot").map(row => row.status), ["queued", "queued"]);
  history = true; await journal.reconcile("bot", backend);
  assert.deepEqual(journal.list("bot").map(row => row.status), ["completed", "completed"]);
});

 test("a queue delete that did not remove the item preserves its later callbacks", async t => {
  const f = await peerFixture(t); await f.bind(); let queued!: CodexQueueAddInput, asked = 0;
  f.backend.addQueuedSubmission = async input => { queued = input; return { id: "not-deleted", clientUserMessageId: input.clientUserMessageId, input: [] }; };
  f.backend.deleteQueuedSubmission = async () => false;
  await f.as(() => f.facade.addQueuedSubmission!({ threadId: f.thread.threadId, prompt: "later", clientUserMessageId: "delete-missed",
    onApproval: async () => { asked++; return "accept"; } }, f.ticket.hostId));
  assert.equal(await f.as(() => f.facade.deleteQueuedSubmission!(f.thread.threadId, "not-deleted", f.ticket.hostId)), false);
  await queued.onAccepted!("consumed-before-delete");
  assert.equal(await queued.onApproval!({ kind: "command", threadId: f.thread.threadId, turnId: "consumed-before-delete", itemId: "i", command: "pwd" }), "accept");
  assert.equal(asked, 1);
});
