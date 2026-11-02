import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountManager } from "../src/server/account-manager.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths, accountStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { defaultConfig } from "../src/state/config.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-gap-state-")), paths = resolveStatePaths(root);
  saveAccount(paths, { accountId: "account", userId: "owner", token: "fixture", baseUrl: "https://example.invalid", enabled: false });
  const inputs: any[] = [], texts: string[] = [];
  let receive: (input: any) => Promise<unknown> = async () => {}, aborted = false;
  let run = async (input: any) => ({ threadId: input.threadId ?? "native-thread", turnId: "turn", text: "done", raw: "" });
  const runner = { async warmUp() {}, async listProjects() { return { backend: "app-server", projects: [] }; },
    async inspectThread(threadId: string) { return { threadId, cwd: root, persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
    async run(input: any) { inputs.push(input); return run(input); }, close() {} };
  const manager = new AccountManager({ paths, ideProjectsProvider: () => [],
    configProvider: () => ({ ...defaultConfig(root), codexBackend: "app-server", taskboardEnabled: false, streamReplies: false, allowedSenderIds: [] }),
    runnerFactory: () => runner as never,
    adapterFactory: () => ({ client: createChannelClient("generic", TEXT_CAPABILITIES, {
      async sendText(input) { texts.push(input.text); return { messageId: "receipt" }; }
    }), async monitor({ signal, onStatus, onMessage }) {
      receive = onMessage; onStatus?.({ state: "connected" });
      await new Promise<void>(resolve => signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    } }),
    codexSessionMonitorFactory: () => ({ start() {}, async stop() {} }) as never,
    codexDesktopRequestMonitorFactory: () => ({ start() {}, async stop() {}, setFollowedThreads() {} }) as never });
  const store = (manager as any).storeFor("account") as RuntimeStateStore;
  t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, manager, runner, store, inputs, texts, aborted: () => aborted,
    send: (senderId: string) => receive({ id: "stranger-input", senderId, text: "do not execute", attachments: [], raw: {} }),
    setRun(fn: typeof run) { run = fn; } };
}

test("STATE-01.1: accepted long-turn completion preserves concurrent rename and explicit unbind in the sole live store and on disk", async t => {
  const f = fixture(t), session = f.manager.createSession("account", "room", f.root, "Original");
  f.store.setSessionThread(session.id, "native-thread");
  await f.manager.startAccount("account", false);
  (f.manager as any).ensureCodexSessionMonitor();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  f.setRun(async input => { await input.onTurnStarted?.({ threadId: "native-thread", turnId: "turn", status: "inProgress" });
    entered.resolve(); await release.promise; return { threadId: "native-thread", turnId: "turn", text: "done", raw: "" }; });
  const pending = f.manager.continueSession("account", session.id, "long task"); await entered.promise;
  f.manager.renameSession("account", session.id, "Edited while running");
  const detached = await f.manager.unbindSession("account", session.id, f.store.sessionBindingTarget(f.store.getSession(session.id)!));
  assert.equal(detached.changed, true);
  release.resolve(); await pending;
  const disk = new RuntimeStateStore(accountStatePaths(f.paths, "account"));
  for (const state of [f.store, disk]) {
    assert.equal(state.getSession(session.id)?.title, "Edited while running");
    assert.equal(state.getBoundSession("room"), undefined);
    assert.equal(state.getSession(session.id)?.threadId, "native-thread");
  }
  assert.equal((f.manager as any).storeFor("account"), f.store);
  assert.equal(f.inputs.length, 1);
});

const cleanupTargets = ["bindingExpiry", "capacityRecovery", "systemRecovery", "nativeRequestMonitor", "codexSessionMonitor", "threadEvents", "runner", "llmWiki"];
for (const failed of cleanupTargets) test(`STATE-02.3: cleanup failure in ${failed} does not skip other independent resources or ingress abort`, async t => {
  const f = fixture(t);
  const session = f.manager.createSession("account", "room", f.root, "Monitored");
  f.store.setSessionThread(session.id, "native-thread");
  await f.manager.startAccount("account", false);
  await f.manager.startAll();
  const calls: string[] = [], restores: Array<() => void> = [];
  try { for (const target of cleanupTargets) {
    const object = target === "runner" ? f.runner as any : (f.manager as any)[target];
    const method = target === "llmWiki" || target === "runner" ? "close" : "stop";
    assert.ok(object, `real lifecycle resource ${target} exists`);
    const original = object[method].bind(object);
    const mocked = t.mock.method(object, method, () => {
      calls.push(target); if (target === failed) throw Error("injected cleanup failure"); return original();
    });
    restores.push(() => mocked.mock.restore());
  }
    await assert.rejects(f.manager.stopAll(), AggregateError);
    assert.deepEqual([...new Set(calls)].sort(), [...cleanupTargets].sort());
    assert.equal(f.aborted(), true);
  } finally { restores.forEach(restore => restore()); }
});

for (const running of [false, true]) test(`AUTH-01.3: failed ACL persistence cannot grant in-memory admission through manager or Bridge (running=${running})`, async t => {
  const f = fixture(t); f.store.setPairedSenderIds(["existing"]);
  if (running) await f.manager.startAccount("account", false);
  const destination = accountStatePaths(f.paths, "account").statePath, rename = fs.renameSync.bind(fs);
  const fail = t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === destination) throw Object.assign(Error("injected ACL commit failure"), { code: "EACCES" });
    return rename(from, to);
  });
  try { assert.throws(() => f.manager.allowSender("account", "stranger"), /ACL commit failure/); }
  finally { fail.mock.restore(); }
  assert.deepEqual(f.store.listPairedSenderIds(), ["existing"]);
  assert.deepEqual(new RuntimeStateStore(accountStatePaths(f.paths, "account")).listPairedSenderIds(), ["existing"]);
  assert.deepEqual(f.manager.listAccounts()[0].pairedSenderIds, ["existing"]);
  if (running) {
    const service = (f.manager as any).entries.get("account").service;
    assert.deepEqual(service.listAllowedSenders(), ["existing"]);
    await service.handleMessage({ id: "stranger-input", senderId: "stranger", text: "do not execute", raw: {} });
    assert.equal(f.inputs.length, 0);
    assert.ok(f.texts.some(text => /授权|批准|配对|准入|未允许|pair|allow/i.test(text)), f.texts.join("\n"));
  }
});
