import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sharedNativeCore, message, until } from "./fixtures/shared-native-core.mjs";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { saveAccount } from "../src/weixin/accounts.js";

const executable = fileURLToPath(new URL("./fixtures/native-crash-gateway.mjs", import.meta.url));
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
function receipt(file: string) {
  const id = crypto.createHash("sha256").update("crash-input").digest("hex");
  let result;
  for (const line of fs.readFileSync(file, "utf8").split("\n").slice(0, -1)) {
    const row = JSON.parse(line); if (row.id === id) result = row.receipt;
  }
  return result;
}

for (const scenario of [
  { existing: true, completedOffline: false, recoveryCrash: false },
  { existing: false, completedOffline: false, recoveryCrash: false },
  { existing: true, completedOffline: true, recoveryCrash: false },
  { existing: false, completedOffline: true, recoveryCrash: false },
  { existing: true, completedOffline: false, recoveryCrash: true },
  { existing: false, completedOffline: true, recoveryCrash: "after" },
  { existing: true, completedOffline: false, recoveryCrash: false, releaseProbe: true }
]) test(scenario.releaseProbe ? "release command before and after recovery of a native receipt append returning ENOSPC"
  : `IN-02.2: real SIGKILL acceptance recovery without replay ${JSON.stringify(scenario)}`,
  { skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN || process.platform === "win32", timeout: 60000 }, async t => {
    const { existing, completedOffline, recoveryCrash } = scenario;
    const children: Array<ReturnType<typeof gateway>> = [], release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    t.after(async () => { for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
      await child.exited;
    } });
    let final = "";
    const f = await sharedNativeCore(t, async (body: any, n: number) => {
      if (JSON.stringify(body.input).includes("CRASH_INPUT")) { await release.promise; return message(final, n); }
      return message("INITIALIZED", n);
    });
    const outputFile = path.join(f.root, "result.txt");
    fs.writeFileSync(outputFile, "synthetic recovered attachment");
    final = 'CRASH_RESULT\n```codex-im-gateway-actions\n' + JSON.stringify({ send: [{ type: "file", path: outputFile }] }) + '\n```';
    const peer = await f.rpc("crash_owner");
    const beforeCore = (await peer.request("server/diagnostics")).process.id;
    let threadId: string | undefined;
    if (existing) {
      threadId = (await peer.request("thread/start", { cwd: f.root })).thread.id;
      await peer.request("turn/start", { threadId, input: [{ type: "text", text: "initialize", text_elements: [] }] });
      await until(() => peer.events.some((e: any) => e.method === "turn/completed"));
    }
    const paths = resolveStatePaths(path.join(f.root, "gateway"));
    saveAccount(paths, { accountId: "fixture", token: "isolated-fixture", baseUrl: "https://example.test", enabled: true });
    const store = new RuntimeStateStore(accountStatePaths(paths, "fixture"));
    const session = store.createSession("room", f.root, "Crash task", undefined, "session", undefined, { standalone: true });
    if (threadId) store.setSessionThread(session.id, threadId);
    const receiptFile = path.join(paths.runtimeDir, "fixture", "inbound-receipts.jsonl"), deliveries = path.join(f.root, "deliveries.jsonl");
    const crashMarker = path.join(f.root, "crash.json"), config = path.join(f.root, "gateway-config.json");
    const releaseProbe = scenario.releaseProbe ? path.join(f.root, "test-management-origin") : undefined;
    fs.writeFileSync(config, JSON.stringify({ releaseProbe, gatewayRoot: paths.root, nativeHome: f.root, endpoint: f.endpoint, receiptFile, deliveries, crashMarker }));
    const first = gateway(config, releaseProbe ? "disk-full" : "crash"); children.push(first);
    if (releaseProbe) {
      const { claimRuntimeRelease } = await import("../scripts/release-local.mjs");
      await first.ready;
      await until(() => fs.existsSync(crashMarker));
      const origin = new URL(fs.readFileSync(releaseProbe, "utf8"));
      try { await assert.rejects(claimRuntimeRelease(origin, first.child.pid), /release admission HTTP 409/); }
      catch (error) { throw Error("release before recovery: " + first.log(), { cause: error }); }
      assert.equal(first.child.exitCode, null);
      first.child.kill("SIGKILL");
    }
    assert.equal((await first.exited).signal, "SIGKILL", first.log());
    const accepted = JSON.parse(fs.readFileSync(crashMarker, "utf8")).receipt;
    assert.equal(receipt(receiptFile).phase, "submitting", "the durable Gateway receipt has no acceptance yet");
    assert.equal((await peer.request("server/diagnostics")).process.id, beforeCore);
    // turn/started can precede the model call and the first persisted turn
    // item. Require actual execution before inspecting the running snapshot.
    await until(() => f.calls.some((call: any) => JSON.stringify(call.input).includes("CRASH_INPUT")));
    const observed = await peer.request("thread/read", { threadId: accepted.threadId, includeTurns: true });
    assert.ok(observed.thread.turns.some((turn: any) => turn.id === accepted.turnId && turn.status === "inProgress"),
      JSON.stringify(observed.thread.turns.map((turn: any) => ({ id: turn.id, status: turn.status }))));
    if (completedOffline) {
      release.resolve();
      // The observer did not create a fresh thread and need not receive its
      // broadcasts. Query the same core's authoritative turn instead.
      const deadline = Date.now() + 10000;
      let status;
      do {
        status = (await peer.request("thread/read", { threadId: accepted.threadId, includeTurns: true }))
          .thread.turns.find((turn: any) => turn.id === accepted.turnId)?.status;
        if (status !== "completed") await new Promise(resolve => setTimeout(resolve, 20));
      } while (status !== "completed" && Date.now() < deadline);
      assert.equal(status, "completed", "the native task completed while no Gateway process existed");
    }
    if (recoveryCrash) {
      const interrupted = gateway(config, recoveryCrash === "after" ? "crash-after-recovered" : "crash-recover"); children.push(interrupted);
      assert.equal((await interrupted.exited).signal, "SIGKILL", interrupted.log());
      assert.equal(receipt(receiptFile).phase, recoveryCrash === "after" ? "accepted" : "submitting");
      assert.equal((await peer.request("server/diagnostics")).process.id, beforeCore);
    }
    const second = gateway(config, "recover"); children.push(second); await second.ready;
    await until(() => ["accepted", "handled"].includes(receipt(receiptFile).phase), 10000);
    assert.equal(receipt(receiptFile).threadId, accepted.threadId); assert.equal(receipt(receiptFile).turnId, accepted.turnId);
    assert.equal(receipt(receiptFile).clientUserMessageId, accepted.clientUserMessageId);
    assert.equal((await peer.request("server/diagnostics")).process.id, beforeCore);
    assert.equal(f.calls.filter((call: any) => JSON.stringify(call.input).includes("CRASH_INPUT")).length, 1);
    if (releaseProbe) {
      const { claimRuntimeRelease } = await import("../scripts/release-local.mjs");
      const lease = await claimRuntimeRelease(new URL(fs.readFileSync(releaseProbe, "utf8")), second.child.pid);
      assert.ok(lease.id);
      await lease.cancel();
    }
    release.resolve();
    await until(() => fs.existsSync(deliveries) && fs.readFileSync(deliveries, "utf8").includes("CRASH_RESULT"), 12000);
    const media = () => fs.readFileSync(deliveries, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(item => item.kind === "file" && item.path === outputFile);
    await until(() => media().length === 1);
    await until(() => receipt(receiptFile).phase === "handled");
    await second.command("sync"); await second.command("stop"); assert.equal((await second.exited).code, 0, second.log());
    const third = gateway(config, "recover"); children.push(third); await third.ready; await third.command("sync");
    const answers = fs.readFileSync(deliveries, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(item => item.text.includes("CRASH_RESULT"));
    assert.equal(answers.length, 1); assert.equal(media().length, 1);
    const history = await f.runner().getHistory(accepted.threadId);
    assert.equal(history.filter(item => item.role === "user" && item.clientUserMessageId === accepted.clientUserMessageId).length, 1);
    assert.equal((await peer.request("server/diagnostics")).process.id, beforeCore);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(paths.runtimeDir, "fixture", "forwarding-inbox.json"), "utf8")).rows).length, 0);
  });

test("an explicit unbind survives Gateway SIGKILL while the active native turn and queued input finish once", {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN || process.platform === "win32", timeout: 60_000
}, async t => {
  const release = Promise.withResolvers<void>();
  const core = await sharedNativeCore(t, async (_input, n) => {
    if (n === 1) await release.promise;
    return message("native result " + n, n);
  });
  const children: ReturnType<typeof gateway>[] = [];
  t.after(async () => {
    release.resolve();
    for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
      await child.exited;
    }
  });
  const owner = core.runner();
  const { threadId } = await owner.createThread({ cwd: core.root, projectBinding: "none" });
  const paths = resolveStatePaths(path.join(core.root, "gateway"));
  const account = accountStatePaths(paths, "fixture");
  saveAccount(paths, { accountId: "fixture", token: "isolated-fixture", baseUrl: "https://example.test", enabled: true });
  const store = new RuntimeStateStore(account);
  const session = store.createSession("room", core.root, "Detach test", undefined, "session", undefined, { standalone: true });
  store.setSessionThread(session.id, threadId);
  const other = store.createSession("other-room", core.root, "Other chat", undefined, "session", undefined, { standalone: true });
  store.setSessionThread(other.id, threadId);
  const deliveries = path.join(core.root, "deliveries.jsonl");
  const file = path.join(core.root, "gateway-config.json");
  fs.writeFileSync(file, JSON.stringify({ gatewayRoot: paths.root, nativeHome: core.root, endpoint: core.endpoint, deliveries }));
  const first = gateway(file, "recover"); children.push(first); await first.ready;
  const active = owner.run({ threadId, cwd: core.root, prompt: "keep running", clientUserMessageId: "active-source" });
  void active.catch(() => {});
  await until(() => core.calls.length === 1);
  const queued = await owner.addQueuedSubmission({ threadId, prompt: "keep queued", clientUserMessageId: "queued-source" });
  await first.command("unbind");
  assert.ok(new RuntimeStateStore(account).isSessionDetached("room"));
  first.child.kill("SIGKILL");
  assert.equal((await first.exited).signal, "SIGKILL");
  const second = gateway(file, "recover"); children.push(second); await second.ready;
  await second.command("message-after-unbind");
  assert.match(fs.readFileSync(deliveries, "utf8"), /未绑定任何 session/);
  const restored = new RuntimeStateStore(account);
  assert.equal(restored.getBoundSession("room"), undefined);
  assert.equal(restored.getSession(session.id)?.threadId, threadId);
  assert.equal(restored.getBoundSession("other-room")?.threadId, threadId);
  assert.equal(restored.isSessionDetached("room"), true);
  assert.deepEqual((await owner.listQueuedSubmissions(threadId)).data.map(item => item.id), [queued.id]);
  release.resolve();
  await active;
  await until(() => core.calls.length === 2);
  for (let i = 0; i < 100; i++) {
    if ((await owner.getHistory(threadId)).some(item => item.clientUserMessageId === "queued-source" && item.turnStatus === "completed")) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const history = await owner.getHistory(threadId);
  for (const id of ["active-source", "queued-source"]) {
    const matched = history.filter(item => item.clientUserMessageId === id);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].turnStatus, "completed");
  }
  assert.equal(core.calls.length, 2);
  assert.equal((await owner.listQueuedSubmissions(threadId)).data.length, 0);
  await second.command("stop");
  assert.equal((await second.exited).code, 0);
});
