import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { sharedNativeCore, message, until } from "./fixtures/shared-native-core.mjs";

const native = { skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30000 };

for (const reconnect of [false, true]) test(`NATIVE-02.1: concurrent peers steer the same native turn once (reconnect=${reconnect})`, native, async t => {
  const release = Promise.withResolvers<void>(); t.after(() => release.resolve());
  const f = await sharedNativeCore(t, async (_body, n) => {
    if (n === 2) await release.promise;
    return message(`CONCURRENT_DONE_${n}`, n);
  });
  const owner = await f.rpc("concurrent_owner"), initial = await owner.request("thread/start", { cwd: f.root });
  const id = initial.thread.id;
  await owner.request("turn/start", { threadId: id, input: [{ type: "text", text: "initialize", text_elements: [] }] });
  await until(() => owner.events.some(e => e.method === "turn/completed"));
  const accepted = await owner.request("turn/start", { threadId: id, clientUserMessageId: "original-active",
    input: [{ type: "text", text: "hold for two concurrent peers", text_elements: [] }] });
  await until(() => f.calls.length === 2);
  const pid = (await owner.request("server/diagnostics")).process.id;
  const connect = () => { const gateway = new CodexAppServerGateway({ appServerBackend: f.runner() }); t.after(() => gateway.close()); return gateway; };
  const first = connect(); let second = connect();
  assert.equal((await first.inspectThread(id)).activeTurnId, accepted.turn.id);
  assert.equal((await second.inspectThread(id)).activeTurnId, accepted.turn.id);
  if (reconnect) { await second.close(); second = connect(); }
  const receipts = await Promise.all([first, second].map((peer, i) => peer.steer({ threadId: id,
    expectedTurnId: accepted.turn.id, prompt: `concurrent steer ${i}`, clientUserMessageId: `concurrent-${i}` })));
  for (const receipt of receipts) assert.deepEqual(receipt, { status: "accepted", threadId: id, turnId: accepted.turn.id });
  assert.equal((await first.inspectThread(id)).activeTurnId, accepted.turn.id);
  assert.equal((await second.inspectThread(id)).activeTurnId, accepted.turn.id);
  assert.equal((await owner.request("server/diagnostics")).process.id, pid);
  release.resolve();
  await until(() => owner.events.some(e => e.method === "turn/completed" && e.params?.turn?.id === accepted.turn.id));
  for (const peer of [first, second]) {
    const history = await peer.getHistory(id);
    for (const client of ["original-active", "concurrent-0", "concurrent-1"])
      assert.equal(history.filter(item => item.clientUserMessageId === client).length, 1, `${client} is visible exactly once`);
    assert.equal((await peer.readTurnLifecycle(id, accepted.turn.id)).status, "completed");
  }
  assert.equal(owner.events.filter(e => e.method === "turn/started").length, 2, "steering creates no replacement turn");
});

test("CTRL-04.1: stopping an idle thread does not interrupt a different active native turn", native, async t => {
  const release = Promise.withResolvers<void>(); t.after(() => release.resolve());
  const f = await sharedNativeCore(t, async (_body, n) => { if (n === 2) await release.promise; return message(`STOP_DONE_${n}`, n); });
  const gateway = new CodexAppServerGateway({ appServerBackend: f.runner() }); t.after(() => gateway.close());
  const idle = await gateway.run({ cwd: f.root, prompt: "complete idle target", clientUserMessageId: "idle-input" });
  const received = Promise.withResolvers<{ threadId: string; turnId: string }>();
  const active = gateway.run({ cwd: f.root, prompt: "keep separate task active", clientUserMessageId: "active-input",
    onTurnStarted: event => { received.resolve(event); } });
  const identity = await received.promise;
  await until(() => f.calls.length === 2);
  assert.notEqual(identity.threadId, idle.threadId);
  assert.equal(await gateway.stop(idle.threadId), "not-active");
  assert.equal((await gateway.inspectThread(identity.threadId)).activeTurnId, identity.turnId);
  assert.equal((await gateway.readTurnLifecycle(identity.threadId, identity.turnId)).status, "inProgress");
  release.resolve();
  assert.equal((await active).turnId, identity.turnId);
  assert.equal((await gateway.readTurnLifecycle(identity.threadId, identity.turnId)).status, "completed");
  assert.equal((await gateway.getHistory(identity.threadId)).filter(item => item.clientUserMessageId === "active-input").length, 1);
  assert.equal(f.calls.length, 2);
});

for (const operation of ["steer", "interrupt"] as const) test(`CTRL-01.3: ${operation} checks revoked source after native connection preparation`, native, async t => {
  const release = Promise.withResolvers<void>(); t.after(() => release.resolve());
  const f = await sharedNativeCore(t, async (_body, n) => { if (n === 2) await release.promise; return message(`LEASE_DONE_${n}`, n); });
  const owner = f.runner(), initial = await owner.run({ cwd: f.root, prompt: "initialize" });
  const received = Promise.withResolvers<{ threadId: string; turnId: string }>();
  const active = owner.run({ cwd: f.root, threadId: initial.threadId, prompt: "preserve active turn",
    onTurnStarted: event => { received.resolve(event); } });
  const identity = await received.promise; await until(() => f.calls.length === 2);
  const challenger = f.runner(); let checked = 0;
  const revoked = () => { checked++; throw Error("source revoked after reconnect"); };
  await assert.rejects(operation === "steer"
    ? challenger.steer({ threadId: identity.threadId, expectedTurnId: identity.turnId, prompt: "must not arrive", clientUserMessageId: "revoked-input", assertCurrent: revoked })
    : challenger.interruptTurn(identity.threadId, identity.turnId, revoked), /source revoked/);
  assert.equal(checked, 1);
  assert.equal((await owner.inspectThread(identity.threadId)).activeTurnId, identity.turnId);
  release.resolve(); await active;
  assert.equal((await owner.getHistory(identity.threadId)).filter(item => item.clientUserMessageId === "revoked-input").length, 0);
  assert.equal(f.calls.length, 2);
});
