import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountManager } from "../src/server/account-manager.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { defaultConfig } from "../src/state/config.js";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-setting-controls-")), paths = resolveStatePaths(root);
  saveAccount(paths, { accountId: "account", token: "synthetic", baseUrl: "https://example.test", cdnBaseUrl: "https://example.test", enabled: false, savedAt: new Date().toISOString() });
  const settings = { model: "desktop-choice", effort: "low" }, writes: unknown[] = [], reads: unknown[] = [];
  const backend = { async warmUp() {}, async close() {},
    async getRuntimeInfo(cwd: string, id?: string, host?: string) { reads.push([cwd, id, host]); return { ...settings }; },
    async updateThreadSettings(id: string, patch: object, host?: string, guard?: () => void) {
      guard?.(); writes.push([id, patch, host]); Object.assign(settings, patch); return { ...settings };
    } };
  const manager = new AccountManager({ paths, configProvider: () => defaultConfig(root), runnerFactory: () => backend as never });
  const store = new RuntimeStateStore(accountStatePaths(paths, "account"));
  const project = store.createProject("Native", root), session = store.createSession("room", root, "Chosen", project.id);
  store.setSessionThread(session.id, "native-thread");
  t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, store, session, manager, backend, settings, writes, reads };
}

test("Web session settings write the selected native thread and keep only presentation preferences on disk", async t => {
  const f = await fixture(t), server = await startLocalHttpServer({ paths: f.paths, accountManager: f.manager, port: 0,
    codexCheck: async () => ({ ready: true }), codexRuntimeCheck: async () => ({}), codexModelsCheck: async () => [] });
  t.after(() => server.close());
  const bootstrap = await (await fetch(`${server.url}/api/bootstrap`)).json() as { requestToken: string };
  const url = `${server.url}/api/sessions/account/${f.session.id}`;
  const response = await fetch(url, { method: "PATCH", headers: { Origin: server.url, "Content-Type": "application/json", "X-Codex-Weixin-Token": bootstrap.requestToken }, body: JSON.stringify({ effort: "high", streamReplies: false }) });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(f.writes, [["native-thread", { effort: "high" }, "local"]]);
  const saved = new RuntimeStateStore(accountStatePaths(f.paths, "account")).getSession(f.session.id)!;
  assert.equal(saved.model, undefined); assert.equal(saved.effort, undefined); assert.equal(saved.streamReplies, false);
  f.settings.model = "later-desktop-choice";
  const current = await (await fetch(`${url}/runtime`)).json() as any;
  assert.equal(current.runtime.model, "later-desktop-choice");
  assert.deepEqual(f.reads.at(-1), [f.root, "native-thread", "local"]);
  await f.manager.updateSessionRuntime("account", f.session.id, { model: null, effort: null });
  assert.equal(f.writes.length, 1, "old inherit controls must not reset native settings");
});

test("settings reject a changed binding after asynchronous preparation without writing to either target", async t => {
  const f = await fixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.backend.updateThreadSettings = async (_id, _patch, _host, guard) => { entered.resolve(); await release.promise; guard?.(); f.writes.push("wrong"); return {}; };
  const pending = f.manager.updateSessionRuntime("account", f.session.id, { model: "new-choice" });
  const rejected = assert.rejects(pending, /会话已改变/);
  await entered.promise; f.store.setSessionThread(f.session.id, "replacement"); release.resolve(); await rejected;
  assert.equal(f.writes.length, 0);
});

test("unknown settings receipts are not replayed and do not leave a Gateway override", async t => {
  const f = await fixture(t); let attempts = 0;
  f.backend.updateThreadSettings = async () => { attempts++; throw new CodexCommunicationError("submission", "thread/settings/update", "native-thread"); };
  await assert.rejects(f.manager.updateSessionRuntime("account", f.session.id, { model: "possibly-applied" }), error => error instanceof CodexCommunicationError && error.submission === "unconfirmed");
  assert.equal(attempts, 1);
  assert.equal(new RuntimeStateStore(accountStatePaths(f.paths, "account")).getSession(f.session.id)?.model, undefined);
});

test("an unstarted Gateway session creates and records one native identity before applying settings", async t => {
  const f = await fixture(t);
  const session = f.store.createSession("another-room", f.root, "New native session", f.session.projectId);
  const creates: string[] = [];
  (f.backend as any).createThread = async (input: any) => {
    input.assertCurrent(); creates.push(input.title);
    await input.onThreadCreated("created-native");
    return { threadId: "created-native" };
  };
  await f.manager.updateSessionRuntime("account", session.id, { model: "chosen" });
  assert.deepEqual(creates, ["New native session"]);
  assert.deepEqual(f.writes, [["created-native", { model: "chosen" }, "local"]]);
  assert.equal(new RuntimeStateStore(accountStatePaths(f.paths, "account")).getSession(session.id)?.threadId, "created-native");
});
