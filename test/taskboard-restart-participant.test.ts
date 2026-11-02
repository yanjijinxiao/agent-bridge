import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountManager, RuntimeConfigurationBusyError } from "../src/server/account-manager.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";

test("Taskboard handoffs participate in the existing release lease without waiting for independent native tasks", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-taskboard-release-"));
  let blocked = true, paused = 0, resumed = 0;
  const manager = new AccountManager({ paths: resolveStatePaths(root),
    configProvider: () => ({ ...defaultConfig(root), taskboardEnabled: false }),
    restartParticipant: { hasRestartBlockingWork() { return blocked; }, pauseForRestart() { paused++; }, resumeAfterCancelledRestart() { resumed++; } } });
  t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const id = crypto.randomUUID();
  assert.throws(() => manager.prepareRelease(id), RuntimeConfigurationBusyError);
  assert.equal(paused, 0);
  blocked = false;
  manager.prepareRelease(id); manager.prepareRelease(id);
  assert.equal(paused, 1, "synchronous freeze belongs to the one existing owner lease");
  assert.equal(manager.cancelRelease(crypto.randomUUID()), false); assert.equal(resumed, 0);
  assert.equal(manager.cancelRelease(id), true); assert.equal(resumed, 1);
});

test("embedded clients borrow one selected adapter and cannot close it or submit through the release freeze", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-taskboard-borrow-"));
  let created = 0, closed = 0, writes = 0;
  const backend = { async warmUp() {}, async listModels() { return []; }, async run(input: any) { input.assertCurrent(); writes++; return { threadId: "thread", turnId: "turn", text: "done", raw: "" }; },
    async close() { closed++; }, hasInFlightWork() { return false; } };
  const manager = new AccountManager({ paths: resolveStatePaths(root), configProvider: () => ({ ...defaultConfig(root), taskboardEnabled: false }),
    runnerFactory: () => { created++; return backend as never; } });
  t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const first = manager.taskboardNativeBackend() as any, second = manager.taskboardNativeBackend() as any;
  await first.listModels(); await second.listModels();
  assert.equal(created, 1);
  await first.close(); assert.equal(closed, 0);
  await second.run({ cwd: root, prompt: "isolated" }); assert.equal(writes, 1);
  const id = crypto.randomUUID(); manager.prepareRelease(id);
  assert.throws(() => second.run({ cwd: root, prompt: "never submitted" }), RuntimeConfigurationBusyError);
  assert.equal(writes, 1); manager.cancelRelease(id);
  await manager.stopAll(); assert.equal(closed, 1);
});

test("a custom executable name does not silently select a private stdio executor", async () => {
  const gateway = new CodexAppServerGateway({ codexBin: "/isolated/custom-name", codexHome: "/isolated/nonexistent-home", appServerTransport: "auto" });
  try { assert.equal((gateway as any).appServer.executionLifetime, "independent"); }
  finally { await gateway.close(); }
});
