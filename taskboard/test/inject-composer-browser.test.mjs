import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const source = await fs.readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
const runtime = await fs.readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("  function isCurrentThreadCreation("), source.indexOf("  function clickForThreadCreation("));
const inputHandler = source.slice(source.indexOf("  function onUserComposerInteraction("), source.indexOf("\n  const api =", source.indexOf("  function onUserComposerInteraction(")));
const prefill = new Function(`${runtime.slice(runtime.indexOf("async function prefillTaskComposerViaCdp("), runtime.indexOf("\nasync function sendHostResponse"))}; return prefillTaskComposerViaCdp;`)();
const chrome = process.env.CODEX_CHROME_TEST_BIN;
async function until(read, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(r => setTimeout(r, 25)); }
  throw new Error(message);
}

test("isolated Chrome runs the owned native composer steps without sending a task", { skip: !chrome, timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "taskboard-composer-audit-"));
  let child, socket;
  const pending = new Map();
  t.after(async () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("fixture closed")); }
    socket?.close();
    if (child?.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      child.once("exit", resolve); child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000); timer.unref();
      child.once("exit", () => clearTimeout(timer));
    });
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  child = spawn(chrome, ["--headless=new", "--no-first-run", "--disable-sync", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${root}`, "about:blank"], { stdio: "ignore" });
  const port = await until(async () => { try { return Number((await fs.readFile(path.join(root, "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { return false; } }, "Chrome failed to start");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data)), entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Runtime.enable");
  const setup = () => evaluate(`(() => {
    document.body.innerHTML = '<div data-codex-composer="true" contenteditable="true" style="min-height:60px;white-space:pre-wrap"></div>';
    let destroyed = false, frame = {contentWindow: {postMessage(message) {window.audit.messages.push(message)}}}, frameOrigin = 'http://localhost:3030';
    let pendingThreadCreation = {id:'operation-1', taskId:'task-1', frame, source:frame.contentWindow, origin:frameOrigin,
      instruction:'Do TASK-1', skillName:'manage-taskboard', skillDisplayName:'Manage Taskboard', skillPath:'/tmp/SKILL.md'};
    const threadIdFromLocation = () => window.audit.threadId;
    window.audit = {messages:[], inputs:[], threadId:'', get operation(){return pendingThreadCreation},
      cancel(){pendingThreadCreation=null}, replace(){pendingThreadCreation={id:'new-operation'}}, destroy(){destroyed=true}};
    ${helpers}
    ${inputHandler}
    window.__codexTaskboardInjection__ = {prefillTaskComposerStep};
    if (window.auditInputHandler) document.removeEventListener('keydown', window.auditInputHandler, true);
    window.auditInputHandler = onUserComposerInteraction;
    document.addEventListener('keydown', onUserComposerInteraction, true);
    const editor = document.querySelector('[contenteditable]');
    editor.addEventListener('input', () => {
      audit.inputs.push(editor.textContent);
      if (editor.textContent !== '$' || document.querySelector('[data-composer-overlay-floating-ui]')) return;
      const overlay = document.createElement('div'); overlay.setAttribute('data-composer-overlay-floating-ui','true');
      overlay.innerHTML='<button data-list-navigation-item="true"><span>Manage Taskboard</span></button>';
      overlay.querySelector('button').onclick = () => {
        editor.innerHTML='<span contenteditable="false" skill-mention-name="manage-taskboard" skill-mention-path="/tmp/SKILL.md">Manage Taskboard</span> ';
        overlay.remove();
      }; document.body.appendChild(overlay);
    });
  })()`);
  const step = name => evaluate(`__codexTaskboardInjection__.prefillTaskComposerStep('operation-1',${JSON.stringify(name)})`);
  await t.test("the host polls production renderer steps and verifies a native mention and text", async () => {
    await setup(); await prefill({ send }, undefined, { operationId: "operation-1" });
    assert.equal(await evaluate("document.querySelector('[contenteditable]').textContent"), "Manage Taskboard Do TASK-1");
    assert.deepEqual(await evaluate("audit.inputs"), ["$", "Manage Taskboard Do TASK-1"]);
  });
  for (const change of ["cancel", "replace", "destroy", "editor", "route"]) await t.test(`a late step cannot edit after ${change}`, async () => {
    await setup(); await step("prepare"); await step("select");
    if (change === "editor") await evaluate("document.querySelector('[contenteditable]').outerHTML='<div data-codex-composer=\"true\" contenteditable=\"true\">New draft</div>'");
    else if (change === "route") await evaluate("location.hash = 'another-thread'");
    else await evaluate(`audit.${change}()`);
    const before = await evaluate("document.querySelector('[contenteditable]').textContent");
    await assert.rejects(step("instruction"), /过期|取消|切换/);
    assert.equal(await evaluate("document.querySelector('[contenteditable]').textContent"), before);
  });
  await t.test("trusted keyboard input cancels the old prefill before it can overwrite the user's text", async () => {
    await setup(); await step("prepare"); await step("select");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "x", code: "KeyX", text: "x" });
    await assert.rejects(step("instruction"), /过期/);
    assert.equal(await evaluate("audit.messages.at(-1).type"), "taskboard:thread-create-error");
  });
  await t.test("an existing draft survives a new preparation", async () => {
    await setup(); await evaluate("document.querySelector('[contenteditable]').textContent='Keep draft'");
    await assert.rejects(step("prepare"), /已有草稿/);
    assert.equal(await evaluate("document.querySelector('[contenteditable]').textContent"), "Keep draft");
  });
  await t.test("the previous thread is not claimed while home navigation is pending", async () => {
    await setup(); await evaluate("audit.threadId='old-thread'");
    assert.equal((await step("prepare")).ready, false);
    assert.deepEqual(await evaluate("audit.inputs"), []);
    await evaluate("audit.threadId=''"); assert.equal((await step("prepare")).ready, true);
  });
  await t.test("a different skill path is never followed by instruction insertion", async () => {
    await setup(); await step("prepare"); await step("select");
    await evaluate("document.querySelector('[skill-mention-path]').setAttribute('skill-mention-path','/other/SKILL.md')");
    await assert.rejects(step("instruction"), /不同路径/);
    assert.deepEqual(await evaluate("audit.inputs"), ["$"]);
  });
  await t.test("the shipped Inter font decodes and loads in Chrome", async () => {
    const font = await fs.readFile(new URL("../web/public/InterVariable.woff2", import.meta.url));
    assert.equal(await evaluate(`(async()=>{const face=new FontFace('AuditInter','url(data:font/woff2;base64,${font.toString("base64")})');await face.load();document.fonts.add(face);return face.status==='loaded' && document.fonts.check('16px AuditInter');})()`), true);
  });
});
