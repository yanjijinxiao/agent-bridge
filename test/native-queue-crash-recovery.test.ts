import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sharedNativeCore, message, until } from "./fixtures/shared-native-core.mjs";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { saveAccount } from "../src/weixin/accounts.js";

const executable = fileURLToPath(new URL("./fixtures/native-queue-crash-gateway.mjs", import.meta.url));
function gateway(file: string, mode: string) {
  const child = spawn(process.execPath, ["--import", "tsx", executable, file, mode], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let log = "", sequence = 0;
  child.stdout!.on("data", data => { log = (log + data).slice(-20000); });
  child.stderr!.on("data", data => { log = (log + data).slice(-20000); });
  const replies = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const ready = Promise.withResolvers<void>(); void ready.promise.catch(() => {});
  child.on("message", (value: any) => {
    if (value.type === "ready") ready.resolve();
    const pending = replies.get(value.id); if (!pending) return;
    replies.delete(value.id); value.type === "error" ? pending.reject(Error(value.error)) : pending.resolve(value);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => {
      ready.reject(Error(`Gateway ended before ready: ${code}/${signal}\n${log}`));
      for (const pending of replies.values()) pending.reject(Error(`Gateway ended: ${code}/${signal}\n${log}`));
      replies.clear(); resolve({ code, signal });
    });
  });
  return { child, ready: ready.promise, exited, log: () => log,
    async command(command: string) {
      const id = ++sequence;
      const result = new Promise<any>((resolve, reject) => replies.set(id, { resolve, reject }));
      child.send({ command, id }); return result;
    } };
}

const scenarios = [
  { cut: "before", state: "pending" },
  { cut: "before", state: "running" },
  { cut: "before", state: "completed-offline" },
  { cut: "after", state: "pending" },
  { cut: "after", state: "completed-offline" },
  { cut: "before", state: "running", crashRecovery: true }
] as const;
for (const scenario of scenarios) test(`CTRL-03.1: real Gateway queue journal SIGKILL ${JSON.stringify(scenario)}`,
  { skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN || process.platform === "win32", timeout: 60_000 }, async t => {
  const children: Array<ReturnType<typeof gateway>> = [];
  const seed = Promise.withResolvers<void>(), queued = Promise.withResolvers<void>();
  t.after(() => { seed.resolve(); queued.resolve(); });
  t.after(async () => { for (const c of children) {
    if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill("SIGKILL");
    await c.exited;
  } });
  let final = "";
  const pending = scenario.state === "pending";
  const core = await sharedNativeCore(t, async (_body: unknown, n: number) => {
    if (pending && n === 1) { await seed.promise; return message("SEED_DONE", n); }
    await queued.promise; return message(final, n);
  });
  const outputFile = path.join(core.root, "result.txt");
  fs.writeFileSync(outputFile, "synthetic recovered attachment");
  final = 'QUEUE_CRASH_RESULT\n```codex-im-gateway-actions\n' + JSON.stringify({ send: [{ type: "file", path: outputFile }] }) + '\n```';
  const owner = core.runner(), peer = await core.rpc("queue_crash_inspector");
  const corePid = (await peer.request("server/diagnostics")).process.id;
  const thread = await owner.createThread({ cwd: core.root, projectBinding: "none", title: "Queue crash fixture" });
  let first: Promise<unknown> | undefined;
  if (pending) {
    first = owner.run({ threadId: thread.threadId, cwd: core.root, prompt: "BLOCK_SEED", clientUserMessageId: "seed-input" });
    void first.catch(() => {}); await until(() => core.calls.length === 1);
  }
  const paths = resolveStatePaths(path.join(core.root, "gateway"));
  saveAccount(paths, { accountId: "fixture", token: "isolated-fixture", baseUrl: "https://example.test", enabled: true });
  const store = new RuntimeStateStore(accountStatePaths(paths, "fixture"));
  const session = store.createSession("room", core.root, "Queue crash task", undefined, "session", undefined, { standalone: true });
  store.setSessionThread(session.id, thread.threadId);
  const queueFile = path.join(paths.runtimeDir, "native-submissions.json"), deliveries = path.join(core.root, "deliveries.jsonl");
  const crashMarker = path.join(core.root, "crash.json"), wireLog = path.join(core.root, "wire.jsonl"), config = path.join(core.root, "gateway-config.json");
  fs.writeFileSync(config, JSON.stringify({ gatewayRoot: paths.root, nativeHome: core.root, endpoint: core.endpoint,
    queueFile, deliveries, crashMarker, wireLog }));
  const receipt = () => Object.values(JSON.parse(fs.readFileSync(queueFile, "utf8")).receipts)[0] as any;
  const start = (mode: string) => { const child = gateway(config, mode); children.push(child); return child; };
  const a = start(`submit-${scenario.cut}`);
  assert.equal((await a.exited).signal, "SIGKILL", a.log());
  const accepted = JSON.parse(fs.readFileSync(crashMarker, "utf8")).receipt;
  assert.equal(receipt().status, scenario.cut === "before" ? "submitting" : accepted.status);
  assert.equal((await peer.request("server/diagnostics")).process.id, corePid);
  if (pending) {
    const actual = await owner.listQueuedSubmissions(thread.threadId);
    assert.equal(actual.data.length, 1); assert.equal(actual.data[0].clientUserMessageId, accepted.clientUserMessageId);
    assert.equal(core.calls.length, 1, "a queued task cannot replace the busy owner");
  } else await until(() => core.calls.length === 1);
  if (scenario.state === "completed-offline") {
    queued.resolve();
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      const snapshot = await owner.readThreadSnapshot(thread.threadId);
      done = snapshot.turns.some(turn => turn.status === "completed");
      if (!done) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(done, "queue completes without a Gateway process");
  }
  if ("crashRecovery" in scenario) {
    const interrupted = start("reconcile-before");
    assert.equal((await interrupted.exited).signal, "SIGKILL", interrupted.log());
    assert.equal(receipt().status, "submitting");
  }
  const b = start("recover"); await b.ready;
  seed.resolve(); if (first) await first;
  await until(() => core.calls.length === (pending ? 2 : 1), 15_000);
  queued.resolve();
  // No manual recovery call: exercise AccountManager's production startup and
  // five-second queue monitor, then check its durable delivery settlement.
  try { await until(() => receipt().delivered === true, 25_000); }
  catch (error) { throw Error(`queue receipt ${JSON.stringify(receipt())}\n${b.log()}`, { cause: error }); }
  const inboxFile = path.join(paths.runtimeDir, "fixture", "forwarding-inbox.json");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(inboxFile, "utf8")).rows), [], "a recovered native queue receipt must also retire its original forwarding input");
  assert.equal(receipt().status, "completed"); assert.equal(receipt().clientUserMessageId, accepted.clientUserMessageId);
  const finalTurn = receipt().turnId; assert.ok(finalTurn);
  const media = () => fs.readFileSync(deliveries, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(item => item.kind === "file" && item.path === outputFile);
  assert.equal(media().length, 1, JSON.stringify({
    receipt: receipt(), deliveries: fs.readFileSync(deliveries, "utf8"),
    subscriptions: JSON.parse(fs.readFileSync(path.join(paths.runtimeDir, "thread-subscriptions.json"), "utf8")),
    actions: fs.existsSync(path.join(paths.runtimeDir, "turn-result-actions.json")) ? fs.readFileSync(path.join(paths.runtimeDir, "turn-result-actions.json"), "utf8") : null,
    log: b.log(), wire: fs.readFileSync(wireLog, "utf8")
  }));
  await b.command("stop"); assert.equal((await b.exited).code, 0, b.log());
  const c = start("recover"); await c.ready; await c.command("sync"); await c.command("stop");
  assert.equal((await c.exited).code, 0, c.log());
  const answers = fs.readFileSync(deliveries, "utf8").trim().split("\n").map(x => JSON.parse(x)).filter(x => x.text.includes("QUEUE_CRASH_RESULT"));
  assert.equal(answers.length, 1, "the same final is delivered exactly once across both restarts");
  assert.equal(media().length, 1);
  const history = await owner.getHistory(thread.threadId);
  const inputs = history.filter(x => x.role === "user" && x.clientUserMessageId === accepted.clientUserMessageId);
  assert.equal(inputs.length, 1); assert.equal(inputs[0].turnId, finalTurn);
  const writes = fs.readFileSync(wireLog, "utf8").trim().split("\n").map(x => JSON.parse(x));
  assert.equal(writes.filter(x => x.method === "thread/queue/add").length, 1);
  assert.equal(writes.filter(x => ["turn/start", "turn/steer", "turn/interrupt"].includes(x.method)).length, 0);
  assert.equal(core.calls.length, pending ? 2 : 1);
  assert.equal((await peer.request("server/diagnostics")).process.id, corePid);
});
