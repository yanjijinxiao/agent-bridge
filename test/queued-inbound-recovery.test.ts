import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";

const source = { id: "im-source", senderId: "actor", replyTargetId: "room" };
const proof = { messageId: source.id, actorId: "actor", conversationId: "room", sessionId: "session",
  hostId: "peer:node:profile", threadId: "thread", queuedSubmissionId: "native-queue" };
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-inbound-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "inbound.jsonl"); let cleanups = 0;
  const create = () => new InboundReceiptJournal(file, [], { onAccepted: () => { cleanups++; } });
  return { create, journal: create(), cleanups: () => cleanups };
}
async function uncertain(journal: InboundReceiptJournal) {
  await assert.rejects(journal.handle(source, async () => { journal.submitting({ sessionId: proof.sessionId, hostId: proof.hostId, threadId: proof.threadId }); throw Error("lost queue acknowledgement"); }));
  return journal.receipt(source.id)!;
}

for (const native of [{ queuedSubmissionId: "native-queue" }, { turnId: "consumed-turn" }])
  test(`CTRL-03.1: queue recovery settles the IM handoff with ${Object.keys(native)[0]} and no duplicate result duty`, async t => {
    const f = fixture(t); const expected = await uncertain(f.journal);
    const journal = f.create();
    assert.equal(journal.recoverQueued(expected, { ...proof, queuedSubmissionId: undefined, ...native }), true);
    const accepted = f.create().receipt(source.id)!;
    assert.equal(accepted.phase, "accepted"); assert.equal(accepted.recoveredNativeInput, undefined);
    assert.equal(journal.recoverQueued(expected, { ...proof, ...native }), false);
    assert.equal(f.cleanups(), 1); assert.equal(f.create().claim(source), false);
  });

test("CTRL-03.1: queue proof cannot cross source, actor, conversation, session, host, thread or receipt version", async t => {
  const f = fixture(t); const expected = await uncertain(f.journal);
  for (const key of ["messageId", "actorId", "conversationId", "sessionId", "hostId", "threadId"] as const)
    assert.equal(f.journal.recoverQueued(expected, { ...proof, [key]: "another" }), false, key);
  assert.equal(f.journal.recoverQueued(expected, { ...proof, queuedSubmissionId: undefined }), false);
  assert.equal(f.journal.recoverQueued({ ...expected, turnId: "newer-version" }, proof), false);
  assert.equal(f.journal.receipt(source.id)?.phase, "unconfirmed"); assert.equal(f.cleanups(), 0);
});

test("CTRL-03.1: queue recovery cannot retire a live handoff or reclassify ordinary input", async t => {
  const f = fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const work = f.journal.handle(source, async () => { f.journal.submitting({ sessionId: proof.sessionId, hostId: proof.hostId, threadId: proof.threadId }); entered.resolve(); await release.promise; });
  await entered.promise;
  assert.equal(f.journal.recoverQueued(f.journal.receipt(source.id)!, proof), false);
  release.resolve(); await work;
  const other = { ...source, id: "ordinary" };
  await assert.rejects(f.journal.handle(other, async () => {
    f.journal.capture()!.submitting({ ...proof, nativeInput: true }); throw Error("lost turn acknowledgement");
  }));
  assert.equal(f.journal.recoverQueued(f.journal.receipt(other.id)!, { ...proof, messageId: other.id }), false);
  assert.equal(f.cleanups(), 0);
});

test("CTRL-03.1: failed queue source durability retains unknown and permits exact recovery after restart", async t => {
  const f = fixture(t); const expected = await uncertain(f.journal), sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error("disk unavailable"); };
  try { assert.throws(() => f.journal.recoverQueued(expected, proof), /disk unavailable/); }
  finally { fs.fsyncSync = sync; }
  assert.deepEqual(f.journal.receipt(source.id), expected); assert.equal(f.cleanups(), 0);
  const restarted = f.create(); assert.equal(restarted.recoverQueued(expected, proof), true);
  assert.equal(f.create().receipt(source.id)?.phase, "accepted"); assert.equal(f.cleanups(), 1);
});
