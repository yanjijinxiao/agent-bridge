import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { AccountManager } from "../src/server/account-manager.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { TaskboardLifecycle } from "../src/taskboard/lifecycle.js";
import { startEmbeddedTaskboard } from "../src/taskboard/embedded-server.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { isolatedBrowser, eventually } from "./helpers/gap-browser.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { formatFollowStatus } from "../src/bridge/session-follow.js";

test("isolated production Gateway browser gap scenarios", { skip: !process.env.CODEX_CHROME_TEST_BIN, timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-browser-gaps-")), paths = resolveStatePaths(path.join(root, "state"));
  const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const taskboardPort = (reservation.address() as net.AddressInfo).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  saveConfig(paths, { ...defaultConfig(root), taskboardEnabled: false, taskboardUrl: `http://127.0.0.1:${taskboardPort}` });
  saveAccount(paths, { accountId: "account", token: "fixture", baseUrl: "https://fixture.invalid", userId: "owner", enabled: false });
  const runner = { async listProjects() { return { backend: "app-server", projects: [] }; }, async getHistory() { return []; },
    async inspectThread(threadId: string) { return { threadId, cwd: root, persistence: "active", runtimeStatus: "idle", activeFlags: [] }; }, close() {} };
  const manager = new AccountManager({ paths, configProvider: () => loadConfig(paths), runnerFactory: () => runner as never, ideProjectsProvider: () => [] });
  const project = manager.createProject("account", "LongProject".repeat(20), root);
  const session = manager.createSession("account", "conversation".repeat(30), root, "LongTitle".repeat(30), project.id);
  const store = (manager as any).storeFor("account"); store.setSessionThread(session.id, "native-thread-".repeat(20));
  let starts = 0;
  const lifecycle = new TaskboardLifecycle(path.join(root, "taskboard"), async input => { starts++; assert.equal(process.pid, gatewayPid); return startEmbeddedTaskboard(input); });
  const gatewayPid = process.pid;
  const options = { paths, accountManager: manager, port: 0, onTaskboardConfig: (config: any) => lifecycle.apply(config),
    codexCheck: async () => ({ ready: true, version: "fixture" }), codexRuntimeCheck: async () => ({}) as never,
    codexModelsCheck: async () => [], codexProjectsProvider: () => [] };
  let server = await startLocalHttpServer(options);
  let closeBrowser: (() => Promise<void>) | undefined;
  // Retire the browser's open iframe/requests before awaiting the services it
  // consumes. after hooks otherwise wait in registration order and can deadlock.
  t.after(async () => { await closeBrowser?.(); await server.close(); await manager.stopAll(); await lifecycle.close(); });
  const browser = await isolatedBrowser(t, root), { evaluate, call } = browser;
  closeBrowser = browser.close;
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const navigate = async (view: string) => { await call("Page.navigate", { url: `${server.url}/#${view}` });
    await eventually(() => evaluate("typeof state !== 'undefined' && Boolean(state.requestToken && document.querySelector('.session-card'))"), "production management page did not bootstrap"); };
  await navigate("sessions");
  await t.test("DEL-01.3: Web and IM show a completed native turn with pending delivery separately from channel acknowledgement, never device acceptance", async () => {
    const previous = (manager as any).threadEvents; let fail = true;
    const threadId = store.getSession(session.id).threadId;
    const sub: ThreadSubscription = { key: JSON.stringify(["account", session.id]), hostId: "local", threadId, recipientId: session.senderId, managed: false,
      client: { resumableTextStream: true, async sendText() { return { messageId: "notice" }; },
        async startTextStream(input) { if (fail) throw Error("fixture failed delivery"); return { messageId: input.streamId! }; }, async updateTextStream() {} } };
    const hub = new ThreadEventHub({ filePath: path.join(root, "delivery.json"), subscriptions: () => [sub], backend: () => ({ async readThreadSnapshot() {
      return { state: { threadId, persistence: "active", runtimeStatus: "idle", activeFlags: [] }, turns: [{ id: "completed", status: "completed", messages: [{ id: "a", role: "assistant", text: "final" }] }] };
    } }) }); (manager as any).threadEvents = hub;
    try {
      await hub.started("local", threadId, "completed", new Date().toISOString()); await hub.completion("local", threadId, "completed", "final");
      const pending = await hub.synchronize(sub.key); assert.equal(pending.runtime?.runtimeStatus, "idle");
      assert.match(formatFollowStatus(pending).join("\n"), /任务完成不等于回答已送达/);
      await evaluate("refreshData(false)"); assert.match(await evaluate("document.querySelector('#sessionsList').textContent"), /1 轮待投递/);
      const api = await (await fetch(`${server.url}/api/sessions`)).json() as any;
      assert.equal(api.sessions[0].followStatus.resultDelivery.pending, 1);
      fail = false; await hub.synchronize(sub.key); await evaluate("refreshData(false)");
      const visible = await evaluate("document.querySelector('#sessionsList').textContent");
      assert.match(visible, /渠道已确认接收/); assert.doesNotMatch(visible, /轮待投递|用户已读|手机已显示|实机验收通过/);
    } finally { await hub.stop(); (manager as any).threadEvents = previous; }
  });
  await t.test("WEB-01.3: a real old page reconnects after server restart and submits a form exactly once; a lost mutation response is not replayed", async () => {
    const oldToken = await evaluate("state.requestToken"), origin = server.url;
    await server.close(); server = await startLocalHttpServer({ ...options, port: Number(new URL(origin).port) });
    assert.notEqual(server.requestToken, oldToken);
    let renames = 0; const rename = manager.renameSession.bind(manager);
    const spy = t.mock.method(manager, "renameSession", (...args) => { renames++; return rename(...args); });
    await evaluate("window.gapRequests=[];window.gapFetch=window.fetch.bind(window);window.fetch=async(...a)=>{gapRequests.push({url:String(a[0]),method:a[1]?.method});return gapFetch(...a)};document.querySelector('[data-session-action=rename]').click();document.querySelector('#sessionTitleInput').value='Renamed once';document.querySelector('#sessionForm').requestSubmit()");
    await eventually(() => manager.listSessions()[0].title === "Renamed once", "rename did not persist");
    await eventually(() => evaluate("!document.querySelector('#sessionDialog').open"), "rename form remained pending");
    assert.equal(renames, 1); assert.equal(await evaluate("gapRequests.filter(r=>r.url==='/api/request-context').length"), 1);
    assert.equal(await evaluate("gapRequests.filter(r=>r.method==='PATCH').length"), 2, "first stale-token attempt is rejected before submission");
    await evaluate("window.gapLost=false;window.fetch=async(...a)=>{const r=await gapFetch(...a);if(a[1]?.method==='PATCH'){gapLost=true;throw new TypeError('fixture response lost after server commit')}return r};document.querySelector('[data-session-action=rename]').click();document.querySelector('#sessionTitleInput').value='Committed with lost receipt';document.querySelector('#sessionForm').requestSubmit()");
    await eventually(() => evaluate("gapLost"), "lost response was not injected");
    await eventually(() => evaluate("!document.querySelector('#sessionForm button[type=submit]').disabled"), "unknown submission did not settle");
    assert.equal(renames, 2); assert.equal(manager.listSessions()[0].title, "Committed with lost receipt");
    await evaluate("window.fetch=gapFetch"); spy.mock.restore();
  });
  await t.test("WEB-02.2: disabled Taskboard does not load an iframe; the native enable button starts the embedded service inside the same Gateway process", async () => {
    await evaluate("document.querySelector('#sessionDialog').close();document.querySelector('[data-view=taskboard]').click()");
    await eventually(() => evaluate("!document.querySelector('#taskboardEnable').hidden"), "disabled Taskboard placeholder missing");
    assert.equal(await evaluate("document.querySelector('#taskboardFrame').hasAttribute('src')"), false);
    await evaluate("document.querySelector('#taskboardEnable').click()");
    await eventually(() => evaluate("Boolean(document.querySelector('#taskboardFrame').getAttribute('src'))"), "enabled iframe was not connected");
    assert.equal(starts, 1); assert.equal(process.pid, gatewayPid); assert.equal(loadConfig(paths).taskboardEnabled, true);
    assert.equal((await fetch(`http://127.0.0.1:${taskboardPort}/health`)).status, 200);
    assert.equal(await evaluate("document.querySelector('#taskboardFrame').src"), `http://127.0.0.1:${taskboardPort}/`);
  });
  await t.test("WEB-02.3: actual Gateway management views, long identifiers, forms and IDE buttons fit a 375px Chrome viewport", async () => {
    manager.renameSession("account", session.id, "LongTitle".repeat(30)); await evaluate("refreshData(false)");
    await call("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    for (const view of ["accounts", "sessions", "bindings", "approvals", "taskboard", "knowledge", "ide", "settings"]) {
      await evaluate(`document.querySelector('[data-view=${view}]').click()`);
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth+1"), true, `document overflow in ${view}`);
    }
    await evaluate("document.querySelector('[data-view=sessions]').click()");
    assert.ok((await evaluate("document.querySelector('#sessionsList').textContent")).includes("native-thread-".repeat(20)));
    assert.equal(await evaluate("document.querySelector('#sessionIDEButton').getBoundingClientRect().right <= innerWidth+1"), true);
    for (const id of await evaluate<string[]>("Array.from(document.querySelectorAll('dialog:has(form)')).map(d=>d.id)")) {
      await evaluate(`document.querySelector('#${id}').showModal()`);
      assert.equal(await evaluate(`(()=>{const d=document.querySelector('#${id}');return d.getBoundingClientRect().right<=innerWidth+1 && d.getBoundingClientRect().left>=-1 && d.scrollWidth<=d.clientWidth+1})()`), true, `${id} form overflow`);
      await evaluate(`document.querySelector('#${id}').close()`);
    }
    for (const button of ["#addAccountButton", "#addProjectButton"]) {
      await evaluate("document.querySelector('[data-view=sessions]').click()");
      await evaluate(`document.querySelector(${JSON.stringify(button)}).click()`);
      assert.equal(await evaluate("Array.from(document.querySelectorAll('dialog[open]')).every(d=>d.getBoundingClientRect().right<=innerWidth+1 && d.getBoundingClientRect().left>=-1 && d.scrollWidth<=d.clientWidth+1)"), true, `${button} dialog overflow`);
      await evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close())");
    }
  });
});
