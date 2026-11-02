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
  { existing: false, completedOffline: true, recoveryCrash: "after" }
]) test(`IN-02.2: real SIGKILL acceptance recovery without replay ${JSON.stringify(scenario)}`,
  { skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN || process.platform === "win32", timeout: 60000 }, async t => {
    const { existing, completedOffline, recoveryCrash } = scenario;
    const children: Array<ReturnType<typeof gateway>> = [], release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    t.after(async () => { for (const child of children) {
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
      await child.exited;
    } });
    const memory = { kind: "knowledge", scope: "account", title: "crash-recovered-output", content: "Recovered exact input" };
    const final = 'CRASH_RESULT\n```codex-im-gateway-actions\n' + JSON.stringify({ remember: [memory] }) + '\n```';
    const f = await sharedNativeCore(t, async (body: any, n: number) => {
      if (JSON.stringify(body.input).includes("CRASH_INPUT")) { await release.promise; return message(final, n); }
      return message("INITIALIZED", n);
    });
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
    fs.writeFileSync(config, JSON.stringify({ gatewayRoot: paths.root, nativeHome: f.root, endpoint: f.endpoint, receiptFile, deliveries, crashMarker }));
    const first = gateway(config, "crash"); children.push(first);
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
    release.resolve();
    await until(() => fs.existsSync(deliveries) && fs.readFileSync(deliveries, "utf8").includes("CRASH_RESULT"), 12000);
    const knowledge = () => new RuntimeStateStore(accountStatePaths(paths, "fixture")).listKnowledge().filter(item => item.title === memory.title);
    await until(() => knowledge().length === 1);
    await until(() => receipt(receiptFile).phase === "handled");
    await second.command("sync"); await second.command("stop"); assert.equal((await second.exited).code, 0, second.log());
    const third = gateway(config, "recover"); children.push(third); await third.ready; await third.command("sync");
    const answers = fs.readFileSync(deliveries, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(item => item.text.includes("CRASH_RESULT"));
    assert.equal(answers.length, 1); assert.equal(knowledge().length, 1);
    const history = await f.runner().getHistory(accepted.threadId);
    assert.equal(history.filter(item => item.role === "user" && item.clientUserMessageId === accepted.clientUserMessageId).length, 1);
    assert.equal((await peer.request("server/diagnostics")).process.id, beforeCore);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(paths.runtimeDir, "fixture", "forwarding-inbox.json"), "utf8")).rows).length, 0);
  });
