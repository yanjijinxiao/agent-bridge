import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RuntimeObservationJournal, RuntimeObservationController, terminalScreenText, type RuntimeObservationScope } from "../src/bridge/runtime-observation.js";
import type { ChannelStreamCheckpoint } from "../src/channels/progress.js";
import type { TurnReplyStream } from "../src/channels/turn-presentation.js";
import type { RuntimeResource, RuntimeOutput } from "../src/agents/contracts.js";
import type { RuntimeHandoffRecord } from "../src/agents/handoff.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-observation-")), file = path.join(root, "observations.json");
  const scope: RuntimeObservationScope = { sessionId: "session", conversationId: "room", actorId: "person", accountId: "bot", hostId: "host", threadId: "binding", bindingStamp: "generation-1" };
  const target: RuntimeResource = { ref: { endpointId: "runtime", id: "terminal" }, kind: "terminal", title: "fixture", cwd: "/fixture", state: "idle",
    evidence: "program-report", incarnation: "first", identityStrength: "observed" };
  let current = true, reads = 0, now = 100, offline = false, followEnabled = true, progressEnabled = true;
  let blockFinal = false;
  let onRead: (() => void) | undefined, onNotify: (() => Promise<void>) | undefined;
  let lookup: (() => Promise<RuntimeHandoffRecord | null>) | undefined, recover: (() => void) | undefined;
  const final: Array<{ text: string; outcome: string; scope: RuntimeObservationScope }> = [], progress: string[] = [], activities: string[] = [];
  const notified: RuntimeObservationScope[] = [], deniedActors = new Set<string>();
  let journal = new RuntimeObservationJournal(file);
  const create = () => new RuntimeObservationController({ journal,
    current: scope => current && !deniedActors.has(scope.actorId), followEnabled: () => followEnabled, progressEnabled: () => progressEnabled, now: () => now,
    inspect: async () => { if (offline) throw Error("offline"); return structuredClone(target); },
    read: async () => { reads++; onRead?.(); return { kind: "terminal-screen", ref: target.ref, text: "screen sample", source: "screen", complete: true }; },
    receipt: async () => lookup?.() ?? null, recovered: () => recover?.(), notify: async row => { notified.push(structuredClone(row.scope)); await onNotify?.(); },
    presentation(row, save) {
      let checkpoint: ChannelStreamCheckpoint = row.checkpoint ?? { messageId: "existing-card", startedAt: now, progressEntries: [], thought: "", answerPreview: "", finished: false };
      const stream = { supported: true, checkpoint: () => checkpoint, async progress(text: string) { progress.push(text); },
        async synchronize() { return checkpoint.terminal ? "finished" : "updated"; },
        async setActivity(activity: string) { activities.push(activity); }, async waitForBackend(text: string) { progress.push(text); }, async suspend() {},
        async finalize(text: string, error: boolean, options: { outcome: string; confirmUncertainDelivery?: boolean }) {
          if (blockFinal && !options.confirmUncertainDelivery) {
            checkpoint = { ...checkpoint, terminal: { text, error, outcome: options.outcome as any } }; save(checkpoint); return false;
          }
          final.push({ text, outcome: options.outcome, scope: structuredClone(row.scope) }); checkpoint = { ...checkpoint, finished: true, terminal: { text, error, outcome: options.outcome as any } }; save(checkpoint); return true;
        } } as unknown as TurnReplyStream;
      return stream;
    } });
  let observer = create(); t.after(() => { observer.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const begin = (fingerprint?: string) => observer.begin(scope, structuredClone(target), "source", fingerprint);
  return { file, scope, target, final, progress, activities, notified, deniedActors, begin, get observer() { return observer; }, get journal() { return journal; }, get reads() { return reads; },
    set blockFinal(value: boolean) { blockFinal = value; },
    set followEnabled(value: boolean) { followEnabled = value; }, set progressEnabled(value: boolean) { progressEnabled = value; },
    set current(value: boolean) { current = value; }, set now(value: number) { now = value; }, set offline(value: boolean) { offline = value; },
    set onRead(value: () => void) { onRead = value; }, set onNotify(value: () => Promise<void>) { onNotify = value; },
    set lookup(value: () => Promise<RuntimeHandoffRecord | null>) { lookup = value; }, set recover(value: () => void) { recover = value; },
    reload() { observer.close(); journal = new RuntimeObservationJournal(file); observer = create(); },
    confirm(id: string, started: boolean | null = null) { observer.handed(id, { fingerprint: "a".repeat(64), ref: target.ref, phase: "confirmed",
      receipt: { kind: "terminal-written", ref: target.ref, incarnation: target.incarnation!, started } }); }
  };
}
test("runtime observation does not claim success from idle, silence or completed-looking screen text", async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id); await f.observer.tick(); assert.equal(f.final.length, 0);
  f.now = 20101; await f.observer.tick(); assert.equal(f.final[0].outcome, "terminal-idle");
  assert.match(f.final[0].text, /不代表任务成功/); assert.equal(f.journal.list().length, 0);
});
test("a retired observation from a stale tick snapshot cannot read or recreate its card", async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id); const stale = f.journal.get(id)!;
  f.journal.remove(id); await (f.observer as any).observe(stale);
  assert.equal(f.reads, 0); assert.equal(f.progress.length, 0); assert.equal(f.final.length, 0); assert.equal(f.journal.list().length, 0);
});
test("a replacement during read never publishes the new program screen", async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id); f.onRead = () => { f.target.incarnation = "replacement"; };
  await f.observer.tick(); assert.ok(!f.progress.join("\n").includes("screen sample")); assert.equal(f.final.length, 0);
  await f.observer.tick(); assert.equal(f.final[0].outcome, "detached"); assert.equal(f.reads, 1);
});
test("revocation during read discards the returned screen", async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id); f.onRead = () => { f.current = false; };
  await f.observer.tick(); assert.equal(f.progress.length, 0); assert.equal(f.final.length, 0);
  await f.observer.tick(); assert.equal(f.reads, 1);
});
test("ambiguous completion mention is not replayed after observer reconstruction", async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id, true); let notifications = 0;
  f.onNotify = async () => { notifications++; throw Error("ack lost"); };
  await f.observer.tick(); f.reload(); await f.observer.tick();
  assert.equal(notifications, 1); assert.equal(f.journal.list().length, 0);
});
test("mismatched receipt fingerprint cannot repair Gateway acceptance or finish an unknown card", async t => {
  const f = fixture(t), id = f.begin("a".repeat(64)); f.observer.uncertain(id); let recovered = 0;
  f.recover = () => { recovered++; };
  f.lookup = async () => ({ fingerprint: "b".repeat(64), ref: f.target.ref, phase: "confirmed",
    receipt: { kind: "terminal-written", ref: f.target.ref, incarnation: f.target.incarnation!, started: true } });
  await f.observer.tick(); assert.equal(recovered, 0); assert.equal(f.journal.get(id)?.phase, "unknown"); assert.equal(f.reads, 0);
});
test("failed Gateway receipt persistence keeps the recovery obligation retryable without sending", async t => {
  const f = fixture(t), id = f.begin("a".repeat(64)); f.observer.uncertain(id); let attempts = 0;
  f.lookup = async () => ({ fingerprint: "a".repeat(64), ref: f.target.ref, phase: "confirmed",
    receipt: { kind: "terminal-written", ref: f.target.ref, incarnation: f.target.incarnation!, started: true } });
  f.recover = () => { if (++attempts === 1) throw Error("disk full"); };
  await f.observer.tick(); assert.equal(f.journal.get(id)?.phase, "unknown"); assert.equal(f.reads, 0);
  await f.observer.tick(); assert.equal(attempts, 2); assert.match(f.final[0].text, /交接已确认/);
});
test("runtime observation follows working to idle while keeping a non-native outcome", async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id); f.target.state = "working"; await f.observer.tick();
  assert.equal(f.final.length, 0); assert.ok(f.activities.includes("running")); f.target.state = "idle"; await f.observer.tick();
  assert.equal(f.final[0].outcome, "terminal-idle"); assert.ok(!JSON.stringify(f.final).includes('"completed"'));
});
test("a confirmed started flag allows an observed fast idle without inventing a turn", async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id, true); await f.observer.tick();
  assert.equal(f.final[0].outcome, "terminal-idle"); assert.ok(!fs.readFileSync(f.file, "utf8").includes("turnId"));
});
for (const state of ["blocked", "unknown"] as const) test(`runtime ${state} is not a terminal task result`, async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id); f.target.state = state; f.now = 100000; await f.observer.tick();
  assert.equal(f.final.length, 0); assert.equal(f.journal.list().length, 1);
});
for (const state of ["exited", "error"] as const) test(`runtime ${state} is reported as process evidence`, async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id); f.target.state = state; await f.observer.tick();
  assert.equal(f.final[0].outcome, state === "exited" ? "terminal-exited" : "terminal-error");
});
test("a crash with a writing intent resumes observation but never resends input", async t => {
  const f = fixture(t); f.begin(); f.reload(); f.now = 20101; await f.observer.tick();
  assert.equal(f.reads, 1); assert.match(f.final[0].text, /交接未确认，未自动重发/);
});
test("a live handoff cannot be finalized as idle while its acknowledgement is pending", async t => {
  const f = fixture(t), id = f.begin(); f.now = 100000; await f.observer.tick();
  assert.equal(f.reads, 0); assert.equal(f.final.length, 0); assert.equal(f.journal.list().length, 1);
  f.confirm(id, true); await f.observer.tick(); assert.equal(f.final[0].outcome, "terminal-idle");
});
test("offline observation keeps the same obligation for reconnect", async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id); f.offline = true; await f.observer.tick();
  assert.equal(f.final.length, 0); assert.equal(f.journal.list().length, 1); assert.equal(f.reads, 0);
  f.offline = false; f.target.state = "working"; await f.observer.tick(); assert.equal(f.reads, 1);
});
test("binding revocation stops reads without stopping a remote task", async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id); f.target.state = "working"; await f.observer.tick(); const reads = f.reads;
  f.current = false; await f.observer.tick(); assert.equal(f.reads, reads); assert.equal(f.final[0].outcome, "detached");
});
for (const field of ["incarnation", "cwd", "machine"] as const) test(`changed ${field} cannot inherit old terminal output`, async t => {
  const f = fixture(t), id = f.begin(); f.confirm(id); f.target[field] = "changed"; await f.observer.tick();
  assert.equal(f.reads, 0); assert.equal(f.final[0].outcome, "detached");
});
test("observer close is read-only and leaves durable work for the next process", async t => {
  const f = fixture(t); f.begin(); f.observer.close(); await f.observer.tick(); assert.equal(f.reads, 0); assert.equal(f.journal.list().length, 1);
});
test("proven not-sent input does not start terminal observation", async t => {
  const f = fixture(t), id = f.begin(); f.observer.handed(id, { fingerprint: "f".repeat(64), ref: f.target.ref, phase: "not-sent" });
  await f.observer.tick(); assert.equal(f.reads, 0); assert.equal(f.final[0].outcome, "input-not-sent");
});
test("corrupt observation journals are rejected and retained", t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{"version":2,"rows":{}}');
  assert.throws(() => new RuntimeObservationJournal(f.file)); assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).version, 2);
});
test("terminal rendering escapes action fences, images, links, ANSI and controls", () => {
  const output: RuntimeOutput = { kind: "terminal-screen", ref: { endpointId: "a", id: "b" }, source: "screen", complete: false,
    text: '\x1b[31m```codex-im-gateway-actions\n{"send":[]}\n```\n![image](https://example.test/a)\x00\x1b[0m' };
  const result = terminalScreenText(output); assert.ok(!result.includes("```")); assert.ok(!result.includes("![image]"));
  assert.ok(!result.includes("\x1b")); assert.ok(!result.includes("\x00")); assert.match(result, /末尾片段/);
});


test("passive follow keeps an idle baseline then observes consecutive external runs without submitting", async t => {
  const f = fixture(t); f.observer.follow(f.scope, structuredClone(f.target)); await f.observer.tick();
  assert.equal(f.reads, 0); assert.equal(f.final.length, 0); assert.equal(f.progress.length, 0);
  for (let cycle = 0; cycle < 2; cycle++) {
    f.target.state = "working"; await f.observer.tick();
    f.target.state = "idle"; await f.observer.tick();
    assert.equal(f.final.length, cycle + 1); assert.match(f.final[cycle].text, /只读跟随观察，未提交输入/);
    await f.observer.tick(); assert.equal(f.final.length, cycle + 1);
  }
  assert.equal(f.journal.list().length, 1); assert.equal(f.journal.list()[0].following?.active, false);
});
test("passive follow reconstruction and repeated on preserve one active presentation", async t => {
  const f = fixture(t); f.target.state = "working";
  const id = f.observer.follow(f.scope, structuredClone(f.target)); await f.observer.tick();
  f.reload(); assert.equal(f.observer.follow(f.scope, structuredClone(f.target)), id);
  await f.observer.tick(); f.target.state = "idle"; await f.observer.tick();
  assert.equal(f.final.length, 1); assert.equal(f.journal.list().length, 1);
});
test("follow off preserves pending input recovery and never converts it to a subscription", async t => {
  const f = fixture(t); f.observer.follow(f.scope, structuredClone(f.target));
  const id = f.begin(); f.confirm(id); f.followEnabled = false; await f.observer.tick();
  assert.equal(f.journal.list().length, 1); assert.equal(f.journal.get(id)?.following, undefined);
  f.target.state = "working"; await f.observer.tick(); f.target.state = "idle"; await f.observer.tick();
  assert.match(f.final.at(-1)!.text, /交接已确认/);
});
test("passive following yields to an input result instead of duplicating terminal output", async t => {
  const f = fixture(t); f.observer.follow(f.scope, structuredClone(f.target)); await f.observer.tick();
  const id = f.begin(); f.confirm(id); f.target.state = "working"; await f.observer.tick();
  assert.equal(f.reads, 1); f.target.state = "idle"; await f.observer.tick(); await f.observer.tick();
  assert.equal(f.final.filter(x => x.outcome === "terminal-idle").length, 1);
});
for (const restart of [false, true]) test(`terminal completion between passive and input reads does not create a second result card, restart=${restart}`, async t => {
  const f = fixture(t); f.target.observationSequence = 1;
  const follow = f.observer.follow(f.scope, structuredClone(f.target)); await f.observer.tick();
  const id = f.begin(); f.confirm(id, true); f.target.state = "working"; f.target.observationSequence = 2;
  f.onRead = () => { f.target.state = "idle"; f.target.observationSequence = 3; };
  await f.observer.tick(); assert.equal(f.final.length, 1);
  assert.equal(f.journal.get(follow)?.lastSequence, 3);
  if (restart) f.reload(); await f.observer.tick(); assert.equal(f.final.length, 1);
  // A genuinely later external cycle remains visible; do not suppress follow.
  f.onRead = () => {}; f.target.observationSequence = 5;
  await f.observer.tick(); assert.equal(f.final.length, 2); assert.match(f.final[1].text, /只读跟随/);
});
test("stream off suppresses progress while preserving input outcome", async t => {
  const f = fixture(t); const id = f.begin(); f.confirm(id); f.progressEnabled = false;
  f.target.state = "working"; await f.observer.tick(); assert.equal(f.progress.length, 0); assert.equal(f.activities.length, 0);
  f.target.state = "idle"; await f.observer.tick(); assert.equal(f.final.length, 1);
});
test("passive follow reconnect records only fresh read evidence", async t => {
  const f = fixture(t); const id = f.observer.follow(f.scope, structuredClone(f.target)); await f.observer.tick();
  f.offline = true; f.now = 500; f.target.state = "working"; await f.observer.tick();
  assert.equal(f.journal.get(id)?.lastSyncedAt, 100); assert.equal(f.reads, 0);
  f.offline = false; await f.observer.tick(); assert.equal(f.journal.get(id)?.lastSyncedAt, 500); assert.equal(f.reads, 1);
});
test("a sequence change may reveal an offline terminal cycle but never manufactures a task result", async t => {
  const f = fixture(t); f.target.observationSequence = 4;
  f.observer.follow(f.scope, structuredClone(f.target)); await f.observer.tick(); f.reload();
  f.target.observationSequence = 5; await f.observer.tick();
  assert.equal(f.final.length, 1); assert.match(f.final[0].text, /只读跟随/);
  await f.observer.tick(); assert.equal(f.final.length, 1);
});
test("unknown and unchanged idle states do not produce passive follow cards", async t => {
  const f = fixture(t); f.target.state = "unknown";
  f.observer.follow(f.scope, structuredClone(f.target)); await f.observer.tick(); await f.observer.tick();
  f.target.state = "idle"; await f.observer.tick(); assert.equal(f.reads, 0); assert.equal(f.final.length, 0);
});
test("revoked passive follow stops without reading or announcing a task outcome", async t => {
  const f = fixture(t); f.observer.follow(f.scope, structuredClone(f.target)); f.current = false; await f.observer.tick();
  assert.equal(f.reads, 0); assert.equal(f.final.length, 0); assert.equal(f.journal.list().length, 0);
});
for (const field of ["incarnation", "cwd", "machine"] as const) test(`passive follow retires changed ${field} without reading the replacement`, async t => {
  const f = fixture(t); f.observer.follow(f.scope, structuredClone(f.target)); f.target[field] = "replacement";
  await f.observer.tick(); assert.equal(f.reads, 0); assert.equal(f.journal.list().length, 0);
});

test("explicit follow retry applies to a pending terminal card, not to terminal execution", async t => {
  const f = fixture(t); const id = f.begin(); f.confirm(id, true); f.blockFinal = true;
  await f.observer.tick(); assert.equal(f.final.length, 0); assert.ok(f.journal.get(id)?.checkpoint?.terminal);
  await f.observer.synchronize(f.scope, true); assert.equal(f.final.length, 1); assert.equal(f.journal.list().length, 0);
});
test("turning passive follow off retires its existing card and keeps the external process alone", async t => {
  const f = fixture(t); f.target.state = "working"; f.observer.follow(f.scope, structuredClone(f.target));
  await f.observer.tick(); f.followEnabled = false; await f.observer.tick();
  assert.equal(f.final.at(-1)?.outcome, "detached"); assert.equal(f.journal.list().length, 0);
});

test("input priority retains ambiguous passive card evidence instead of resetting its handle", async t => {
  const f = fixture(t); const id = f.observer.follow(f.scope, structuredClone(f.target));
  f.journal.put({ ...f.journal.get(id)!, following: { active: true }, checkpoint: {
    streamId: "original-stream", creationAttempted: true, startedAt: 100, progressEntries: [], thought: "", answerPreview: "", finished: false } });
  f.blockFinal = true; const input = f.begin(); f.confirm(input); f.target.state = "working";
  await f.observer.tick(); assert.equal(f.journal.get(id)?.checkpoint?.streamId, "original-stream");
  assert.equal(f.journal.get(id)?.checkpoint?.creationAttempted, true);
});
test("simultaneous synchronize waits for the original read instead of completing from a stale snapshot", async t => {
  const f = fixture(t); const id = f.begin(); f.confirm(id); f.target.state = "working";
  await Promise.all([f.observer.tick(), f.observer.synchronize(f.scope)]);
  assert.equal(f.reads, 1); assert.equal(f.final.length, 0);
});

test("terminal observations keep each accepted actor and chat attribution across reconstruction", async t => {
  const f = fixture(t);
  const scopes = [f.scope, { ...f.scope, actorId: "second-person" },
    { ...f.scope, conversationId: "second-room" }, { ...f.scope, accountId: "second-bot" }];
  const ids = scopes.map(scope => f.observer.begin(scope, structuredClone(f.target), "same-provider-message-id"));
  assert.equal(new Set(ids).size, scopes.length);
  ids.forEach(id => f.confirm(id, true)); f.reload(); await f.observer.tick(); f.reload(); await f.observer.tick();
  assert.deepEqual(f.notified, scopes); assert.deepEqual(f.final.map(row => row.scope), scopes);
  assert.ok(f.final.every(row => row.text.includes("不代表任务成功")));
});
test("one participant losing access cannot transfer their observation or suppress another participant", async t => {
  const f = fixture(t), other = { ...f.scope, actorId: "second-person" };
  f.confirm(f.begin(), true);
  f.confirm(f.observer.begin(other, structuredClone(f.target), "other-source"), true);
  f.deniedActors.add(f.scope.actorId); await f.observer.tick();
  assert.deepEqual(f.notified, [other]); assert.equal(f.reads, 1);
  assert.equal(f.final.filter(row => row.outcome === "terminal-idle").length, 1);
});
test("another participant follows the same chat without replacing the original subscription authority", async t => {
  const f = fixture(t), id = f.observer.follow(f.scope, structuredClone(f.target));
  assert.equal(f.observer.follow({ ...f.scope, actorId: "second-person" }, structuredClone(f.target)), id);
  assert.equal(f.journal.get(id)?.scope.actorId, f.scope.actorId);
  f.target.state = "working"; await f.observer.tick(); f.target.state = "idle"; await f.observer.tick();
  assert.deepEqual(f.notified, [], "passive observation has no input participants to mention");
});
