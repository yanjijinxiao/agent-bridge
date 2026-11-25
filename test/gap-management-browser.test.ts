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
  const runner = { async warmUp() {}, async listProjects() { return { backend: "app-server", projects: [] }; }, async getHistory() { return []; },
    async inspectThread(threadId: string) { return { threadId, cwd: root, persistence: "active", runtimeStatus: "idle", activeFlags: [] }; }, close() {} };
  const manager = new AccountManager({ paths, configProvider: () => loadConfig(paths), runnerFactory: () => runner as never, ideProjectsProvider: () => [] });
  const project = manager.createProject("account", "LongProject".repeat(20), root);
  const session = manager.createSession("account", "conversation".repeat(30), root, "LongTitle".repeat(30), project.id);
  const store = (manager as any).storeFor("account"); store.setSessionThread(session.id, "native-thread-".repeat(20));
  let starts = 0;
  let transitionFault: "start" | "stop" | undefined;
  const lifecycle = new TaskboardLifecycle(path.join(root, "taskboard"), async input => {
    starts++; assert.equal(process.pid, gatewayPid);
    if (transitionFault === "start") { transitionFault = undefined; throw Error("fixture start rejected"); }
    const service = await startEmbeddedTaskboard(input);
    return { ...service, async close() {
      if (transitionFault === "stop") { transitionFault = undefined; throw Error("fixture stop rejected"); }
      await service.close();
    } };
  });
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
  await t.test("WEB-01.10: knowledge form preserves later edits and updates its acknowledged create", async () => {
    // The real page/form runs in Chrome; hold the knowledge API boundary so no
    // llm-wiki engine or user directory is needed for this acknowledgement race.
    await evaluate("window.knowledgeFetch=window.fetch.bind(window);window.knowledgeWrites=[];window.fetch=async(...args)=>{if(String(args[0]).startsWith('/api/knowledge-bases') && ['POST','PATCH'].includes(args[1]?.method)){knowledgeWrites.push({url:String(args[0]),method:args[1].method,body:JSON.parse(args[1].body)});if(knowledgeWrites.length===1)await new Promise(resolve=>window.releaseKnowledge=resolve);return new Response(JSON.stringify({knowledgeBase:{id:'created-fixture',accountId:'account'}}),{headers:{'Content-Type':'application/json'}})}return knowledgeFetch(...args)};document.querySelector('[data-view=knowledge]').click();openNewKnowledgeBaseDialog()");
    try {
      await evaluate("document.querySelector('#knowledgeBaseNameInput').value='First snapshot';document.querySelector('#knowledgeBaseRootInput').value='/fixture/wiki';document.querySelector('#knowledgeBaseForm').requestSubmit()");
      await eventually(() => evaluate("typeof releaseKnowledge==='function'"), "knowledge save never entered");
      await evaluate("document.querySelector('#knowledgeBaseNameInput').value='Later draft';document.querySelector('#knowledgeBaseForm').dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true}));releaseKnowledge()");
      await eventually(() => evaluate("!document.querySelector('#saveKnowledgeBaseButton').disabled"), "knowledge save did not settle");
      assert.equal(await evaluate("knowledgeWrites.length"), 1);
      assert.equal(await evaluate("document.querySelector('#knowledgeBaseDialog').open"), true);
      assert.equal(await evaluate("document.querySelector('#knowledgeBaseNameInput').value"), "Later draft");
      assert.equal(await evaluate("document.querySelector('#editingKnowledgeBaseId').value"), "created-fixture");
      await evaluate("document.querySelector('#knowledgeBaseForm').requestSubmit()");
      await eventually(() => evaluate("!document.querySelector('#knowledgeBaseDialog').open"), "unchanged draft did not close");
      const writes = await evaluate<any[]>("knowledgeWrites");
      assert.deepEqual(writes.map(write => [write.method, write.body.name]), [["POST", "First snapshot"], ["PATCH", "Later draft"]]);
      assert.equal(writes[1].url, "/api/knowledge-bases/account/created-fixture");
    } finally {
      await evaluate("window.releaseKnowledge?.();window.fetch=knowledgeFetch;document.querySelector('#knowledgeBaseDialog').close();document.querySelector('[data-view=sessions]').click()");
    }
  });
  await t.test("WEB-01.9: a real settings form retains edits made after its submitted snapshot", async () => {
    await evaluate("document.querySelector('[data-view=settings]').click();window.settingsFetch=window.fetch.bind(window);window.settingsWrites=0;window.fetch=async(...args)=>{const response=await settingsFetch(...args);if(String(args[0])==='/api/config' && args[1]?.method==='PUT'){settingsWrites++;await new Promise(resolve=>window.releaseSettings=resolve)}return response};document.querySelector('#settingsForm').requestSubmit()");
    try {
      await eventually(() => evaluate("typeof window.releaseSettings === 'function'"), "settings acknowledgement was not held");
      await evaluate("document.querySelector('#defaultCwdInput').value='/unsaved-after-submit';document.querySelector('#streamRepliesInput').checked=!state.config.streamReplies;document.querySelector('#settingsForm').dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true}));releaseSettings()");
      await eventually(() => evaluate("!document.querySelector('#settingsForm button[type=submit]').disabled"), "settings save never settled");
      assert.equal(await evaluate("settingsWrites"), 1);
      assert.equal(loadConfig(paths).defaultCwd, root);
      assert.equal(await evaluate("document.querySelector('#defaultCwdInput').value"), "/unsaved-after-submit");
      assert.equal(await evaluate("document.querySelector('#streamRepliesInput').checked === !state.config.streamReplies"), true);
      assert.equal(await evaluate("document.querySelector('#modelInput') === null"), true);
      assert.equal(await evaluate("document.querySelector('#effortInput') === null"), true);
    } finally {
      await evaluate("window.releaseSettings?.();window.fetch=settingsFetch;renderSettings();document.querySelector('[data-view=sessions]').click()");
    }
  });
  for (const failed of ["settings", "knowledge"]) {
    await t.test(`WEB-01.2: concurrent settings and knowledge drafts survive a late ${failed} rejection`, async () => {
      await evaluate(`window.savedTransport = window.fetch.bind(window);
        window.formResponses = {};
        window.fetch = async (url, init) => {
          const form = url === '/api/config' && init?.method === 'PUT' ? 'settings'
            : url === '/api/knowledge-bases' && init?.method === 'POST' ? 'knowledge' : undefined;
          if (!form) return savedTransport(url, init);
          await new Promise(resolve => formResponses[form] = resolve);
          if (form === '${failed}') return Response.json({error:'fixture rejection'}, {status:409});
          if (form === 'settings') return savedTransport(url, init);
          return Response.json({knowledgeBase:{id:'two-forms-fixture',accountId:'account'}});
        };
        document.querySelector('[data-view=settings]').click();
        document.querySelector('#settingsForm').requestSubmit();`);
      try {
        await eventually(() => evaluate("Boolean(formResponses.settings)"), "settings request missing");
        await evaluate(`document.querySelector('#defaultCwdInput').value='/later-settings-draft';
          document.querySelector('[data-view=knowledge]').click();openNewKnowledgeBaseDialog();
          document.querySelector('#knowledgeBaseNameInput').value='First version';
          document.querySelector('#knowledgeBaseRootInput').value='/fixture/wiki';
          document.querySelector('#knowledgeBaseForm').requestSubmit();`);
        await eventually(() => evaluate("Boolean(formResponses.knowledge)"), "knowledge request missing");
        await evaluate("document.querySelector('#knowledgeBaseNameInput').value='Later knowledge draft'");
        for (const current of [failed, failed === "settings" ? "knowledge" : "settings"]) {
          await evaluate(`formResponses.${current}()`);
          const selector = current === "knowledge" ? "#saveKnowledgeBaseButton" : "#settingsForm button[type=submit]";
          await eventually(() => evaluate(`!document.querySelector('${selector}').disabled`), "form stayed busy");
          assert.equal(await evaluate("document.querySelector('#knowledgeBaseNameInput').value"), "Later knowledge draft");
          assert.equal(await evaluate("document.querySelector('#defaultCwdInput').value"), "/later-settings-draft");
        }
        assert.equal(await evaluate("document.querySelector('#knowledgeBaseDialog').open"), true);
        assert.equal(loadConfig(paths).defaultCwd, root);
      } finally {
        await evaluate("window.fetch=savedTransport;Object.values(formResponses).forEach(release=>release());document.querySelector('#knowledgeBaseDialog').close();renderSettings();document.querySelector('[data-view=sessions]').click()");
      }
    });
  }
  await t.test("WEB-02.4: hidden controls stay hidden under production styles and return when applicable", async () => {
    await evaluate("openRemoveAccountDialog({accountId:'account',channel:'dingtalk'})");
    try {
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.account-removal-choices')).display"), "none", "unsupported history retention must not appear for DingTalk");
      await evaluate("document.querySelector('#removeAccountDialog').close();openRemoveAccountDialog({accountId:'account',channel:'weixin'})");
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.account-removal-choices')).display"), "grid", "Weixin history retention remains available");
    } finally { await evaluate("document.querySelector('#removeAccountDialog').close()"); }
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#updateCheckButton')).display"), "none", "disabled legacy updater must not reappear through button styles");
    await evaluate("document.querySelector('[data-view=ide]').click();document.querySelector('#idePerHostRouting').checked=true;document.querySelector('#idePerHostRouting').dispatchEvent(new Event('change'));document.querySelector('#ideLocalDirectAuto').checked=false;document.querySelector('#ideLocalDirectAuto').dispatchEvent(new Event('change'))");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#ideLocalDirectInterfaceField')).display"), "none");
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('#ideLocalDirectAddressField')).display"), "none");
    await evaluate("document.querySelector('#ideLocalDirectAuto').checked=true;document.querySelector('#ideLocalDirectAuto').dispatchEvent(new Event('change'))");
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('#ideLocalDirectInterfaceField')).display"), "none");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#ideLocalDirectAddressField')).display"), "none");
    await evaluate("document.querySelector('[data-view=sessions]').click()");
  });
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
  await t.test("TB-01.3: the management page preserves a real task across failed stop, confirmed stop and failed start", async () => {
    const board = `http://127.0.0.1:${taskboardPort}`;
    const result = await fetch(board + "/api/tasks", {method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({projectId:"local", title:"Preserve this stored task",status:"todo"})});
    assert.equal(result.status,201,await result.clone().text());
    const { task } = await result.json() as { task: { id:string } };
    assert.ok(task.id);
    const health = async () => { try { return (await fetch(board+"/health")).status; } catch { return 0; } };
    const saveOff = () => evaluate(`document.querySelector('[data-view=settings]').click();
      document.querySelector('#taskboardEnabledInput').checked=false;document.querySelector('#settingsForm').requestSubmit()`);
    const saved = () => eventually(()=>evaluate("!document.querySelector('#settingsForm button[type=submit]').disabled"),"settings remained busy");
    transitionFault = "stop"; await saveOff(); await saved();
    assert.equal(await health(),200);assert.equal(loadConfig(paths).taskboardEnabled,true);
    assert.equal(await evaluate("Boolean(document.querySelector('#toastRegion .toast.is-error'))"),true);
    await saveOff(); await saved();
    assert.equal(loadConfig(paths).taskboardEnabled,false); assert.equal(await health(),0);
    await evaluate("document.querySelector('[data-view=taskboard]').click()");
    transitionFault = "start"; await evaluate("document.querySelector('#taskboardEnable').click()");
    await eventually(()=>evaluate("!document.querySelector('#taskboardEnable').disabled"),"failed start remained busy");
    assert.equal(loadConfig(paths).taskboardEnabled,false);
    assert.equal(await evaluate("document.querySelector('#taskboardFrame').hasAttribute('src')"),false);
    assert.equal(await health(),0);
    await evaluate("document.querySelector('#taskboardEnable').click()");
    await eventually(()=>evaluate("Boolean(document.querySelector('#taskboardFrame').getAttribute('src'))"),"workbench failed to recover");
    assert.equal(loadConfig(paths).taskboardEnabled,true);assert.equal(await health(),200);
    const recovered=await fetch(board+"/api/tasks/"+encodeURIComponent(task.id));
    assert.equal(recovered.status,200);assert.match(await recovered.text(), /Preserve this stored task/);
  });
  await t.test("a late comment receipt in the real management iframe stays with its original task", async () => {
    const board = "http://127.0.0.1:" + taskboardPort;
    const tasks: { id: string; identifier: string; title: string }[] = [];
    for (const title of ["Source task", "Destination task"]) {
      const response = await fetch(board + "/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "local", title, status: "todo" }) });
      assert.equal(response.status, 201);
      tasks.push((await response.json()).task);
    }
    let frameContext: number | undefined;
    const scriptErrors: string[] = [];
    const off = browser.onEvent((method, { context, exceptionDetails }) => {
      if (method === "Runtime.exceptionThrown") scriptErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
      if (method === "Runtime.executionContextCreated" && context.origin === board && context.auxData?.isDefault)
        frameContext = context.id;
    });
    try {
      await call("Runtime.disable"); await call("Runtime.enable");
      await eventually(() => frameContext, "embedded Taskboard did not open its own document");
      const frame = async (expression: string) => {
        const result = await call("Runtime.evaluate", { contextId: frameContext, expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
      };
      const open = async (task: typeof tasks[number]) => {
        await frame(`history.pushState(null, "", "?project=local&issue="+${JSON.stringify(task.identifier)});dispatchEvent(new PopStateEvent("popstate"))`);
        await eventually(() => frame(`document.body.textContent.includes(${JSON.stringify(task.title)}) && Boolean(document.querySelector(".comment-composer textarea"))`), "selected task is not visible")
          .catch(error => { throw Error(error.message + " " + scriptErrors.join("\n")); });
      };
      await eventually(() => frame("Boolean(document.querySelector('#root')?.firstElementChild)"), "embedded app did not mount");
      await open(tasks[0]);
      await frame(`{
        const original = window.fetch.bind(window);
        window.fetch = async function(resource, options) {
          const response = await original(resource, options);
          const url = new URL(resource instanceof Request ? resource.url : resource, location.href);
          if (options?.method === "POST" && url.pathname === ${JSON.stringify("/api/tasks/" + tasks[0].id + "/comments")})
            await new Promise(resolve => { window.releaseSourceComment = resolve; });
          return response;
        };
        document.querySelector('.comment-composer textarea').focus();
      }`);
      await call("Input.insertText", { text: "Source comment only" });
      await frame("document.querySelector('.comment-composer button[type=submit]').click()");
      await eventually(() => frame("typeof window.releaseSourceComment === 'function'"), "real server did not acknowledge source comment");
      await evaluate("document.querySelector('[data-view=settings]').click();document.querySelector('[data-view=taskboard]').click()");
      await open(tasks[1]);
      await eventually(() => frame("document.querySelector('.comment-composer textarea')?.value === ''"), "new task did not get its own fresh composer");
      await frame("document.querySelector('.comment-composer textarea').focus()");
      await call("Input.insertText", { text: "Unsubmitted destination draft" });
      await frame("window.releaseSourceComment();new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      assert.equal(await frame("document.querySelector('.comment-composer textarea').value"), "Unsubmitted destination draft");
      for (const [i, task] of tasks.entries()) {
        const response = await fetch(board + "/api/tasks/" + task.id + "/comments");
        assert.equal(response.status, 200);
        const { comments } = await response.json();
        assert.deepEqual(comments.map((comment: {body:string}) => comment.body), i ? [] : ["Source comment only"]);
      }
      assert.equal(await evaluate("document.querySelector('#taskboardFrame').src"), board + "/");
    } finally { off(); }
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
