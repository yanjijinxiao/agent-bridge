import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { RuntimeHandoffCoordinator, RuntimeHandoffJournal, type RuntimeSend } from "../src/agents/handoff.js";
import { RuntimeError, type AgentRuntimeAdapter } from "../src/agents/contracts.js";

function setup(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abhandoff-")), file = path.join(dir, "journal.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file };
}
const input = (): RuntimeSend => ({ source: { principal: "channel:user:chat", sourceId: "message1", operationId: "send1" },
  target: { ref: { endpointId: "runtime1", id: "terminal1" }, kind: "terminal", title: "Same name", state: "idle",
    evidence: "terminal-detection", incarnation: "program1", identityStrength: "observed", cwd: "/tmp/work" },
  text: "test input never persisted", assertCurrent() {} });
const receipt = (value: RuntimeSend) => ({ kind: "terminal-written" as const, ref: value.target.ref, incarnation: value.target.incarnation!, started: null });

test("handoff persists intent before native write, stores receipt but no executable prompt, and replays only receipt", async t => {
  const { file } = setup(t); let writes = 0; const value = input();
  const adapter: Pick<AgentRuntimeAdapter, "send"> = { async send(v) {
    assert.equal(Object.values(JSON.parse(fs.readFileSync(file, "utf8")).records as any)[0] instanceof Object, true);
    v.assertCurrent(); writes++; return receipt(value);
  } };
  const first = new RuntimeHandoffCoordinator(adapter, new RuntimeHandoffJournal(file));
  assert.equal((await first.sendOnce(value)).phase, "confirmed");
  const resumed = new RuntimeHandoffCoordinator(adapter, new RuntimeHandoffJournal(file));
  assert.equal((await resumed.sendOnce(value)).phase, "confirmed"); assert.equal(writes, 1);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /test input never persisted/);
});
test("handoff cannot reuse a source id for another target, body or program", async t => {
  const { file } = setup(t), value = input();
  const c = new RuntimeHandoffCoordinator({ async send(v) { v.assertCurrent(); return receipt(value); } }, new RuntimeHandoffJournal(file));
  await c.sendOnce(value);
  for (const changed of [{ ...value, text: "different" }, { ...value, target: { ...value.target, incarnation: "program2" } },
    { ...value, target: { ...value.target, ref: { ...value.target.ref, id: "terminal2" } } }])
    await assert.rejects(c.sendOnce(changed), { code: "scope" });
});
test("handoff unknown acknowledgement and restart never resend", async t => {
  const { file } = setup(t); let calls = 0;
  const adapter: Pick<AgentRuntimeAdapter, "send"> = { async send(v) { v.assertCurrent(); calls++; throw new RuntimeError("transport", "lost", "unknown"); } };
  assert.equal((await new RuntimeHandoffCoordinator(adapter, new RuntimeHandoffJournal(file)).sendOnce(input())).phase, "unknown");
  assert.equal((await new RuntimeHandoffCoordinator(adapter, new RuntimeHandoffJournal(file)).sendOnce(input())).phase, "unknown"); assert.equal(calls, 1);
});
test("handoff confirmed receipt remains confirmed after revocation during write; revoked callers cannot read cache", async t => {
  const { file } = setup(t), value = input(); let allowed = true;
  value.assertCurrent = () => { if (!allowed) throw Error("revoked"); };
  const c = new RuntimeHandoffCoordinator({ async send(v) { v.assertCurrent(); allowed = false; return receipt(value); } }, new RuntimeHandoffJournal(file));
  assert.equal((await c.sendOnce(value)).phase, "confirmed");
  await assert.rejects(c.sendOnce(value), { code: "scope" });
  assert.equal(Object.values(JSON.parse(fs.readFileSync(file, "utf8")).records as any)[0] instanceof Object, true);
});
test("handoff source change before write is not-sent, and same source retry only returns recorded decision", async t => {
  const { file } = setup(t); let checks = 0, writes = 0; const value = input();
  value.assertCurrent = () => { if (++checks > 1) throw Error("revoked"); };
  const c = new RuntimeHandoffCoordinator({ async send(v) { v.assertCurrent(); writes++; return receipt(value); } }, new RuntimeHandoffJournal(file));
  assert.equal((await c.sendOnce(value)).phase, "not-sent"); assert.equal(writes, 0);
  value.assertCurrent = () => {};
  assert.equal((await c.sendOnce(value)).phase, "not-sent"); assert.equal(writes, 0);
});
test("handoff journal write failure prevents runtime invocation", async t => {
  const { file } = setup(t); const journal = new RuntimeHandoffJournal(file);
  fs.mkdirSync(file); let calls = 0;
  const c = new RuntimeHandoffCoordinator({ async send() { calls++; return receipt(input()); } }, journal);
  await assert.rejects(c.sendOnce(input()), { code: "transport", submission: "not-sent" }); assert.equal(calls, 0);
});
test("handoff failed acknowledgement persistence remains unknown after reload", async t => {
  const { file } = setup(t), journal = new RuntimeHandoffJournal(file), original = journal.write.bind(journal); let calls = 0;
  journal.write = (key, row) => { if (row.phase === "confirmed") throw Error("disk full"); original(key, row); };
  const adapter: Pick<AgentRuntimeAdapter, "send"> = { async send(v) { v.assertCurrent(); calls++; return receipt(input()); } };
  await assert.rejects(new RuntimeHandoffCoordinator(adapter, journal).sendOnce(input()), { submission: "unknown" });
  assert.equal((await new RuntimeHandoffCoordinator(adapter, new RuntimeHandoffJournal(file)).sendOnce(input())).phase, "unknown"); assert.equal(calls, 1);
});
test("handoff concurrent writes to one terminal are excluded only until handoff settles", async t => {
  const { file } = setup(t); let release!: () => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
  const c = new RuntimeHandoffCoordinator({ async send(v) { v.assertCurrent(); entered(); await wait; return receipt(input()); } }, new RuntimeHandoffJournal(file));
  const first = c.sendOnce(input()); await started;
  const next = { ...input(), source: { ...input().source, operationId: "send2" } };
  await assert.rejects(c.sendOnce(next), { code: "not-ready", submission: "not-sent" });
  release(); assert.equal((await first).phase, "confirmed"); assert.equal((await c.sendOnce(next)).phase, "confirmed");
});
test("handoff malformed acknowledgement cannot become not-sent or permit replay", async t => {
  const { file } = setup(t); let calls = 0;
  const c = new RuntimeHandoffCoordinator({ async send(v) { v.assertCurrent(); calls++; return { bogus: true } as any; } }, new RuntimeHandoffJournal(file));
  assert.equal((await c.sendOnce(input())).phase, "unknown"); assert.equal((await c.sendOnce(input())).phase, "unknown"); assert.equal(calls, 1);
});
test("handoff real SIGKILL after socket delivery reloads as unknown without a second write", { timeout: 10000 }, async t => {
  const { dir, file } = setup(t), socket = path.join(dir, "s"); let writes = 0;
  let received!: () => void; const delivered = new Promise<void>(r => { received = r; }); const sockets = new Set<net.Socket>();
  const server = net.createServer(s => { sockets.add(s); let data = ""; s.on("data", b => {
    data += b.toString(); if (data.includes("\n")) { writes++; received(); }
  }); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  const child = spawn(process.execPath, ["--import", "tsx", "test/fixtures/agent-handoff-child.ts", file, socket], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { child.kill("SIGKILL"); for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); });
  let failure = ""; child.stderr.on("data", b => { failure += b.toString(); });
  const closed = once(child, "close");
  await Promise.race([delivered, closed.then(() => { throw Error(`child stopped before delivery: ${failure}`); })]);
  child.kill("SIGKILL"); const [, signal] = await closed; assert.equal(signal, "SIGKILL");
  const c = new RuntimeHandoffCoordinator({ async send() { throw Error("must not resend"); } }, new RuntimeHandoffJournal(file));
  assert.equal((await c.sendOnce(input())).phase, "unknown"); assert.equal(writes, 1);
});
