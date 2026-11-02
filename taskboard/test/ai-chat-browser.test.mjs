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
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = async (suffix = "") => {
    await call("Page.navigate", { url: `${base}/${suffix}` });
    await until(() => evaluate("Boolean(window.audit && document.querySelector('.ai-chat-launcher'))"), "AI launcher missing");
    await evaluate("document.querySelector('.ai-chat-launcher').click()");
    await until(() => evaluate("Boolean(document.querySelector('.ai-chat-composer-editor'))"), "composer missing");
  };
  const ready = () => until(() => evaluate("document.querySelector('.ai-chat-messages')?.getAttribute('aria-busy') === 'false' && !document.querySelector('.ai-chat-model-trigger')?.disabled"), "snapshot/catalog not ready");
  const turns = () => evaluate("audit.requests.filter(r=>r.method==='POST' && r.path.endsWith('/turns')).length");
  const enter = () => call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });

  await t.test("issue cards render existing malformed dates without crashing and retain valid date labels", async () => {
    for (const date of ["2026-13-01", "2026-02-30", "2028-02-29"]) {
      await call("Page.navigate", { url: `${base}/?view=card&date=${date}` });
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
    await call("Page.navigate", { url: `${base}/?view=${view}` });
    await until(() => evaluate(view === "editor" ? "Boolean(document.querySelector('.task-dialog[open]'))"
      : "Boolean(document.querySelector('.comment-card') && document.querySelector('.comment-inline-media textarea'))"), "issue component missing");
  };
  const chooseFile = selector => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)}),data=new DataTransfer();
    data.items.add(new File(['fixture evidence'],'audit.txt',{type:'text/plain'}));input.files=data.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
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
