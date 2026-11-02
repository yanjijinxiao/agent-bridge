import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-project-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new RuntimeStateStore(resolveStatePaths(root)) };
}
test("a new local session never inherits a remote project's identical cwd", t => {
  const { root, store } = fixture(t), remote = store.createProject("Remote", root, { hostId: "remote", sourceProjectId: "native" });
  const session = store.createSession("room", root);
  assert.notEqual(session.projectId, remote.id);
  assert.equal(store.sessionBindingTarget(session).hostId, "local");
});
test("root-only session creation refuses two distinct native projects and leaves session state untouched", t => {
  const { root, store } = fixture(t);
  store.createProject("A", root, { sourceProjectId: "native-a" }); store.createProject("B", root, { sourceProjectId: "native-b" });
  assert.throws(() => store.createSession("room", root), /多个|ambiguous|选择项目/);
  assert.equal(store.listSessions().length, 0); assert.equal(store.getBoundSession("room"), undefined);
});
test("an explicit project still wins when several native projects share its root", t => {
  const { root, store } = fixture(t);
  store.createProject("A", root, { sourceProjectId: "native-a" }); const chosen = store.createProject("B", root, { sourceProjectId: "native-b" });
  assert.equal(store.createSession("room", root, "Task", chosen.id).projectId, chosen.id);
});
test("an explicit host is used for legacy root resolution instead of selecting the first local project", t => {
  const { root, store } = fixture(t);
  store.createProject("Local", root); const remote = store.createProject("Remote", root, { hostId: "remote" });
  assert.equal(store.createSession("room", root, "Task", undefined, "session", undefined, { hostId: "remote" }).projectId, remote.id);
});
test("session context cannot override an explicitly selected project's host", t => {
  const { root, store } = fixture(t), chosen = store.createProject("Local", root);
  assert.throws(() => store.createSession("room", root, "Task", chosen.id, "session", undefined, { hostId: "remote" }), /主机|host/);
  assert.equal(store.listSessions().length, 0);
});
