import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

// A real child process exposes unhandled async rejection, rather than masking
// it with the test runner's own event handlers. No production service is used.
for (const mode of ["sync-failure", "async-failure", "accepted"]) {
  test(`HTTP update restart handoff keeps service alive and releases only failed launches (${mode})`, async () => {
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./fixtures/update-restart-failure.mjs", import.meta.url)), mode],
      { timeout: 10_000 });
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    assert.deepEqual(result, { mode, calls: 1, prepared: mode === "accepted", alive: true });
  });
}

test("npm preparation keeps admission open until a concrete release is ready", async t => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { startLocalHttpServer } = await import("../src/server/http-server.js");
  const { AccountManager } = await import("../src/server/account-manager.js");
  const { resolveStatePaths } = await import("../src/state/paths.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-prepare-admission-")), paths = resolveStatePaths(root);
  const manager = new AccountManager({ paths }), ready = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  let deliveredPlan: string | undefined;
  const server = await startLocalHttpServer({ paths, accountManager: manager, port: 0,
    updateService: { check: async () => { throw Error("unused"); }, installLatest: async () => {
      started.resolve(); await ready.promise; return { version: "9.9.0", registry: "official", releasePlan: "/private/prepared/release.json" };
    } }, onUpdateInstalled: (_version, plan) => { deliveredPlan = plan; } });
  t.after(async () => { ready.resolve(); await server.close(); await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const pending = fetch(`${server.url}/api/update`, { method: "POST", headers: { Origin: server.url, "X-Codex-Im-Gateway-Token": server.requestToken } });
  await started.promise;
  assert.equal(manager.releaseStatus().prepared, false, "downloads are not an active Gateway handoff");
  assert.equal((await fetch(`${server.url}/api/request-context`)).status, 200);
  ready.resolve(); const response = await pending;
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.releasePlan, undefined, "internal artifact paths are not UI payloads");
  assert.equal(manager.releaseStatus().prepared, true);
  await new Promise(r => setTimeout(r, 350)); assert.equal(deliveredPlan, "/private/prepared/release.json");
});
