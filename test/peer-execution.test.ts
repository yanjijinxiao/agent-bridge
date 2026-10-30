import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CodexBackendCapabilityError } from "../src/codex/backend.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { PeerError } from "../src/peer/rpc.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { withPeerBackend } from "../src/peer/backend.js";
import { peerFixture, principal } from "./peer-fixture.js";

test("one-use pairing requires device confirmation and scopes grants to bot, chat and actor", async t => {
  const f = await peerFixture(t);
  const target = await f.bind(); assert.equal(target.hostId, f.ticket.hostId);
  await assert.rejects(f.bind(), /已过期/);
  assert.deepEqual(f.registry.hosts(principal), [target.hostId]);
  for (const who of [{ ...principal, actorId: "other" }, { ...principal, conversationId: "other" }, { ...principal, accountId: "other" }]) {
    assert.deepEqual(f.registry.hosts(who), []);
    await assert.rejects(f.as(() => f.facade.run(f.input()), who), (error: unknown) => error instanceof PeerError && error.code === "access");
  }
  assert.equal(f.runs.length, 0);
  await assert.rejects(f.facade.run(f.input()), /未获准/); // No authenticated entry context.
});

test("local refusal or a changed chat guard leaves the original binding ungranted", async t => {
  const f = await peerFixture(t, { approve: async () => false });
  await assert.rejects(f.bind(), /未确认/); assert.deepEqual(f.registry.hosts(principal), []);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const second = await peerFixture(t, { approve: async () => { entered.resolve(); await release.promise; return true; } });
  let current = true;
  const binding = second.bind(principal, () => { if (!current) throw Error("chat changed"); });
  const rejected = assert.rejects(binding, /chat changed/);
  await entered.promise; current = false; release.resolve(); await rejected;
  assert.deepEqual(second.registry.hosts(principal), []);
});

test("native execution and progress, approval and question callbacks round-trip over the outbound connection", async t => {
  const f = await peerFixture(t); await f.bind(); const events: string[] = [];
  f.run = async input => {
    input.assertCurrent?.(); assert.equal(input.hostId, undefined); assert.equal(input.model, undefined);
    await input.onTurnStarted?.({ threadId: f.thread.threadId, turnId: "native-turn" });
    await input.onDelta?.("partial"); await input.onProgress?.("working");
    assert.equal(await input.onApproval?.({ kind: "command", threadId: f.thread.threadId, turnId: "native-turn", itemId: "approval", command: "pwd" }), "accept");
    assert.deepEqual(await input.onUserInput?.({ threadId: f.thread.threadId, turnId: "native-turn", itemId: "question", questions: [] }), { answer: { answers: ["yes"] } });
    return { text: "remote result", threadId: f.thread.threadId, turnId: "native-turn", raw: "not-forwarded" };
  };
  const result = await f.as(() => f.facade.run(f.input({
    assertCurrent: () => { events.push("guard"); }, onTurnStarted: () => { events.push("accepted"); },
    onDelta: text => { events.push(text); }, onProgress: text => { events.push(text); },
    onApproval: request => { assert.equal(request.hostId, f.ticket.hostId); return "accept"; },
    onUserInput: async request => { assert.equal(request.hostId, f.ticket.hostId); return { answer: { answers: ["yes"] } }; }
  })));
  assert.equal(result.text, "remote result"); assert.equal(result.raw, "");
  assert.deepEqual(events, ["guard", "accepted", "partial", "working"]); assert.equal(f.runs.length, 1);
  assert.equal((await f.as(() => f.facade.getRuntimeInfo("ignored", f.thread.threadId, f.ticket.hostId))).model, "deepseek-v4.1-flash-1017");
  assert.equal((await f.as(() => f.facade.listModels(f.ticket.hostId)))[0].model, "deepseek-v4.1-flash-1017");
  assert.equal((await f.as(() => f.facade.getAccountRateLimits(f.ticket.hostId))).planType, "device-plan");
  assert.equal((await f.as(() => f.facade.readTurnLifecycle!(f.thread.threadId, "old", f.ticket.hostId))).source, "unknown");
});

test("the exported thread/cwd and unsupported native features cannot be substituted remotely", async t => {
  const f = await peerFixture(t); await f.bind();
  await assert.rejects(f.as(() => f.facade.run(f.input({ threadId: "another" }))), /selected thread/);
  await assert.rejects(f.as(() => f.facade.run(f.input({ cwd: "/another" }))), /working directory/);
  await assert.rejects(async () => f.as(() => f.facade.addQueuedSubmission!({ threadId: f.thread.threadId, prompt: "x", clientUserMessageId: "q" }, f.ticket.hostId)), CodexBackendCapabilityError);
  await assert.rejects(f.as(() => f.facade.stageAttachments!([{ kind: "file", label: "x", path: "/gateway-only/x" }], { hostId: f.ticket.hostId, scope: "x", maxBytes: 100 })), /selected chat and thread/);
  assert.equal(f.runs.length, 0);
  await f.as(() => f.facade.steer({ threadId: f.thread.threadId, prompt: "follow-up" }, f.ticket.hostId)); // Optional cwd is filled from the scoped export.
  await f.as(() => f.facade.stop(f.thread.threadId, f.ticket.hostId, () => {})); assert.deepEqual(f.stops, [f.thread.threadId]);
});

test("completed source identities survive device restart and do not execute twice", async t => {
  const f = await peerFixture(t); await f.bind();
  await f.as(() => f.facade.run(f.input()));
  await f.reconnect(true);
  const reorderedPrincipal = { actorId: principal.actorId, conversationId: principal.conversationId, accountId: principal.accountId };
  assert.equal((await f.as(() => f.facade.run(f.input()), reorderedPrincipal)).text, "来自设备的回答"); assert.equal(f.runs.length, 1);
  await assert.rejects(f.as(() => f.facade.run(f.input({ prompt: "changed input" }))), /reused for different/);
  const text = fs.readFileSync(path.join(f.root, "client", "receipts.json"), "utf8");
  assert.doesNotMatch(text, /继续任务|provider-private-body/); assert.equal(fs.statSync(path.join(f.root, "client", "receipts.json")).mode & 0o777, 0o600);
});

test("equal provider message IDs in separately approved chats retain separate native identities", async t => {
  const f = await peerFixture(t); await f.bind(); await f.as(() => f.facade.run(f.input()));
  const ticket = await f.reconnect(), second = { ...principal, conversationId: "another-approved-chat" };
  await f.registry.connect(ticket.code, second, () => {});
  await f.as(() => f.facade.run(f.input()), second);
  assert.equal(f.runs.length, 2); assert.notEqual(f.runs[0].clientUserMessageId, f.runs[1].clientUserMessageId);
});

test("only a proven native not-submitted receipt permits retry of the same input", async t => {
  const f = await peerFixture(t); await f.bind();
  f.run = async () => { throw new CodexCommunicationError("preflight", "native/read"); };
  await assert.rejects(f.as(() => f.facade.run(f.input())), error => error instanceof CodexCommunicationError && error.submission === "not-submitted");
  f.run = async input => { await input.onTurnStarted?.({ threadId: f.thread.threadId, turnId: "retry-turn" }); return { text: "retried safely", threadId: f.thread.threadId, turnId: "retry-turn", raw: "" }; };
  assert.equal((await f.as(() => f.facade.run(f.input()))).text, "retried safely"); assert.equal(f.runs.length, 2);
});

test("an unavailable device receipt disk prevents every native write", async t => {
  const f = await peerFixture(t); await f.bind(); const original = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error("receipt disk unavailable"); };
  try { await assert.rejects(f.as(() => f.facade.run(f.input()))); }
  finally { fs.fsyncSync = original; }
  assert.equal(f.runs.length, 0);
});

for (const accepted of [false, true]) test(`${accepted ? "accepted" : "ambiguous"} input is not replayed after a dropped connection`, async t => {
  const f = await peerFixture(t); await f.bind(); const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.run = async input => {
    if (accepted) await input.onTurnStarted?.({ threadId: f.thread.threadId, turnId: "native-turn" });
    entered.resolve(); await release.promise; throw Error("native observation unavailable");
  };
  const pending = f.as(() => f.facade.run(f.input()));
  const rejected = assert.rejects(pending, error => error instanceof CodexCommunicationError && error.phase === (accepted ? "observation" : "submission"));
  await entered.promise; await f.reconnect(); await rejected; release.resolve();
  await assert.rejects(f.as(() => f.facade.run(f.input())), CodexCommunicationError);
  assert.equal(f.runs.length, 1);
});

test("offline before handoff is proven not submitted, including after Gateway restart", async t => {
  const f = await peerFixture(t); await f.bind();
  f.client.close(); await new Promise<void>(resolve => f.serverConnection.onClose(resolve));
  await assert.rejects(f.as(() => f.facade.run(f.input())), error => error instanceof CodexCommunicationError && error.submission === "not-submitted");
  const restarted = withPeerBackend(f.backend, new PeerRegistry(path.join(f.root, "server", "grants.json")));
  await assert.rejects(f.as(() => restarted.run(f.input())), error => error instanceof CodexCommunicationError && error.submission === "not-submitted");
  assert.equal(f.runs.length, 0);
});

test("restart exemption starts after durable Gateway acceptance; detaching never cancels device work", async t => {
  const f = await peerFixture(t); await f.bind();
  const entered = Promise.withResolvers<void>(), persist = Promise.withResolvers<void>(), accepted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.run = async input => {
    await input.onTurnStarted?.({ threadId: f.thread.threadId, turnId: "native-turn" });
    accepted.resolve(); await release.promise; return { text: "done", threadId: f.thread.threadId, turnId: "native-turn", raw: "" };
  };
  const pending = f.as(() => f.facade.run(f.input({ onTurnStarted: async () => { entered.resolve(); await persist.promise; } })));
  const rejected = assert.rejects(pending, error => error instanceof CodexCommunicationError && error.phase === "observation");
  await entered.promise; assert.equal(f.facade.hasRestartBlockingWork!(), true);
  persist.resolve(); await accepted.promise; assert.equal(f.facade.hasRestartBlockingWork!(), false);
  assert.equal(f.facade.isIndependentObservation!({ hostId: f.ticket.hostId, threadId: f.thread.threadId, turnId: "native-turn" }), true);
  f.facade.detachIndependentObservations!(); await rejected; release.resolve();
  assert.equal(f.serverConnection.open, true); assert.equal(f.stops.length, 0);
});

test("closing one account facade leaves the shared device connection usable for another account", async t => {
  const f = await peerFixture(t); await f.bind(); await f.facade.close();
  assert.equal(f.serverConnection.open, true);
  const other = withPeerBackend(f.backend, f.registry);
  await f.as(() => other.run(f.input())); assert.equal(f.runs.length, 1);
});

test("native routing keeps host arguments and guards when the target is local or SSH", async t => {
  const f = await peerFixture(t); let checks = 0, modelsHost: string | undefined;
  const native = { ...f.backend, async listModels(host?: string) { modelsHost = host; return []; },
    async stop(_id?: string, _host?: string, guard?: () => void) { guard?.(); return { stopped: true }; } };
  const wrapped = withPeerBackend(native as never, f.registry);
  await wrapped.stop("thread", "local", () => { checks++; }); assert.equal(checks, 1);
  await wrapped.listModels("ssh-host"); assert.equal(modelsHost, "ssh-host");
});
