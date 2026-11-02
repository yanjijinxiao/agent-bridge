import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const chrome = process.env.CODEX_CHROME_TEST_BIN;
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
async function until(read, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await pause(); }
  throw new Error(message);
}

test("isolated Chrome exercises production AI and issue composers, model scope and responsive layout", { skip: !chrome, timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "taskboard-browser-audit-"));
  let ownedServer, ownedChild, ownedSocket;
  t.after(async () => {
    ownedSocket?.close();
    if (ownedChild && ownedChild.exitCode === null) await new Promise(resolve => {
      ownedChild.once("exit", resolve); ownedChild.kill();
      const timer = setTimeout(() => ownedChild.kill("SIGKILL"), 2000); timer.unref();
      ownedChild.once("exit", () => clearTimeout(timer));
    });
    if (ownedServer) { ownedServer.closeAllConnections(); await new Promise(resolve => ownedServer.close(resolve)); }
    // Chrome writes its temporary profile until shutdown; teardown hooks run
    // in registration order, so remove the profile only after its owner exits.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { build } = await import("vite");
  const dist = path.join(root, "web");
  await build({ configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("./helpers/ai-chat-browser", import.meta.url)),
    publicDir: fileURLToPath(new URL("../web/public", import.meta.url)),
    logLevel: "silent", build: { outDir: dist, emptyOutDir: true } });
  const server = ownedServer = http.createServer(async (req, res) => {
    try {
      const relative = new URL(req.url, "http://localhost").pathname;
      const file = path.join(dist, relative === "/" ? "index.html" : relative);
      if (!file.startsWith(`${dist}${path.sep}`)) { res.writeHead(403).end(); return; }
      const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
      res.setHeader("Content-Type", mime[path.extname(file)] ?? "application/octet-stream");
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const profile = path.join(root, "profile");
  const child = ownedChild = spawn(chrome, ["--headless=new", "--no-first-run", "--disable-sync", "--disable-extensions", "--disable-background-networking",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const port = await until(async () => { try { return Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { return false; } }, "isolated Chrome did not start");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const tab = tabs.find(tab => tab.type === "page"); assert.ok(tab?.webSocketDebuggerUrl);
  const socket = ownedSocket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const result = JSON.parse(String(event.data)), entry = pending.get(result.id);
    if (!entry) return; pending.delete(result.id); clearTimeout(entry.timer);
    result.error ? entry.reject(new Error(JSON.stringify(result.error))) : entry.resolve(result.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id, timer = setTimeout(() => { pending.delete(current); reject(new Error(`CDP deadline: ${method}`)); }, 10000);
    pending.set(current, { resolve, reject, timer }); socket.send(JSON.stringify({ id: current, method, params }));
  });
  await call("Runtime.enable"); await call("Page.enable");
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  t.afterEach(async()=>{await evaluate("for(const k of Object.keys(localStorage))if(k.startsWith('taskboard.submission:') || k.startsWith('taskboard.comment-draft'))localStorage.removeItem(k)");});
  const base = `http://127.0.0.1:${server.address().port}`;
  const navigate = async url => {
    const previous = await evaluate("window.audit?.documentId");
    await call("Page.navigate", { url });
    await until(() => evaluate(`Boolean(window.audit?.documentId && window.audit.documentId !== ${JSON.stringify(previous) ?? "null"} && document.readyState === 'complete')`), "new document was not loaded");
  };
  const open = async (suffix = "") => {
    await navigate(`${base}/${suffix}`);
    await until(() => evaluate("Boolean(window.audit && document.querySelector('.ai-chat-launcher'))"), "AI launcher missing");
    await evaluate("document.querySelector('.ai-chat-launcher').click()");
    await until(() => evaluate("Boolean(document.querySelector('.ai-chat-composer-editor'))"), "composer missing");
  };
  const ready = () => until(() => evaluate("document.querySelector('.ai-chat-messages')?.getAttribute('aria-busy') === 'false' && !document.querySelector('.ai-chat-model-trigger')?.disabled"), "snapshot/catalog not ready");
  const turns = () => evaluate("audit.requests.filter(r=>r.method==='POST' && r.path.endsWith('/turns')).length");
  const enter = () => call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });

  await t.test("native approval buttons and question fields submit only explicit actions and clear secret values", async () => {
    await navigate(`${base}/?view=native`);
    await until(() => evaluate("document.querySelectorAll('.ai-chat-native-interaction').length===2"), "native forms missing");
    assert.equal(await evaluate("audit.requests.length"),0);
    await evaluate("audit.holdNativeAnswer=true;Array.from(document.querySelectorAll('.ai-chat-native-actions button')).find(b=>b.textContent==='取消本次').click()");
    await until(()=>evaluate("audit.requests.length===1"),"native approval action not submitted");
    assert.deepEqual(await evaluate("audit.requests[0].body"),{answer:"cancel"});
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.ai-chat-native-actions button')).every(b=>b.disabled)"),true);
    await evaluate("audit.releaseNativeAnswer();audit.holdNativeAnswer=false;document.querySelector('.ai-chat-native-interaction form input').focus()");
    await call("Input.insertText",{text:"Own free-form answer"});
    await evaluate("document.querySelector('input[type=password]').focus()");
    await call("Input.insertText",{text:"ISOLATED_SECRET"});
    assert.equal(await evaluate("audit.requests.length"),1,"typing never submits or approves");
    await evaluate("document.querySelector('.ai-chat-native-interaction form button[type=submit]').click()");
    await until(()=>evaluate("audit.requests.length===2 && document.querySelector('input[type=password]').value===''"),"native question did not submit/clear");
    assert.deepEqual(await evaluate("audit.requests[1].body"),{answer:{choice:{answers:["Own free-form answer"]},secret:{answers:["ISOLATED_SECRET"]}}});
    assert.equal(await evaluate("JSON.stringify(localStorage).includes('ISOLATED_SECRET')"),false);
    assert.equal(await evaluate("document.body.textContent.includes('ISOLATED_SECRET')"),false);
  });

  await t.test("opening a project reads server policy without reapplying an old enabled browser cache", async () => {
    await navigate(`${base}/?view=automation-host`);
    await until(()=>evaluate("audit.hostRequests?.length>0"),"hosted policy reconciliation missing");
    assert.equal(await evaluate("audit.hostRequests.every(request=>request.operation==='list')"),true,
      "opening a page/menu must never re-enable a cached policy");
    await until(()=>evaluate("JSON.parse(localStorage.getItem('taskboard.projectAutomations.v1')).a?.enabledByUser===false"),"server disabled policy did not replace stale cache");
  });

  await t.test("automation menu uses the selected native model catalog and enables only after an explicit click", async () => {
    await navigate(`${base}/?view=automation-menu`);
    await until(()=>evaluate("Boolean(document.querySelector('.project-automation-trigger'))"),"automation menu trigger missing");
    await evaluate("document.querySelector('.project-automation-trigger').click()");
    await until(()=>evaluate("document.querySelector('.project-automation-menu select')?.value==='a-model'"),"native model not selected");
    assert.deepEqual(await evaluate("Array.from(document.querySelector('.project-automation-menu select').options).map(option=>option.value)"),["a-model"]);
    assert.equal(await evaluate("audit.saved.length"),0,"catalog reads do not save or enable automation");
    await evaluate("document.querySelector('.project-automation-menu button[role=switch]').click()");
    await until(()=>evaluate("audit.saved.length===1"),"explicit native model policy not saved");
    assert.deepEqual(await evaluate("audit.saved[0]"),{enabledByUser:true,quotaAware:false,model:"a-model",reasoningEffort:"high"});
  });

  await t.test("a completed AI turn with a lost HTTP acknowledgement is held instead of resubmitting the draft", async () => {
    await open(); await ready();
    await evaluate("audit.dropTurnAck=true;document.querySelector('.ai-chat-composer-editor').focus()");
    await call("Input.insertText",{text:"Original native input"}); await enter();
    await until(()=>evaluate("audit.requests.some(r=>r.method==='POST' && r.path.endsWith('/turns')) && !document.querySelector('.ai-chat-composer').getAttribute('aria-busy')"),"unknown AI turn did not settle in fixture");
    await until(()=>evaluate("!document.querySelector('.ai-chat-running')"),"completed native fixture did not refresh");
    await evaluate("document.querySelector('.ai-chat-composer-editor').focus()"); await enter();
    assert.equal(await turns(),1,"retained draft must not become another native execution after a lost receipt");
    assert.equal(await evaluate("Boolean(document.querySelector('.ai-chat-submission-review'))"),true);
    await evaluate("audit.submissionUnknown=true;document.querySelector('.ai-chat-submission-review button').click()");
    await until(()=>evaluate("document.querySelector('.ai-chat-error')?.textContent.includes('尚无法确认')"),"unknown status must retain the original receipt");
    assert.equal(await turns(),1);
    await evaluate("audit.submissionUnknown=false;document.querySelector('.ai-chat-submission-review button').click()");
    await until(()=>evaluate("!document.querySelector('.ai-chat-submission-review')"),"read-only native receipt recovery did not clear the confirmed handoff");
    assert.equal(await turns(),1,"receipt recovery must issue GET only");
    assert.equal(await evaluate("document.querySelector('.ai-chat-composer-editor').textContent"),"");
    await evaluate("audit.dropTurnAck=true;document.querySelector('.ai-chat-composer-editor').focus()");
    await call('Input.insertText',{text:'Second isolated original input'}); await enter();
    await until(()=>evaluate("Boolean(document.querySelector('.ai-chat-submission-review'))"),"second lost receipt not retained");
    await navigate(`${base}/`);
    await until(()=>evaluate("Boolean(document.querySelector('.ai-chat-launcher'))"),"reloaded AI launcher missing");
    await evaluate("document.querySelector('.ai-chat-launcher').click()"); await ready();
    assert.equal(await evaluate("Boolean(document.querySelector('.ai-chat-submission-review'))"),true,"reload must retain the unresolved browser handoff");
    assert.equal(await turns(),0);
  });

  await t.test("AI journal storage failure sends zero writes and explicit retry preserves the original draft", async () => {
    await open('?storageFull=1'); await ready();
    await evaluate("document.querySelector('.ai-chat-composer-editor').focus()");
    await call('Input.insertText',{text:'Keep before native submit'}); await enter();
    await until(()=>evaluate("Boolean(document.querySelector('.ai-chat-error'))"),"storage error not visible");
    assert.equal(await turns(),0);
    assert.equal(await evaluate("document.querySelector('.ai-chat-composer-editor').textContent"),'Keep before native submit');
    await evaluate("audit.storageFull=false;document.querySelector('.ai-chat-composer-editor').focus()"); await enter();
    await until(async()=>await turns()===1,"explicit retry did not reach the original native API");
  });

  await t.test("issue cards render existing malformed dates without crashing and retain valid date labels", async () => {
    for (const date of ["2026-13-01", "2026-02-30", "2028-02-29"]) {
      await navigate(`${base}/?view=card&date=${date}`);
      await until(() => evaluate("Boolean(document.querySelector('.task-card'))"), `card crashed for ${date}`);
      assert.equal(await evaluate(`document.querySelector('.due-date-chip')?.getAttribute('title')`), `截止日期 ${date}`);
      if (date === "2028-02-29") assert.ok(await evaluate("document.querySelector('.due-date-chip').textContent.includes('29')"));
    }
  });

  await t.test("snapshot loading and IME Enter never submit; a later ordinary Enter submits exactly once", async () => {
    await open("?hold=1");
    await evaluate("document.querySelector('.ai-chat-composer-editor').focus()");
    await call("Input.insertText", { text: "Draft during loading" });
    await enter(); assert.equal(await turns(), 0);
    await evaluate("audit.releaseSnapshot()"); await ready();
    assert.equal(await evaluate("document.querySelector('.ai-chat-composer-editor').textContent"), "Draft during loading");
    await evaluate("document.querySelector('.ai-chat-composer-editor').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true}))");
    assert.equal(await turns(), 0);
    await enter(); await until(async () => (await turns()) === 1, "normal Enter did not submit once");
  });
  await t.test("Markdown is visible while private reasoning and host fields stay out of the timeline", async () => {
    await open(); await ready();
    assert.ok(await evaluate("[...document.querySelectorAll('.ai-chat-messages strong')].some(e=>e.textContent==='Public answer')"));
    assert.equal(await evaluate("document.body.innerText.includes('PRIVATE_REASONING_NEVER_VISIBLE')"), false);
    assert.equal(await evaluate("document.body.innerText.includes('PRIVATE_NATIVE_THREAD') || document.body.innerText.includes('PRIVATE_HOST_PATH')"), false);
  });
  await t.test("malformed encoded skill links remain readable without crashing valid references or the composer", async () => {
    await open("?skillLinks=1"); await ready();
    const timeline = await evaluate("document.querySelector('.ai-chat-messages').innerText");
    assert.ok(timeline.includes("Public answer"));
    assert.ok(timeline.includes("Invalid reference") && timeline.includes("Truncated reference"), timeline);
    assert.ok(timeline.includes("Cloudflare"), "a valid skill reference still resolves using the loaded catalog");
    assert.equal(await turns(), 0);
  });
  await t.test("late file reads belong only to the original composer while unchanged drafts still receive their attachment", async () => {
    for (const changed of [false, true]) {
      await open(); await ready();
      await evaluate(`(()=>{
        const NativeReader = window.FileReader; audit.fileReads = [];
        window.FileReader = class extends NativeReader {
          readAsDataURL(file) { audit.fileReads.push(() => new Promise(resolve => {
            this.addEventListener('loadend', resolve, {once:true}); super.readAsDataURL(file);
          })); }
        };
        const input=document.querySelector('.ai-chat-panel input[type=file]'), data=new DataTransfer();
        data.items.add(new File(['original file'], 'late.txt', {type:'text/plain'})); input.files=data.files;
        input.dispatchEvent(new Event('change', {bubbles:true}));
      })()`);
      assert.equal(await evaluate("audit.fileReads.length"), 1);
      if (changed) {
        await evaluate("document.querySelector('[aria-label=\"新建对话\"]').click()"); await ready();
      }
      await evaluate("document.querySelector('.ai-chat-composer-editor').focus()");
      await call("Input.insertText", { text: changed ? "New draft" : "Original draft" });
      await evaluate("Promise.all(audit.fileReads.splice(0).map(read=>read()))");
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      assert.equal(await evaluate("document.querySelectorAll('.ai-chat-composer-attachment').length"), changed ? 0 : 1);
      assert.equal(await evaluate("document.querySelector('.ai-chat-composer-editor').textContent"), changed ? "New draft" : "Original draft");
      assert.equal(await turns(), 0);
    }
  });
  await t.test("selecting a skill in the real editor sends its ordered marker and native id", async () => {
    await open(); await ready();
    await evaluate("document.querySelector('.ai-chat-composer-editor').focus()");
    await call("Input.insertText", { text: "@cl" });
    await until(() => evaluate("Boolean(document.querySelector('.ai-chat-skill-menu [role=option]'))"), "skill choices missing");
    await enter();
    await until(() => evaluate("document.querySelectorAll('.ai-chat-composer-editor .ai-chat-composer-skill-token').length===1"), "skill token missing");
    await call("Input.insertText", { text: " inspect" }); await enter();
    await until(async () => (await turns()) === 1, "skill message not submitted");
    const body = await evaluate("audit.requests.find(r=>r.method==='POST' && r.path.endsWith('/turns')).body");
    assert.deepEqual(body.skillIds, ["cloudflare"]); assert.equal(body.message.split("\uFFFC").length - 1, 1);
  });
  await t.test("known create and turn rejections preserve the submitted text, skill and attachment for an explicit retry", async () => {
    for (const kind of ["create", "turn"]) {
      await open(); await ready();
      if (kind === "create") { await evaluate("document.querySelector('[aria-label=\"新建对话\"]').click()"); await ready(); }
      await evaluate("document.querySelector('.ai-chat-composer-editor').focus()");
      await call("Input.insertText", { text: "@cl" });
      await until(() => evaluate("Boolean(document.querySelector('.ai-chat-skill-menu [role=option]'))"), "skill missing");
      await enter();
      await until(() => evaluate("document.querySelectorAll('.ai-chat-composer-skill-token').length===1"), "skill not selected");
      await call("Input.insertText", { text: " keep draft" });
      await evaluate(`(()=>{const input=document.querySelector('.ai-chat-panel input[type=file]'), data=new DataTransfer();
        data.items.add(new File(['keep attachment'], 'keep.txt', {type:'text/plain'})); input.files=data.files;
        input.dispatchEvent(new Event('change',{bubbles:true})); audit.failNextWrite=${JSON.stringify(kind)};})()`);
      await until(() => evaluate("document.querySelectorAll('.ai-chat-composer-attachment').length===1"), "file missing");
      const original = await evaluate("document.querySelector('.ai-chat-composer-editor').textContent");
      await evaluate("document.querySelector('.ai-chat-composer-editor').focus()"); await enter();
      await until(() => evaluate("document.body.innerText.includes('Fixture rejected before execution')"), "rejection missing");
      assert.equal(await evaluate("document.querySelector('.ai-chat-composer-editor').textContent"), original);
      assert.equal(await evaluate("document.querySelectorAll('.ai-chat-composer-skill-token').length"), 1);
      assert.equal(await evaluate("document.querySelectorAll('.ai-chat-composer-attachment').length"), 1);
      assert.equal(await turns(), kind === "create" ? 0 : 1);
      await enter();
      await until(async () => (await turns()) === (kind === "create" ? 1 : 2), "explicit retry missing");
      await until(() => evaluate("document.querySelector('.ai-chat-composer-editor').textContent==='' && document.querySelectorAll('.ai-chat-composer-attachment').length===0"), "accepted draft not cleared");
      const submitted = await evaluate("audit.requests.filter(r=>r.method==='POST' && r.path.endsWith('/turns')).at(-1).body");
      assert.deepEqual(submitted.skillIds, ["cloudflare"]);
      assert.equal(submitted.attachments[0].filename, "keep.txt");
    }
  });
  await t.test("pending turn submission sends once and an accepted late receipt preserves a changed draft", async () => {
    for (const changed of [false, true]) {
      await open(); await ready(); await evaluate("audit.holdWrite='turn'; document.querySelector('.ai-chat-composer-editor').focus()");
      await call("Input.insertText", { text: "Original message" }); await enter();
      await until(() => evaluate("Boolean(audit.releaseWrite)"), "pending turn missing");
      if (changed) await evaluate("(()=>{const e=document.querySelector('.ai-chat-composer-editor');e.textContent='New draft';e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'New draft'}));})()");
      await enter(); await enter();
      assert.equal(await turns(), 1, "a pending POST must not submit the draft again");
      await evaluate("audit.releaseWrite()");
      await until(() => evaluate("Boolean(document.querySelector('.ai-chat-running'))"), "accepted run not projected");
      assert.equal(await evaluate("document.querySelector('.ai-chat-composer-editor').textContent"), changed ? "New draft" : "");
    }
  });
  await t.test("late thread creation and turn receipts keep a newly selected conversation and its draft", async () => {
    for (const kind of ["create", "turn"]) {
      await open(); await ready();
      if (kind === "create") { await evaluate("document.querySelector('[aria-label=\"新建对话\"]').click()"); await ready(); }
      await evaluate(`audit.holdWrite=${JSON.stringify(kind)}; document.querySelector('.ai-chat-composer-editor').focus()`);
      await call("Input.insertText", { text: "Submit in original conversation" }); await enter();
      await until(() => evaluate("Boolean(audit.releaseWrite)"), "held write missing");
      if (kind === "create") {
        await evaluate("document.querySelector('[aria-label=\"对话历史\"]').click()");
        await until(() => evaluate("Boolean(document.querySelector('.ai-chat-history-row > button'))"), "history not rendered");
        await evaluate("document.querySelector('.ai-chat-history-row > button').click()");
      } else await evaluate("document.querySelector('[aria-label=\"新建对话\"]').click()");
      await ready();
      await evaluate("document.querySelector('.ai-chat-composer-editor').focus()");
      await call("Input.insertText", { text: "Keep selected draft" });
      await evaluate("audit.releaseWrite()");
      await until(async () => (await turns()) === 1, "original intended turn missing");
      await until(() => evaluate("Boolean(document.querySelector('.ai-chat-send-button:not(:disabled)'))"), "write did not settle");
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      assert.equal(await evaluate("document.querySelector('.ai-chat-composer-editor').textContent"), "Keep selected draft");
      assert.equal(await evaluate("document.querySelector('.ai-chat-panel-title strong').textContent"), kind === "create" ? "Existing conversation" : "新对话");
      const target = await evaluate("audit.requests.find(r=>r.method==='POST' && r.path.endsWith('/turns')).path");
      assert.equal(target, kind === "create" ? "/api/local/ai/threads/thread-2/turns" : "/api/local/ai/threads/thread-a/turns");
    }
  });
  await t.test("new conversation validates inherited settings using the target project catalog", async () => {
    await open(); await ready(); await evaluate("audit.project('b')");
    await until(() => evaluate("audit.currentProject === 'b'"), "project navigation did not render");
    await until(() => evaluate("!document.querySelector('[aria-label=\"新建对话\"]').disabled"), "new conversation action unavailable");
    await evaluate("document.querySelector('[aria-label=\"新建对话\"]').click()");
    await ready(); await evaluate("document.querySelector('.ai-chat-composer-editor').focus()");
    await call("Input.insertText", { text: "Target project message" }); await enter();
    const created = await until(() => evaluate("audit.requests.find(r=>r.method==='POST' && r.path==='/api/local/ai/threads')?.body"), "thread creation missing");
    assert.equal(created.projectId, "b"); assert.equal(created.model, "b-model"); assert.equal(created.reasoningEffort, "low");
  });
  await t.test("desktop pointer resizing changes geometry within the viewport", async () => {
    await open(); await ready();
    const before = await evaluate("(()=>{const r=document.querySelector('.ai-chat-panel').getBoundingClientRect(); return {width:r.width,height:r.height,x:r.x,y:r.y}})()");
    assert.ok(before.width >= 420 && before.height <= 784);
    const handle = await evaluate("(()=>{const r=document.querySelector('.ai-chat-resize-handle.is-left').getBoundingClientRect();return {x:r.x+2,y:r.y+20}})()");
    await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...handle });
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: handle.x - 100, y: handle.y });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: handle.x - 100, y: handle.y });
    const width = await evaluate("document.querySelector('.ai-chat-panel').getBoundingClientRect().width");
    assert.ok(width > before.width + 90 && width <= 960);
  });
  await t.test("390px viewport keeps panel and model menu within the visible screen", async () => {
    await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await open(); await ready(); await evaluate("document.querySelector('.ai-chat-model-trigger').click()");
    const layout = await evaluate("(()=>{const panel=document.querySelector('.ai-chat-panel').getBoundingClientRect(),menu=document.querySelector('.ai-chat-option-menu').getBoundingClientRect();return {width:innerWidth,height:innerHeight,p:{left:panel.left,right:panel.right,top:panel.top,bottom:panel.bottom},m:{left:menu.left,right:menu.right,top:menu.top,bottom:menu.bottom}}})()");
    for (const rect of [layout.p, layout.m]) assert.ok(rect.left >= -1 && rect.right <= layout.width + 1 && rect.top >= -1 && rect.bottom <= layout.height + 1, JSON.stringify(layout));
  });
  const issueView = async view => {
    await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate(`${base}/?view=${view}`);
    await until(() => evaluate(view === "editor" ? "Boolean(document.querySelector('.task-dialog[open]'))"
      : "Boolean(document.querySelector('.comment-card') && document.querySelector('.comment-inline-media textarea'))"), "issue component missing");
  };
  const chooseFile = selector => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)}),data=new DataTransfer();
    data.items.add(new File(['fixture evidence'],'audit.txt',{type:'text/plain'}));input.files=data.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  for (const operation of ["duplicate", "archive", "restore", "create"]) {
   for (const route of ["unchanged", "switch", "aba"]) {
    await t.test(`a confirmed ${operation} retains its original view ownership (${route})`, async () => {
      await navigate(`${base}/?view=app&project=a`);
      await until(()=>evaluate("Boolean(document.querySelector('.task-card[data-task-id=\"task-one\"]'))"),"full App board missing");
      await evaluate("document.fonts.ready.then(()=>{const board=document.querySelector('.board-scroll');board.scrollTo(0,0);return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})");
      if (operation === "create") {
        await evaluate("document.querySelector('[aria-label=\"新建议题\"]').click()");
        await until(()=>evaluate("Boolean(document.querySelector('.task-dialog[open]'))"),"App editor missing");
        await evaluate("document.querySelector('.composer-title input').focus()"); await call("Input.insertText",{text:"New original issue"});
        await evaluate("audit.holdBoardWrite=true;document.querySelector('.task-dialog button[type=submit]').click()");
      } else {
        await evaluate("audit.viewportEvents=[];for(const type of ['scroll','blur','resize'])window.addEventListener(type,e=>audit.viewportEvents.push({type,target:e.target?.className,focus:document.activeElement?.className}),true);document.querySelector('.task-card').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:200}))");
        try { await until(()=>evaluate("Boolean(document.querySelector('.task-context-menu'))"),"App context menu missing"); }
        catch(error) { throw Error(`${error.message}: ${JSON.stringify(await evaluate('audit.viewportEvents'))}`); }
        if (operation !== "restore") await evaluate("audit.holdBoardWrite=true");
        const label=operation === "duplicate" ? "创建副本" : "归档议题";
        await evaluate(`[...document.querySelectorAll('.task-context-menu button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`);
        if (operation === "restore") {
          await until(()=>evaluate("Boolean(document.querySelector('.undo-toast button'))"),"archive undo missing");
          await evaluate("audit.holdBoardWrite=true;document.querySelector('.undo-toast button').click()");
        }
      }
      await until(()=>evaluate("typeof audit.releaseBoardWrite==='function'"),"native write hold missing");
      if (route !== "unchanged" && operation === "create") {
        // Browser navigation can change routes even while the native dialog is modal.
        await evaluate("history.pushState(null,'','?view=app&project=b');dispatchEvent(new PopStateEvent('popstate'))");
      } else if (route !== "unchanged") {
        await evaluate("document.querySelector('[aria-label=\"切换项目\"]').click()");
        await evaluate("[...document.querySelectorAll('.header-project-menu button')].find(b=>b.textContent.includes('Project B')).click()");
      }
      if (route !== "unchanged") await until(()=>evaluate("Boolean(document.querySelector('.task-card[data-task-id=\"task-b\"]'))"),"target project missing");
      if (route === "aba") {
        await evaluate("audit.reviseBoard();document.querySelector('[aria-label=\"切换项目\"]').click()");
        await evaluate("[...document.querySelectorAll('.header-project-menu button')].find(b=>b.textContent.includes('Project A')).click()");
        await until(()=>evaluate("document.querySelector('[aria-label=\"切换项目\"] .project-name').textContent==='Project A' && !document.querySelector('.loading-board')"),"ABA route missing");
      }
      await evaluate("audit.releaseBoardWrite()");
      await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
      const expected = route === "switch" ? ["task-b"] : operation === "archive" ? []
        : operation === "restore" ? ["task-one"] : ["created-2", "task-one"];
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.task-card')].map(t=>t.dataset.taskId).sort()"),expected.sort());
      if (route === "aba" && operation !== "archive")
        assert.ok(await evaluate("[...document.querySelectorAll('.task-card h3')].every(t=>t.textContent==='Later native change')"));
      assert.equal(await evaluate("document.querySelector('[aria-label=\"切换项目\"] .project-name').textContent"),route === "switch" ? "Project B" : "Project A");
      const mutations = await evaluate("audit.requests.filter(r=>r.method!=='GET').length");
      await evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))");
      await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
      assert.equal(await evaluate("audit.requests.filter(r=>r.method!=='GET').length"),mutations + (route === "unchanged" && operation !== "restore" ? 1 : 0),"only a live view may retain its undo operation");
    });
   }
  }
  for (const quota of [false,true]) for (const inline of [false,true]) await t.test(`a partial new issue upload retains its confirmed entity and retries only failed files (inline=${inline}, storageFull=${quota})`,async()=>{
    await navigate(`${base}/?view=app&project=a`);
    await until(()=>evaluate("Boolean(document.querySelector('.task-card[data-task-id=\"task-one\"]'))"),"App missing");
    await evaluate("document.querySelector('[aria-label=\"新建议题\"]').click()");
    await until(()=>evaluate("Boolean(document.querySelector('.task-dialog[open]'))"),"new issue missing");
    await evaluate("document.querySelector('.composer-title input').focus()"); await call("Input.insertText",{text:"Partial original issue"});
    await evaluate(`(()=>{const input=document.querySelector('.task-dialog input[type=file]'),files=new DataTransfer();
      files.items.add(new File(['good'],'good.txt',{type:'text/plain'}));
      ${inline ? "" : "files.items.add(new File(['bad'],'bad.txt',{type:'text/plain'}));"}
      input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));audit.failUpload=${JSON.stringify(inline ? "inline.png" : "bad.txt")};})()`);
    if(inline)await evaluate("(()=>{const files=new DataTransfer();files.items.add(new File(['png'],'inline.png',{type:'image/png'}));document.querySelector('.inline-media-description textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:files,bubbles:true,cancelable:true}));})()");
    await evaluate("document.querySelector('.task-dialog button[type=submit]').click()");
    await until(()=>evaluate("!document.querySelector('.task-dialog[open]') || document.querySelector('.task-dialog button[type=submit]').textContent!=='正在保存…'"),"initial save did not settle");
    assert.equal(await evaluate("Boolean(document.querySelector('.task-dialog[open]'))"),true,"failed files remain available for the original issue");
    if(quota)await evaluate("audit.nativeSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('taskboard.submission:'))throw new DOMException('Fixture full','QuotaExceededError');return audit.nativeSetItem.call(this,k,v);}");
    await evaluate("document.querySelector('.task-dialog button[type=submit]').click()");
    await until(()=>evaluate("!document.querySelector('.task-dialog[open]')"),"resumed save did not finish");
    const writes=await evaluate("audit.requests.filter(r=>r.method==='POST')");
    assert.equal(writes.filter(r=>r.path==='/api/tasks').length,1);
    assert.equal(writes.filter(r=>r.body?.filename==='good.txt').length,1);
    assert.equal(writes.filter(r=>r.body?.filename===(inline ? 'inline.png' : 'bad.txt')).length,2);
    assert.ok(writes.filter(r=>r.body?.filename).every(r=>r.path==='/api/tasks/created-2/attachments'));
    assert.equal(await evaluate("Object.keys(localStorage).filter(k=>k.startsWith('taskboard.submission:[\"issue\",\"a\"]:')).length"),0);
  });
  await t.test("a lost new issue acknowledgement is retained across reload without authorizing another creation",async()=>{
    await navigate(`${base}/?view=app&project=a`);
    await until(()=>evaluate("Boolean(document.querySelector('.task-card'))"),"App missing");
    await evaluate("document.querySelector('[aria-label=\"新建议题\"]').click()");
    await until(()=>evaluate("Boolean(document.querySelector('.task-dialog[open]'))"),"editor missing");
    await evaluate("document.querySelector('.composer-title input').focus()");await call("Input.insertText",{text:"Unknown original issue"});
    await evaluate("audit.dropCreateAck=true;document.querySelector('.task-dialog button[type=submit]').click()");
    await until(()=>evaluate("Boolean(document.querySelector('.task-dialog [data-submission-review]'))"),"unknown create not held");
    assert.equal(await evaluate("document.querySelector('.task-dialog button[type=submit]').disabled"),true);
    await navigate(`${base}/?view=app&project=a`);
    await until(()=>evaluate("Boolean(document.querySelector('.task-card'))"),"reloaded App missing");
    await evaluate("document.querySelector('[aria-label=\"新建议题\"]').click()");
    await until(()=>evaluate("Boolean(document.querySelector('.task-dialog [data-submission-review]'))"),"reload lost create receipt");
    assert.equal(await evaluate("audit.requests.filter(r=>r.method==='POST').length"),0);
    await evaluate("[...document.querySelectorAll('.task-dialog button')].find(b=>b.textContent==='结束本次提交').click()");
    assert.equal(await evaluate("Object.keys(localStorage).filter(k=>k.startsWith('taskboard.submission:[\"issue\",\"a\"]:')).length"),0);
    assert.equal(await evaluate("audit.requests.filter(r=>r.method==='POST').length"),0);
  });
  await t.test("workflow controls wait for hydration and an old project save cannot replace the new workspace", async()=>{
    await navigate(`${base}/?view=workflow&seed=1&holdWorkflow=1`);
    await until(()=>evaluate("Boolean(audit.releaseWorkflow)"),"workspace read not held");
    assert.equal(await evaluate("document.querySelector('.workflow-tab-add').disabled"),true);
    assert.equal(await evaluate("document.querySelector('.workflow-canvas').inert"),true);
    assert.equal(await evaluate("audit.requests.filter(r=>r.method==='PUT').length"),0);
    await evaluate("audit.releaseWorkflow()");
    await until(()=>evaluate("!document.querySelector('.workflow-tab-add').disabled"),"workspace controls not released");
    await evaluate("audit.holdWorkflowSave=true;document.querySelector('.workflow-tab').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await until(()=>evaluate("Boolean(document.querySelector('[aria-label=\"流程名称\"]'))"),"rename input missing");
    await evaluate("document.querySelector('[aria-label=\"流程名称\"]').focus();document.querySelector('[aria-label=\"流程名称\"]').select()");
    await call("Input.insertText",{text:"Project A pending edit"});
    await evaluate("document.querySelector('[aria-label=\"流程名称\"]').blur()");
    await until(()=>evaluate("Boolean(audit.releaseWorkflowSave)"),"save not held");
    await evaluate("audit.project('b')");
    await until(()=>evaluate("Boolean(audit.workflowRecord('b')?.workspace && document.querySelector('.workflow-tab')?.textContent.includes('Fixture workflow'))"),"project B not loaded");
    await evaluate("audit.releaseWorkflowSave();new Promise(r=>setTimeout(r,220))");
    assert.ok(await evaluate("document.querySelector('.workflow-tab').textContent.includes('Fixture workflow')"));
    assert.equal(await evaluate("audit.workflowRecord('a').workspace.tabs[0].name"),"Project A pending edit");
    assert.equal(await evaluate("audit.workflowRecord('b').workspace.tabs[0].name"),"Fixture workflow");
  });
  for (const choice of ["normal","keep-local","load-remote"]) await t.test(`workflow persistence keeps local edits until an explicit conflict resolution (${choice})`,async()=>{
    await navigate(`${base}/?view=workflow`);
    await until(()=>evaluate("Boolean(audit.workflowRecord('a')?.workspace && document.querySelector('.workflow-tab'))"),"workflow not hydrated");
    await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    if(choice!=="normal")await evaluate("audit.conflictWorkflowNext=true");
    await evaluate("document.querySelector('.workflow-tab').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await until(()=>evaluate("Boolean(document.querySelector('[aria-label=\"流程名称\"]'))"),"rename input missing");
    await evaluate("document.querySelector('[aria-label=\"流程名称\"]').focus();document.querySelector('[aria-label=\"流程名称\"]').select()");
    await call("Input.insertText",{text:"Local edited workflow"});
    await evaluate("document.querySelector('[aria-label=\"流程名称\"]').blur()");
    await until(()=>evaluate("audit.requests.filter(r=>r.method==='PUT').length>=2"),"workflow not saved");
    await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    assert.ok(await evaluate("document.querySelector('.workflow-tab').textContent.includes('Local edited workflow')"),"a remote conflict cannot discard the local edit");
    if(choice==="normal") {
      assert.equal(await evaluate("audit.workflowRecord('a').workspace.tabs[0].name"),"Local edited workflow");return;
    }
    assert.ok(await evaluate("Boolean(document.querySelector('[data-workflow-conflict]'))"));
    const label=choice==="keep-local" ? "保留本地并保存" : "载入远端版本";
    await evaluate(`[...document.querySelectorAll('[data-workflow-conflict] button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
    const expected=choice==="keep-local" ? "Local edited workflow" : "Remote workflow";
    await until(()=>evaluate(`document.querySelector('.workflow-tab').textContent.includes(${JSON.stringify(expected)}) && audit.workflowRecord('a').workspace.tabs[0].name===${JSON.stringify(expected)}`),"conflict choice not applied");
    assert.equal(await evaluate("audit.requests.filter(r=>r.method==='PUT').length"),choice==="keep-local" ? 3 : 2);
  });
  for(const kind of ["root-step","condition","plan-child","trigger"]) await t.test(`workflow dragging preserves canonical sequence and subtree ownership (${kind})`,async()=>{
    await call("Emulation.setDeviceMetricsOverride",{width:1800,height:2200,deviceScaleFactor:1,mobile:false});
    await navigate(`${base}/?view=workflow&seed=1`);
    await until(()=>evaluate("Boolean(document.querySelector('.react-flow__node[data-id=after]'))"),"seeded graph missing");
    await evaluate("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))");
    const source=kind==="root-step" ? "after" : kind==="condition" ? "condition" : kind==="plan-child" ? "child-one" : "trigger";
    const target=kind==="root-step" ? "condition" : kind==="condition" ? "plan" : kind==="plan-child" ? "child-two" : "plan";
    const rect=async id=>evaluate(`(()=>{const r=document.querySelector('.react-flow__node[data-id=${id}]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+20,height:r.height}})()`);
    await until(async()=>{const before=await rect(source);await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");const after=await rect(source);return before.x===after.x && before.y===after.y;},"workflow viewport did not settle");
    const from=await rect(source),to=await rect(target);
    assert.equal(await evaluate(`document.elementFromPoint(${from.x},${from.y})?.closest(".react-flow__node")?.dataset.id`),source);
    const endY=to.y+(kind==="root-step" ? -25 : to.height/2+30);
    await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:from.x,y:from.y});
    await call("Input.dispatchMouseEvent",{type:"mousePressed",x:from.x,y:from.y,button:"left",clickCount:1});
    for(let n=1;n<=8;n++)await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:from.x,y:from.y+(endY-from.y)*n/8,buttons:1});
    await call("Input.dispatchMouseEvent",{type:"mouseReleased",x:from.x,y:endY,button:"left",clickCount:1});
    await evaluate("new Promise(r=>setTimeout(r,300))");
    const snapshot=await evaluate("audit.workflowRecord('a').workspace.snapshots.fixture");
    const root=snapshot.flow.root.items.map(i=>i.nodeId);
    assert.deepEqual(root,kind==="root-step" ? ["trigger","after","condition","plan"] : kind==="condition" ? ["trigger","plan","condition","after"] : ["trigger","condition","plan","after"]);
    const condition=snapshot.flow.root.items.find(i=>i.nodeId==="condition");
    assert.deepEqual(condition.branches.true.items.map(i=>i.nodeId),["yes"]);
    assert.deepEqual(condition.branches.false.items.map(i=>i.nodeId),["no"]);
    const children=snapshot.nodes.filter(n=>n.parentId==="plan").sort((a,b)=>a.position.y-b.position.y).map(n=>n.id);
    assert.deepEqual(children,kind==="plan-child" ? ["child-two","child-one"] : ["child-one","child-two"]);
  });
  await t.test("context menu ignores punctuation safely while its status keyboard shortcut still selects the requested status", async () => {
    await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate(`${base}/?view=menu`);
    await until(() => evaluate("Boolean(document.querySelector('.task-context-menu [data-root-shortcut]'))"), "context menu missing");
    await evaluate("audit.keyErrors=[];window.addEventListener('error',e=>{audit.keyErrors.push(e.message);e.preventDefault()});document.querySelector('.task-context-menu [data-root-shortcut]').focus()");
    for (const key of ['"', "\\", "["]) {
      await call("Input.dispatchKeyEvent", { type: "keyDown", key, code: key === '"' ? "Quote" : key === "\\" ? "Backslash" : "BracketLeft" });
    }
    assert.deepEqual(await evaluate("audit.keyErrors"), []);
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "s", code: "KeyS" });
    await until(() => evaluate("Boolean(document.querySelector('[data-submenu-panel=status]'))"), "status shortcut no longer opens the menu");
    await evaluate("document.querySelectorAll('[data-submenu-panel=status] button')[1].click()");
    await until(() => evaluate("!document.querySelector('.task-context-menu')"), "status selection did not close the menu");
    assert.deepEqual(await evaluate("audit.menuActions"), ["todo"]);
  });
  await t.test("relation keyboard selection is single-flight while pending and a rejected selection remains explicitly retryable", async () => {
    for (const outcome of ["success", "failure"]) {
      await navigate(`${base}/?view=relations`);
      await until(() => evaluate("Boolean(document.querySelector('.issue-relation-add'))"), "relation picker missing");
      await evaluate("document.querySelector('.issue-relation-add').click()");
      await until(() => evaluate("Boolean(document.querySelector('.issue-relation-search input'))"), "relation search missing");
      await evaluate("document.querySelector('.issue-relation-search input').focus()");
      await enter();
      await until(() => evaluate("audit.relations.length>=1"), "first relation selection missing");
      await enter();
      assert.equal(await evaluate("audit.relations.length"), 1, "pending Enter must not invoke the same mutation twice");
      if (outcome === "failure") {
        await evaluate("audit.rejectRelation()");
        await until(() => evaluate("!document.querySelector('.issue-relation-results button').disabled"), "rejected selection did not become retryable");
        await enter();
        await until(() => evaluate("audit.relations.length===2"), "explicit retry did not invoke the mutation");
      }
      await evaluate("audit.acceptRelation()");
      await until(() => evaluate("!document.querySelector('.issue-relation-popover')"), "accepted relation did not close the picker");
      assert.deepEqual(await evaluate("audit.relations[0]"), { type: "parent", id: "task-two" });
    }
  });
  await t.test("comment floor and composer have equal width and both real editors retain their focus appearance", async () => {
    await issueView("detail");
    const bounds = await evaluate("(()=>{const a=document.querySelector('.comment-card').getBoundingClientRect(),b=document.querySelector('.comment-composer').getBoundingClientRect();return {a:{left:a.left,width:a.width},b:{left:b.left,width:b.width}}})()");
    assert.ok(Math.abs(bounds.a.left - bounds.b.left) <= 1 && Math.abs(bounds.a.width - bounds.b.width) <= 1, JSON.stringify(bounds));
    const appearance = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(e);return {border:s.border,outline:s.outline,shadow:s.boxShadow,background:s.backgroundColor}})()`);
    const composerBefore = await appearance(".comment-inline-media textarea");
    await evaluate("document.querySelector('.comment-inline-media textarea').focus()");
    assert.deepEqual(await appearance(".comment-inline-media textarea"), composerBefore);
    await evaluate("document.querySelector('.comment-menu-trigger').click()");
    await evaluate("document.querySelector('.comment-action-menu button').click()");
    await until(() => evaluate("Boolean(document.querySelector('.comment-edit-form textarea'))"), "edit comment missing");
    await evaluate("document.querySelector('.comment-edit-form textarea').blur()");
    const editBefore = await appearance(".comment-edit-form textarea");
    await evaluate("document.querySelector('.comment-edit-form textarea').focus()");
    assert.deepEqual(await appearance(".comment-edit-form textarea"), editBefore);
  });
  await t.test("comment files stage in the shared list, upload to that comment, render and delete through the original attachment API", async () => {
    await issueView("detail");
    await chooseFile('.comment-composer input[type="file"]');
    await until(() => evaluate("document.querySelector('.comment-composer .composer-attachment-list')?.textContent.includes('audit.txt')"), "comment pending file missing");
    await evaluate("document.querySelector('.comment-composer button[type=submit]').click()");
    await until(() => evaluate("Boolean(document.querySelector('.comment-attachment-list a[title=\"打开 audit.txt\"]'))"), "uploaded comment file missing");
    const writes = await evaluate("audit.requests.filter(r=>r.method==='POST').map(r=>r.path)");
    assert.deepEqual(writes, ["/api/tasks/task-one/comments", "/api/comments/comment-2/attachments"]);
    await evaluate("document.querySelector('.comment-attachment-list button').click()");
    await until(() => evaluate("Boolean(document.querySelector('.delete-dialog'))"), "attachment delete confirmation missing");
    await evaluate("document.querySelector('.delete-dialog .danger').click()");
    await until(() => evaluate("!document.querySelector('.comment-attachment-list')"), "deleted comment attachment remains");
    assert.equal(await evaluate("audit.requests.filter(r=>r.method==='DELETE' && r.path==='/api/attachments/attachment-1').length"), 1);
  });
  await t.test("a confirmed comment clears only its unchanged draft and preserves edits made while its request was pending", async () => {
    for (const edited of [false, true]) {
      await issueView("detail");
      await evaluate("document.querySelector('.comment-inline-media textarea').focus()");
      await call("Input.insertText", { text: "Original comment" });
      await evaluate("audit.holdWrite='comment'; document.querySelector('.comment-composer button[type=submit]').click()");
      await until(() => evaluate("typeof audit.releaseWrite==='function'"), "comment request did not reach its pending boundary");
      if (edited) {
        await evaluate("document.querySelector('.comment-inline-media textarea').focus()");
        await call("Input.insertText", { text: " plus later edits" });
      }
      await evaluate("audit.releaseWrite()");
      await until(() => evaluate("document.querySelector('.comment-composer button[type=submit]').textContent==='评论'"), "comment request did not finish");
      const expected = edited ? "Original comment plus later edits" : "";
      assert.equal(await evaluate("document.querySelector('.comment-inline-media textarea').value"), expected);
      assert.equal(await evaluate("localStorage.getItem('taskboard.comment-draft.task-one') ?? ''"), expected);
      const requests = await evaluate("audit.requests.filter(r=>r.method==='POST' && r.path==='/api/tasks/task-one/comments')");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].body.body, "Original comment");
      assert.ok(await evaluate("[...document.querySelectorAll('.comment-body')].some(e=>e.textContent.includes('Original comment'))"));
    }
  });
  await t.test("a full browser store retains the comment editor and draft before any request, and recovers on explicit retry",async()=>{
    await navigate(`${base}/?view=detail&storageFull=1`);
    await until(()=>evaluate("Boolean(document.querySelector('.comment-inline-media textarea'))"),"storage failure removed the composer");
    await evaluate("document.querySelector('.comment-inline-media textarea').focus()");await call("Input.insertText",{text:"Keep unsubmitted draft"});
    await evaluate("document.querySelector('.comment-composer button[type=submit]').click()");
    await until(()=>evaluate("document.querySelector('.comments-error')?.textContent.includes('尚未提交')"),"storage failure not reported before write");
    assert.equal(await evaluate("audit.requests.filter(r=>r.method==='POST').length"),0);
    assert.equal(await evaluate("document.querySelector('.comment-inline-media textarea').value"),"Keep unsubmitted draft");
    await evaluate("audit.storageFull=false;document.querySelector('.comment-composer button[type=submit]').click()");
    await until(()=>evaluate("document.querySelector('.comment-inline-media textarea').value===''"),"explicit retry did not finish");
    assert.equal(await evaluate("audit.requests.filter(r=>r.method==='POST' && r.path.endsWith('/comments')).length"),1);
  });
  await t.test("a partially uploaded comment resumes only its failed files on the same confirmed comment", async () => {
    for (const quota of [false,true]) for (const inline of [false, true]) {
      await issueView("detail");
      await evaluate(`(()=>{const input=document.querySelector('.comment-composer input[type=file]'),data=new DataTransfer();
        data.items.add(new File(['first'], 'good.txt', {type:'text/plain'}));
        ${inline ? "" : "data.items.add(new File(['second'], 'bad.txt', {type:'text/plain'}));"}
        input.files=data.files; input.dispatchEvent(new Event('change',{bubbles:true}));
        audit.failUpload=${JSON.stringify(inline ? "inline.png" : "bad.txt")};})()`);
      if (inline) await evaluate(`(()=>{const data=new DataTransfer();data.items.add(new File(['png'], 'inline.png', {type:'image/png'}));
        document.querySelector('.comment-inline-media textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
      await evaluate("document.querySelector('.comment-composer button[type=submit]').click()");
      await until(() => evaluate("document.querySelector('.comment-composer button[type=submit]').textContent==='继续本次提交'"), "partial upload was not resumable");
      assert.ok(await evaluate("Boolean(document.querySelector('.comment-composer').innerText.includes('bad.txt') || document.querySelector('.inline-media-image'))"));
      if(quota)await evaluate("audit.nativeSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('taskboard.submission:'))throw new DOMException('Fixture full','QuotaExceededError');return audit.nativeSetItem.call(this,k,v);}");
      await evaluate("document.querySelector('.comment-composer button[type=submit]').click()");
      await until(() => evaluate("document.querySelector('.comment-composer button[type=submit]').textContent==='评论'"), "resumed upload did not finish");
      const writes = await evaluate("audit.requests.filter(r=>r.method==='POST')");
      assert.equal(writes.filter(r=>r.path.endsWith('/comments')).length, 1);
      assert.equal(writes.filter(r=>r.body?.filename==='good.txt').length, 1);
      assert.equal(writes.filter(r=>r.body?.filename === (inline ? "inline.png" : "bad.txt")).length, 2);
      assert.ok(writes.filter(r=>r.body?.filename).every(r=>r.path==='/api/comments/comment-2/attachments'));
      assert.equal(await evaluate("Object.keys(localStorage).filter(k=>k.startsWith('taskboard.submission:[\"comment\",\"task-one\"]:')).length"), 0);
    }
  });
  await t.test("an applied comment or attachment with a lost response is held across reload and never reposted", async () => {
    for (const upload of [false, true]) {
      await issueView("detail");
      if (upload) await chooseFile('.comment-composer input[type="file"]');
      await evaluate(`audit.${upload ? "dropUploadAck" : "dropCommentAck"}=true; document.querySelector('.comment-inline-media textarea').focus()`);
      await call("Input.insertText", {text:"Original uncertain comment"});
      await evaluate("document.querySelector('.comment-composer button[type=submit]').click()");
      await until(() => evaluate("Boolean(document.querySelector('.comment-composer button[type=submit]').disabled && document.querySelector('.comment-composer [role=status]'))"), "unknown write was not retained");
      assert.equal(await evaluate("audit.requests.filter(r=>r.method==='POST' && r.path.endsWith('/comments')).length"), 1);
      await evaluate("document.querySelector('.comment-inline-media textarea').focus()");
      await call("Input.dispatchKeyEvent", {type:"keyDown",key:"Enter",code:"Enter",modifiers:4,windowsVirtualKeyCode:13});
      assert.equal(await evaluate("audit.requests.filter(r=>r.method==='POST' && r.path.endsWith('/comments')).length"), 1);
      await navigate(await evaluate("location.href"));
      await until(() => evaluate("Boolean(document.querySelector('.comment-composer [role=status]'))"), "reload lost receipt");
      assert.equal(await evaluate("audit.requests.filter(r=>r.method==='POST').length"), 0);
      assert.equal(await evaluate("document.querySelector('.comment-composer button[type=submit]').disabled"), true);
      await evaluate("[...document.querySelectorAll('.comment-composer button')].find(b=>b.textContent==='结束本次提交').click()");
      assert.equal(await evaluate("Object.keys(localStorage).filter(k=>k.startsWith('taskboard.submission:[\"comment\",\"task-one\"]:')).length"), 0);
      assert.equal(await evaluate("audit.requests.filter(r=>r.method==='POST').length"), 0);
    }
  });
  await t.test("a late comment acknowledgement clears its detached draft but preserves a remounted composer's later draft", async () => {
    for (const remounted of [false, true]) {
      await issueView("detail");
      await evaluate("document.querySelector('.comment-inline-media textarea').focus()");
      await call("Input.insertText",{text:"Original pending comment"});
      await evaluate("audit.holdWrite='comment';document.querySelector('.comment-composer button[type=submit]').click()");
      await until(()=>evaluate("typeof audit.releaseWrite==='function'"),"comment not held");
      if (remounted) {
        await evaluate("audit.remountDetail()");
        await until(()=>evaluate("Boolean(document.querySelector('.comment-composer [role=status]'))"),"remounted receipt missing");
        await evaluate("document.querySelector('.comment-inline-media textarea').focus();document.querySelector('.comment-inline-media textarea').select()");
        await call("Input.insertText",{text:"Keep remounted draft"});
      } else await evaluate("audit.hideDetail()");
      await evaluate("audit.releaseWrite()");
      await until(()=>evaluate(`Object.keys(localStorage).filter(k=>k.startsWith('taskboard.submission:["comment","task-one"]:')).length===0`),"comment did not confirm");
      if (!remounted) {
        await evaluate("audit.remountDetail()");
        await until(()=>evaluate("Boolean(document.querySelector('.comment-inline-media textarea'))"),"detail missing");
      }
      assert.equal(await evaluate("document.querySelector('.comment-inline-media textarea').value"),remounted ? "Keep remounted draft" : "");
      assert.equal(await evaluate("localStorage.getItem('taskboard.comment-draft.task-one') ?? ''"),remounted ? "Keep remounted draft" : "");
      assert.equal(await evaluate("audit.requests.filter(r=>r.method==='POST' && r.path.endsWith('/comments')).length"),1);
    }
  });
  await t.test("two composers retain independent receipt ownership when one response is lost and the other confirms",async()=>{
    await navigate(`${base}/?view=dual-detail`);
    await until(()=>evaluate("document.querySelectorAll('.comment-inline-media textarea').length===2"),"two composers missing");
    await evaluate("document.querySelector('[data-pane=first] textarea[aria-label=\"留下评论\"]').focus()");
    await call("Input.insertText",{text:"First pending source"});
    await evaluate("audit.holdWrite='comment';document.querySelector('[data-pane=first] .comment-composer button[type=submit]').click()");
    await until(()=>evaluate("typeof audit.releaseWrite==='function'"),"first source not held");
    const receipt=await evaluate("Object.keys(localStorage).filter(k=>k.startsWith('taskboard.submission:[\"comment\",\"task-one\"]:')).map(k=>JSON.parse(localStorage.getItem(k)))[0].id");
    await evaluate("document.querySelector('[data-pane=second] textarea[aria-label=\"留下评论\"]').focus()");
    await call("Input.insertText",{text:"Second explicit source"});
    await evaluate("document.querySelector('[data-pane=second] .comment-composer button[type=submit]').click()");
    await until(()=>evaluate("document.querySelector('[data-pane=second] textarea[aria-label=\"留下评论\"]').value===''"),"second source not confirmed");
    assert.equal(await evaluate(`Object.values(localStorage).some(v=>{try{return JSON.parse(v)?.id===${JSON.stringify(receipt)}}catch{return false}})`),true,"confirming one source cannot erase another source's receipt");
    await evaluate("audit.dropCommentAck=true;audit.releaseWrite()");
    await until(()=>evaluate("Boolean(document.querySelector('[data-pane=first] .comment-composer [role=status]'))"),"lost first response not retained");
    assert.equal(await evaluate("document.querySelector('[data-pane=first] .comment-composer button[type=submit]').disabled"),true);
    assert.equal(await evaluate("audit.requests.filter(r=>r.method==='POST' && r.path.endsWith('/comments')).length"),2);
  });
  await t.test("new issue uses the shared pending attachment component and hands the original file to save", async () => {
    await issueView("editor"); await chooseFile('.task-dialog input[type="file"]');
    await until(() => evaluate("document.querySelector('.task-dialog .composer-attachment-list')?.textContent.includes('audit.txt')"), "new issue pending file missing");
    await evaluate("document.querySelector('.task-dialog [aria-label=\"移除 audit.txt\"]').click()");
    await until(() => evaluate("!document.querySelector('.task-dialog .composer-attachment-list')"), "pending file removal failed");
    await chooseFile('.task-dialog input[type="file"]');
    await evaluate("document.querySelector('.composer-title input').focus()");
    await call("Input.insertText", { text: "Created from actual component" });
    await evaluate("document.querySelector('.task-dialog button[type=submit]').click()");
    const saved = await until(() => evaluate("audit.saved[0]"), "issue save callback missing");
    assert.equal(saved.draft.title, "Created from actual component"); assert.deepEqual(saved.filenames, ["audit.txt"]);
  });
});
