import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { WorkspaceIDEManager } from "../src/ide/manager.js";
import { IDEAccessServer } from "../src/ide/access-server.js";
import { isolatedBrowser, eventually } from "./helpers/gap-browser.js";

test("real code-server workspace, profile and browser authorization", {
  skip: !process.env.CODEX_CHROME_TEST_BIN || !process.env.CODEX_REAL_IDE_TEST_BIN, timeout: 180000,
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-real-ide-")));
  const roots = ["alpha", "beta"].map(name => {
    const folder = path.join(root, name); fs.mkdirSync(folder);
    execFileSync("git", ["init", "--quiet", folder]); fs.writeFileSync(path.join(folder, `${name}.txt`), `${name} sample\nsecond line\n`); return folder;
  });
  const reserve = net.createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as net.AddressInfo).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const manager = new WorkspaceIDEManager({ root: path.join(root, "gateway"), readyTimeoutMs: 120000,
    resolve: () => ({ owner: "fixture", projectId: "fixture", sessionId: "session", hostId: "local", workspace: roots[0], rootPaths: roots, projectName: "Isolated workspace" }) });
  manager.configStore.save({ ...manager.config(), enabled: true, port, publicOrigin: origin,
    hosts: [{ hostId: "local", enabled: true, binary: process.env.CODEX_REAL_IDE_TEST_BIN! }],
    profile: { settings: {}, extensions: ["tuttieee.emacs-mcx"] },
  });
  const access = new IDEAccessServer(manager); access.setManagementOrigin(origin); await access.reload(false);
  let closeBrowser: (() => Promise<void>) | undefined;
  t.after(async () => { await closeBrowser?.(); await access.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  // The real workbench starts an extension host and workers; browser commands
  // can wait behind navigation during that startup under the full test suite.
  const browser = await isolatedBrowser(t, root, { commandTimeoutMs: 30000 }), { evaluate, call } = browser; closeBrowser = browser.close;
  browser.onEvent((method, params) => {
    // This disposable workbench can ask to close its terminal on navigation.
    if (method === "Page.javascriptDialogOpening" && params.type === "beforeunload") {
      void call("Page.handleJavaScriptDialog", { accept: true });
    }
  });
  const entry = manager.entry("fixture", "session")!;
  const grant = await access.grant(entry.id, true);
  await call("Page.navigate", { url: `${origin}/workspace/${entry.id}?auth_check=1` });
  await eventually(() => evaluate(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`), "access page did not load");
  t.diagnostic("test authorization page loaded");
  // Same-origin browser POST obtains its HttpOnly cookie. The token is test-only
  // and never copied to IM, logs, snapshots or committed evidence.
  await evaluate(`(()=>{const f=document.createElement('form');f.method='POST';f.action='/authorize';for(const [name,value]of Object.entries(${JSON.stringify({ entryId: entry.id, token: grant.token })})){const i=document.createElement('input');i.type='hidden';i.name=name;i.value=value;f.append(i)}document.body.append(f);setTimeout(()=>f.submit(),50);return true})()`);
  const duringNavigation = async (expression: string) => {
    try { return await evaluate(expression); }
    catch (error) {
      if (/Inspected target navigated|Execution context was destroyed|Cannot find context/.test(String(error))) return false;
      throw error;
    }
  };
  const workbenchReady = async () => {
    const end = Date.now() + 90000;
    while (Date.now() < end) {
      if (await duringNavigation("Boolean(document.querySelector('.monaco-workbench'))")) return;
      await new Promise(r => setTimeout(r, 200));
    }
    throw Error(`real IDE did not open: ${await evaluate("document.body.innerText.slice(0,600)")}`);
  };
  await workbenchReady();
  t.diagnostic("official code-server workbench loaded");
  const check = (name: string, body: () => Promise<void>) => t.test(name, async () => {
    try { await body(); }
    catch (error) {
      t.diagnostic(await evaluate("JSON.stringify({text:document.body.innerText.slice(0,5000),inputs:[...document.querySelectorAll('input')].map(e=>({label:e.getAttribute('aria-label'),value:e.value})),active:document.activeElement?.outerHTML.slice(0,500)})"));
      const shot = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
      fs.writeFileSync(path.join(os.tmpdir(), `checklist-${name.split(':')[0]}.png`), Buffer.from(shot.data, "base64"));
      throw error;
    }
  });
  const key = async (key: string, code: string, modifiers = 0) => {
    const virtual = ({ Enter: 13, Escape: 27, F1: 112, End: 35 } as Record<string, number>)[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    await call("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, windowsVirtualKeyCode: virtual, ...(key === "Enter" ? { text: "\r" } : {}) });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: virtual });
  };
  const command = async (title: string) => {
    await key("Escape", "Escape");
    await key("F1", "F1");
    await eventually(() => evaluate("Boolean(document.querySelector('.quick-input-widget:not([style*=\"display: none\"]) input'))"), "command palette missing");
    await evaluate("document.querySelector('.quick-input-widget input').select()");
    await call("Input.insertText", { text: `>${title}` });
    await eventually(() => evaluate(`document.querySelector('.quick-input-widget')?.innerText.includes(${JSON.stringify(title)})`), `command unavailable: ${title}`);
    await key("Enter", "Enter");
  };
  await check("IDE-02.1: actual workbench opens both Git roots and its terminal starts in the selected root", async () => {
    await eventually(() => evaluate("document.body.innerText.includes('alpha') && document.body.innerText.includes('beta')"), "multi-root explorer missing");
    await command("Source Control: Focus on Changes View");
    await eventually(() => evaluate("document.querySelector('.scm-view')?.innerText.includes('alpha') && document.querySelector('.scm-view')?.innerText.includes('beta')"), "both Git repositories did not appear");
    await command("Terminal: Create New Terminal");
    await eventually(() => evaluate("Boolean(document.querySelector('.terminal-wrapper .xterm'))"), "actual terminal did not open");
    const cwdReceipt = path.join(root, "terminal-cwd.txt");
    await eventually(() => evaluate("document.activeElement?.classList.contains('xterm-helper-textarea')"), "terminal did not receive focus");
    await call("Input.insertText", { text: `pwd > '${cwdReceipt.replace(/'/g, "'\\''")}'` }); await key("Enter", "Enter");
    await eventually(() => fs.existsSync(cwdReceipt), "terminal command did not complete");
    assert.equal(fs.readFileSync(cwdReceipt, "utf8").trim(), roots[0]);
  });
  await check("IDE-08.3: actual editor applies visual defaults, hides Chat and activates Emacs", async () => {
    await key("Escape", "Escape"); await key("p", "KeyP", process.platform === "darwin" ? 4 : 2);
    await eventually(() => evaluate("Boolean(document.querySelector('.quick-input-widget input'))"), "open-file input missing");
    await evaluate("document.querySelector('.quick-input-widget input').select()");
    await call("Input.insertText", { text: path.join(roots[0], "alpha.txt") });
    await eventually(() => evaluate("document.querySelector('.quick-input-list')?.innerText.includes('alpha.txt')"), "open-file search not resolved");
    await key("Enter", "Enter");
    await eventually(() => evaluate("Boolean(document.querySelector('.editor-instance .view-lines'))"), "editor not visible");
    const style = await evaluate("(()=>{const e=document.querySelector('.editor-instance .view-lines');const s=getComputedStyle(e);return {font:s.fontFamily,size:s.fontSize,line:s.lineHeight,dark:document.querySelector('.monaco-workbench').classList.contains('vs-dark'),chat:[...document.querySelectorAll('.auxiliarybar')].some(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).display!=='none')}})()");
    assert.match(style.font, /Menlo/); assert.equal(style.size, "12px"); assert.equal(style.line, "18px"); assert.equal(style.dark, true); assert.equal(style.chat, false);
    assert.ok(manager.list()[0].profile?.installed.some(row => row.id === "tuttieee.emacs-mcx"));
    // Emacs C-a moves to the beginning of the current line, not select-all.
    await key("End", "End"); await key("a", "KeyA", 2);
    await call("Input.insertText", { text: "EMACS_" });
    await key("s", "KeyS", process.platform === "darwin" ? 4 : 2);
    await eventually(() => fs.readFileSync(path.join(roots[0], "alpha.txt"), "utf8").startsWith("EMACS_alpha sample"), "Emacs C-a did not preserve the remaining text");
  });
  await check("IDE-06.2: browser reopen reuses the instance and existing grant without another request", async () => {
    const instances = manager.list().map(row => row.id), requests = access.pendingAccess().length;
    // Navigate through the page, as an address-bar reopen does. Chromium can
    // leave Page.navigate unanswered when code-server tears down its workers.
    await evaluate("setTimeout(()=>location.assign('about:blank'),50); true");
    await eventually(() => duringNavigation("location.href === 'about:blank' && document.readyState === 'complete'"), "browser did not leave the workbench");
    await evaluate(`setTimeout(()=>location.assign(${JSON.stringify(entry.url)}),50); true`);
    await workbenchReady();
    assert.deepEqual(manager.list().map(row => row.id), instances); assert.equal(access.pendingAccess().length, requests);
  });
  await check("IDE-06.3: a revoked browser returns to authorization instead of reopening its editor", async () => {
    access.revoke();
    await evaluate(`setTimeout(()=>location.assign(${JSON.stringify(entry.url)}),50); true`);
    await eventually(() => duringNavigation("document.body.innerText.includes('等待 Gateway 授权')"), "revoked browser bypassed authorization");
    assert.equal(await evaluate("Boolean(document.querySelector('.monaco-workbench'))"), false);
  });
});
