import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TaskboardDatabase } from "../taskboard/server/database.mjs";
import { sharedNativeCore, message, until } from "./fixtures/shared-native-core.mjs";

const fixture = fileURLToPath(new URL("./fixtures/taskboard-crash-native.mjs", import.meta.url));
function worker(config: string, mode: string) {
  const child = spawn(process.execPath, ["--import", "tsx", fixture, config, mode], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let log = "", id = 0;
  for (const stream of [child.stdout!, child.stderr!]) stream.on("data", chunk => { log = (log + chunk).slice(-16000); });
  const ready = Promise.withResolvers<void>(), pending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
  void ready.promise.catch(() => {});
  child.on("message", (m: any) => { if (m.ready) ready.resolve(); const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); m.error ? p.reject(Error(m.error)) : p.resolve(m); });
  const exited = new Promise<NodeJS.Signals | number | null>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => {
      const error = Error(`Taskboard fixture exited ${code}/${signal}: ${log}`); ready.reject(error);
      for (const p of pending.values()) p.reject(error); pending.clear(); resolve(signal ?? code);
    });
  });
  return { child, ready: ready.promise, exited, log: () => log, command(command: string) {
    const p = Promise.withResolvers<any>(); pending.set(++id, p); child.send({ id, command }); return p.promise;
  } };
}

for (const commit of ["before", "after"]) for (const offline of [false, true]) {
  test(`TB-09.6: real SIGKILL ${commit} native acceptance commit, completedOffline=${offline}`, {
    skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN || process.platform === "win32", timeout: 60000,
  }, async t => {
    const release = Promise.withResolvers<void>(), children: ReturnType<typeof worker>[] = [];
    t.after(() => release.resolve());
    const f = await sharedNativeCore(t, async (_body: any, n: number) => { await release.promise; return message("TASKBOARD_CRASH_RESULT", n); });
    // Registered after the core cleanup so child databases/connections retire first.
    t.after(async () => { for (const w of children) {
      if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill("SIGKILL"); await w.exited;
    } });
    const c = { root: f.root, endpoint: f.endpoint, databasePath: path.join(f.root, "taskboard.sqlite"),
      codexStatePath: path.join(f.root, "device.json"), marker: path.join(f.root, "crash.json"), clientId: crypto.randomUUID() };
    fs.writeFileSync(c.codexStatePath, JSON.stringify({ "local-projects": { selected: { rootPaths: [f.root] } } }));
    const database = new TaskboardDatabase(c.databasePath);
    database.createProject({ id: "selected", name: "Selected", workspacePath: f.root }); database.close();
    const config = path.join(f.root, "child.json"); fs.writeFileSync(config, JSON.stringify(c));
    const peer = await f.rpc("taskboard_crash_owner"), corePid = (await peer.request("server/diagnostics")).process.id;
    const first = worker(config, commit); children.push(first);
    assert.equal(await first.exited, "SIGKILL", first.log());
    const accepted = JSON.parse(fs.readFileSync(c.marker, "utf8"));
    const readDb = new TaskboardDatabase(c.databasePath), durable = readDb.getAiChatNativeReceipt(accepted.runId); readDb.close();
    assert.equal(durable.phase, commit === "before" ? "submitting" : "accepted");
    assert.equal(durable.clientUserMessageId, c.clientId); assert.equal(durable.nativeThreadId, accepted.receipt.nativeThreadId);
    await until(() => f.calls.length === 1);
    assert.equal((await peer.request("server/diagnostics")).process.id, corePid);
    if (offline) {
      release.resolve();
      let status: string | undefined;
      for (let n = 0; n < 100 && status !== "completed"; n++) {
        const reply = await peer.request("thread/read", { threadId: accepted.receipt.nativeThreadId, includeTurns: true });
        status = reply.thread.turns.find((x: any) => x.id === accepted.receipt.nativeTurnId)?.status;
        if (status !== "completed") await new Promise(r => setTimeout(r, 30));
      }
      assert.equal(status, "completed", "native run finishes with no Taskboard process");
    }
    const second = worker(config, "recover"); children.push(second); await second.ready;
    release.resolve();
    let snapshot: any;
    for (let n = 0; n < 200; n++) {
      snapshot = await second.command("snapshot"); if (snapshot.run.status !== "running") break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(snapshot.run.status, "completed", second.log());
    assert.equal(snapshot.receipt.nativeTurnId, accepted.receipt.nativeTurnId);
    assert.equal(snapshot.receipt.clientUserMessageId, c.clientId);
    assert.equal(snapshot.submission.status, "acknowledged"); assert.equal(snapshot.submission.run.id, accepted.runId);
    assert.equal(snapshot.snapshot.events.filter((x: any) => x.role === "user").length, 1);
    assert.equal(snapshot.snapshot.events.filter((x: any) => x.role === "assistant" && x.content === "TASKBOARD_CRASH_RESULT").length, 1);
    await second.command("stop"); assert.equal(await second.exited, 0);
    const third = worker(config, "recover"); children.push(third); await third.ready;
    const again = await third.command("snapshot"); assert.deepEqual(again.snapshot.events, snapshot.snapshot.events);
    assert.equal(again.run.status, "completed"); assert.equal(f.calls.length, 1);
    const history = await f.runner().getHistory(accepted.receipt.nativeThreadId);
    assert.equal(history.filter(x => x.role === "user" && x.clientUserMessageId === c.clientId).length, 1);
    assert.equal((await peer.request("server/diagnostics")).process.id, corePid);
  });
}
