import assert from "node:assert/strict";
import cp, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProcessIDEHostTransport } from "../src/ide/transport.js";

test("IDE-03.2: an exited owned process with a reused numeric PID cannot signal an unrelated live process on repeated cleanup", { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-ide-pid-")), spawned: ChildProcess[] = [], original = cp.spawn;
  const capture = t.mock.method(cp, "spawn", ((...args: Parameters<typeof cp.spawn>) => { const child = original(...args); spawned.push(child); return child; }) as typeof cp.spawn);
  syncBuiltinESMExports();
  let canary: ChildProcess | undefined, launch: Awaited<ReturnType<ProcessIDEHostTransport["launch"]>> | undefined;
  t.after(async () => { capture.mock.restore(); syncBuiltinESMExports(); await launch?.stop();
    if (canary?.exitCode === null && !canary.signalCode) { const done = new Promise(resolve => canary!.once("exit", resolve)); canary.kill(); await done; }
    fs.rmSync(root, { recursive: true, force: true }); });
  launch = await new ProcessIDEHostTransport({ localDataRoot: root }).launch({ hostId: "local", workspace: root, id: "owned",
    binary: path.resolve("test/fixtures/fake-code-server.mjs"), settings: {}, extensions: [] });
  assert.equal(spawned.length, 1); const owned = spawned[0];
  await launch.stop(); assert.equal(launch.alive(), false); assert.ok(owned.exitCode !== null || owned.signalCode);
  canary = original(process.execPath, ["-e", "setInterval(()=>{},1000);console.log('ready')"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>(resolve => canary!.stdout!.once("data", () => resolve()));
  // The OS need not actually recycle a PID: replace only the stale object's PID
  // with our test-owned canary's identity, retaining its real exit evidence.
  Object.defineProperty(owned, "pid", { value: canary.pid });
  let signals = 0; const kill = t.mock.method(owned, "kill", () => { signals++; return true; });
  await launch.stop(); await launch.stop(); kill.mock.restore();
  assert.equal(signals, 0); assert.equal(canary.exitCode, null); assert.equal(canary.signalCode, null);
  process.kill(canary.pid!, 0); // Read-only existence check on our own canary.
});
