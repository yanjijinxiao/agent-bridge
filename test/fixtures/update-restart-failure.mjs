import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AccountManager } from "../../src/server/account-manager.ts";
import { startLocalHttpServer } from "../../src/server/http-server.ts";
import { resolveStatePaths } from "../../src/state/paths.ts";

const mode = process.argv[2];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-update-restart-"));
const paths = resolveStatePaths(root), manager = new AccountManager({ paths });
let calls = 0, server;
try {
  server = await startLocalHttpServer({ paths, accountManager: manager, port: 0,
    updateService: { async check() { throw Error("unused"); },
      async installLatest() { return { version: "9.9.0", registry: "official" }; } },
    onUpdateInstalled() {
      calls++;
      if (mode === "sync-failure") throw Error("Synthetic helper launch failure");
      if (mode === "async-failure") return delay(10).then(() => { throw Error("Synthetic async helper launch failure"); });
      return delay(10); // Acknowledged helper launch; the old process retains its lease until exit.
    }
  });
  const response = await fetch(`${server.url}/api/update`, { method: "POST",
    headers: { Origin: server.url, "X-Codex-Im-Gateway-Token": server.requestToken } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).restarting, true);
  await delay(600);
  assert.equal(calls, 1);
  assert.equal(manager.releaseStatus().prepared, mode === "accepted");
  assert.equal((await fetch(`${server.url}/api/request-context`)).status, 200);
  console.log(JSON.stringify({ mode, calls, prepared: manager.releaseStatus().prepared, alive: true }));
} finally {
  await server?.close(); await manager.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}
