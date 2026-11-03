import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskboardServer, resolveServerOptions } from "../server/app.mjs";
import { fakeNativeCore } from "./helpers/native-backend.mjs";

test("an explicit Codex home supplies the AI project's full root set", async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "taskboard-home-audit-")));
  const codexHome = path.join(directory, "codex"), first = path.join(directory, "first"), second = path.join(directory, "second");
  await Promise.all([codexHome, first, second].map(p => mkdir(p)));
  await writeFile(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({ "local-projects": { project: { rootPaths: [first, second] } } }));
  const core = fakeNativeCore();
  const app = createTaskboardServer({ dataDirectory: directory, codexHome, nativeBackend: core.client() });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  app.database.createProject({ id: "project", name: "Project", workspacePath: first });
  const thread = await app.aiChat.createThread({ projectId: "project" });
  await app.aiChat.startTurn(thread.id, { message: "check roots" });
  for (let i = 0; i < 100 && !core.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(core.calls[0]?.nativeSettings.runtimeWorkspaceRoots, [first, second]);
  assert.equal(app.options.codexStatePath, path.join(codexHome, ".codex-global-state.json"));
  assert.equal(app.options.codexProcessesPath, path.join(codexHome, "process_manager", "chat_processes.json"));
});

test("explicit Codex state paths still override home-derived defaults", () => {
  const options = resolveServerOptions({ codexHome: "/home/fixture", codexStatePath: "/custom/state.json", codexProcessesPath: "/custom/processes.json" });
  assert.equal(options.codexStatePath, "/custom/state.json");
  assert.equal(options.codexProcessesPath, "/custom/processes.json");
});
