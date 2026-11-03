import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withConnectorProjects } from "../src/peer/project-catalog.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";

test("Connector project projection matches native session aliases without changing local or SSH discovery", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "peer-project-map-")); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { legacy: { id: "legacy", rootPaths: ["/tmp/project"] } },
    "app-server-project-id-by-legacy-project-id-by-host": { [`local:${home}`]: { legacy: "project-native" }, "local:/wrong-home": { wrong: "project-native" } }
  }));
  const runner = new AppServerCodexRunner({ codexHome: home, hostId: "local", requestTimeoutMs: 2000,
    transport: { command: process.execPath, args: [path.resolve("test/fixtures/fake-codex-app-server.mjs"), "--lifecycle-only"], mode: "remote-daemon" } });
  const native = new CodexAppServerGateway({ appServerBackend: runner }); t.after(() => native.close());
  const device = withConnectorProjects(native, home);
  const project = (await device.listProjects()).projects[0]; assert.equal(project.id, "legacy");
  const created = await device.createThread!({ cwd: "/tmp/project", projectId: project.id });
  assert.equal(created.projectId, project.id); assert.equal((await device.inspectThread(created.threadId)).projectId, project.id);
  assert.equal((await native.listProjects()).projects[0].id, "project-native", "the underlying catalog remains unchanged");
  assert.equal((await withConnectorProjects(native, path.join(home, "unrelated")).listProjects()).projects[0].id, "project-native");
});
