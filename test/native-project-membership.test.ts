import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

test("wire project membership is consistent across inspection, follow snapshots, lifecycle and catalogs", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-native-membership-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ids = ["assigned", "removed", "omitted", "malformed"];
  fs.writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { legacy: { id: "legacy", rootPaths: ["/tmp/project"] } },
    "app-server-project-id-by-legacy-project-id-by-host": { [`local:${home}`]: { legacy: "native-project" } },
    "thread-project-assignments": Object.fromEntries(ids.map(id => [id, { projectId: "legacy" }]))
  }));
  const runner = new AppServerCodexRunner({ codexHome: home, hostId: "local", catalogSource: "native", transport: {
    command: process.execPath, mode: "daemon-proxy", args: [
      fileURLToPath(new URL("fixtures/fake-codex-app-server.mjs", import.meta.url)), "--native-membership-shapes"
    ]
  } });
  t.after(() => runner.close());
  const expected = (id: string) => ({ projectId: id === "assigned" ? "legacy" : undefined,
    projectMembership: id === "assigned" ? "assigned" : id === "removed" ? "none" : "unknown" });
  const membership = (s: { projectId?: string; projectMembership?: string }) => ({ projectId: s.projectId, projectMembership: s.projectMembership });
  for (const id of ids) {
    assert.deepEqual(membership(await runner.inspectThread(id, { includeTurns: false, timeoutMs: 2000 })), expected(id), `metadata ${id}`);
    assert.deepEqual(membership((await runner.readThreadSnapshot(id)).state), expected(id), `follow ${id}`);
    assert.deepEqual(membership(await runner.unarchiveThread(id)), expected(id), `lifecycle ${id}`);
  }
  const catalog = await runner.listSessionCatalog();
  assert.equal(catalog.threads.length, 4);
  for (const state of catalog.threads) assert.deepEqual(membership(state), expected(state.threadId));
  assert.deepEqual((await runner.listThreads({ projectId: "legacy", persistence: "active" })).map(s => s.threadId), ["assigned"]);
  assert.deepEqual((await runner.listThreads({ unassigned: true, persistence: "active" })).map(s => s.threadId).sort(), ["malformed", "omitted", "removed"]);
});
