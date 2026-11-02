import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AccountManager } from "../src/server/account-manager.js";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { findNativeInputReceipts } from "../src/bridge/native-input-recovery.js";
import { withPeerBackend } from "../src/peer/backend.js";
import { peerFixture, principal } from "./peer-fixture.js";
import type { CodexHistoryMessage } from "../src/codex/backend.js";

async function fixture(t: test.TestContext) {
  const f = await peerFixture(t); await f.bind();
  const source = { ...principal, clientUserMessageId: "gateway-" + "a".repeat(64) };
  const messages: CodexHistoryMessage[] = [];
  let reads = 0;
  f.run = async input => {
    messages.push({ id: "native", role: "user", text: "synthetic", clientUserMessageId: input.clientUserMessageId, turnId: "accepted" });
    await input.onTurnStarted?.({ threadId: f.thread.threadId, turnId: "accepted" });
    return { text: "done", threadId: f.thread.threadId, turnId: "accepted", raw: "" };
  };
  f.backend.getHistoryPage = async () => { reads++; return { messages }; };
  const scope = { hostId: f.ticket.hostId, threadId: f.thread.threadId };
  return { ...f, scope, source, messages, get reads() { return reads; },
    submit: (id = source.clientUserMessageId) => f.as(() => f.facade.run(f.input({ clientUserMessageId: id }))) };
}

test("original Gateway source recovers through persisted peer IDs after Connector restart without replay", async t => {
  const f = await fixture(t); await f.submit();
  assert.match(f.messages[0].clientUserMessageId!, /^peer-/);
  assert.equal((await findNativeInputReceipts(f.facade, f.scope, new Set([f.source.clientUserMessageId]))).size, 0);
  await f.reconnect(true);
  assert.deepEqual([...await f.facade.findNativeInputReceipts!(f.scope, [f.source])], [[f.source.clientUserMessageId, "accepted"]]);
  assert.equal(f.runs.length, 1);
});

test("recovery cannot borrow another actor, conversation, account or thread grant", async t => {
  const f = await fixture(t); await f.submit();
  for (const key of ["actorId", "conversationId", "accountId"] as const)
    await assert.rejects(f.facade.findNativeInputReceipts!(f.scope, [{ ...f.source, [key]: "unauthorized" }]), /未获准/);
  await assert.rejects(f.facade.findNativeInputReceipts!({ ...f.scope, threadId: "other" }, [f.source]), /selected thread/);
  for (const key of ["actorId", "conversationId"] as const)
    assert.equal((await f.facade.findNativeInputReceipts!(f.scope, [{ ...f.source, [key]: undefined }])).size, 0);
  assert.equal(f.reads, 0);
});

test("partial, ambiguous and uncorrelated native history cannot recover a peer input", async t => {
  const f = await fixture(t); await f.submit();
  const original = f.messages[0];
  f.messages.push({ ...original, id: "second", turnId: "other-turn" });
  assert.equal((await f.facade.findNativeInputReceipts!(f.scope, [f.source])).size, 0);
  f.messages.splice(0, f.messages.length, { ...original, clientUserMessageId: "another-source" });
  assert.equal((await f.facade.findNativeInputReceipts!(f.scope, [f.source])).size, 0);
  f.backend.getHistoryPage = async (_id, page) => {
    if (page?.cursor) throw Error("history unavailable");
    return { messages: [original], nextCursor: "older" };
  };
  await assert.rejects(f.facade.findNativeInputReceipts!(f.scope, [f.source]));
  assert.equal(f.runs.length, 1);
});

test("AccountManager recovers an unknown peer receipt and persists acceptance without dispatching input", async t => {
  const f = await fixture(t);
  const file = path.join(f.root, "gateway-receipts.jsonl"), journal = new InboundReceiptJournal(file);
  const message = { id: "original-message", senderId: principal.actorId, replyTargetId: principal.conversationId,
    text: "synthetic", attachments: [], raw: {} };
  let originalId = "";
  await assert.rejects(journal.handle(message, async () => {
    originalId = journal.currentId()!;
    journal.capture()!.submitting({ ...f.scope, sessionId: "session", nativeInput: true });
    await f.submit(originalId);
    throw Error("crash before Gateway acceptance");
  }));
  const restarted = new InboundReceiptJournal(file);
  assert.equal(restarted.receipt(message.id)?.phase, "unconfirmed");
  const owner = { service: {}, status: "running", controller: new AbortController() };
  const context = { entries: new Map([[principal.accountId, owner]]), inputReceipts: new Map([[principal.accountId, restarted]]),
    forwardingInboxes: new Map(), nativeInputRecoveries: new Map(), receiptsFor: () => restarted,
    runnerFor: () => f.facade, configProvider: () => ({}) };
  await Reflect.apply((AccountManager.prototype as any).recoverNativeInputs, context, [principal.accountId, f.scope.hostId, f.scope.threadId]);
  const recovered = new InboundReceiptJournal(file).receipt(message.id)!;
  assert.equal(recovered.phase, "accepted"); assert.equal(recovered.turnId, "accepted");
  assert.equal(recovered.clientUserMessageId, originalId); assert.equal(recovered.recoveredNativeInput, true);
  assert.equal(f.runs.length, 1); assert.equal(restarted.claim(message), false);
});

test("local and SSH receipt recovery keep their native source IDs", async t => {
  const f = await fixture(t);
  f.messages.push({ id: "local", role: "user", text: "synthetic", clientUserMessageId: f.source.clientUserMessageId, turnId: "local-turn" });
  const facade = withPeerBackend(f.backend, f.registry);
  for (const hostId of ["local", "ssh-device"])
    assert.deepEqual([...await facade.findNativeInputReceipts!({ ...f.scope, hostId }, [f.source])], [[f.source.clientUserMessageId, "local-turn"]]);
  assert.equal(f.runs.length, 0);
});
