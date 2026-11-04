import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import test from "node:test";
import { PeerRegistry } from "../src/peer/registry.js";
import { GatewayPeerServer } from "../src/peer/transport.js";
import { ConnectorIDEHostTransport } from "../src/peer/ide-transport.js";
import { WorkspaceIDEManager } from "../src/ide/manager.js";
import { IDEAccessServer } from "../src/ide/access-server.js";
import { isolatedBrowser, eventually } from "./helpers/gap-browser.js";

// Opt-in launcher is an argv array, not shell interpolation. For a remote
// Linux fixture, SSH can forward the test-only peer port to its loopback.
// Only an explicitly supplied command starts the host fixture; no production
// Connector credentials, native home or browser profile are discovered.
test("real CLI Connector code-server workbench, authorization and reconnect", {
  skip: !process.env.CODEX_CHROME_TEST_BIN || !process.env.CODEX_CONNECTOR_IDE_HOST_COMMAND, timeout: 360000,
}, async t => {
  const spec = JSON.parse(process.env.CODEX_CONNECTOR_IDE_HOST_COMMAND!);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cig-cli-ide-")));
  const token = crypto.randomBytes(32).toString("hex"), registry = new PeerRegistry(path.join(root, "grants.json"));
  const peers = await GatewayPeerServer.listen({ host: "127.0.0.1", port: 0, credentials: { "cli-ide-test": token }, accept: (id, c) => registry.accept(id, c) });
  const peerPort = new URL(peers.url).port;
  const host = spawn(spec.command, spec.args.map((arg: string) => arg.replaceAll("{peerPort}", peerPort)), { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", next = 0;
  host.stderr.on("data", b => { stderr = (stderr + b).slice(-3000); });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  readline.createInterface({ input: host.stdout }).on("line", line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const p = pending.get(value.id); if (!p) return; pending.delete(value.id); clearTimeout(p.timer);
    value.error ? p.reject(Error(value.error)) : p.resolve(value.result);
  });
  const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error(`Isolated host exited: ${stderr}`)); } pending.clear(); };
  host.on("error", fail); host.on("exit", fail);
  const rpc = (method: string, fields: object = {}, timeout = 60000) => new Promise<any>((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error(`Host control timeout: ${method}; ${stderr}`)); }, timeout);
    pending.set(id, { resolve, reject, timer }); host.stdin.write(JSON.stringify({ id, method, ...fields }) + "\n");
  });
  let access: IDEAccessServer | undefined, browser: Awaited<ReturnType<typeof isolatedBrowser>> | undefined;
  t.after(async () => {
    await browser?.close(); await access?.close();
    if (host.exitCode === null && !host.signalCode) { try { await rpc("close", {}, 15000); } catch {} host.stdin.end(); }
    registry.close(); await peers.close();
    if (host.exitCode === null && !host.signalCode) host.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const fixture = await rpc("init", { url: `ws://127.0.0.1:${spec.remotePort ?? peerPort}/gateway/v1/peer`, token, binary: spec.binary, codexBin: spec.codexBin }, 90000);
  t.diagnostic(`host=${fixture.platform}/${fixture.arch}; native CLI project confirmed; initial native inputs=${fixture.nativeInputs}`);
  if (spec.expectedPlatform) assert.equal(fixture.platform, spec.expectedPlatform);
  const principal = { accountId: "cli-ide-browser", actorId: "fixture-owner", conversationId: "fixture-room" };
  const subject = { principal: { accountId: principal.accountId, actorId: principal.actorId, channel: "dingtalk" as const, providerId: "fixture" }, basis: "im-personal" as const, epoch: 0 };
  await registry.connect(fixture.code, principal, () => {});
  const reserve = net.createServer(); await new Promise<void>(r => reserve.listen(0, "127.0.0.1", r)); const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>(r => reserve.close(() => r())); const origin = `http://127.0.0.1:${port}`;
  const create = async () => {
    const manager = new WorkspaceIDEManager({ root: path.join(root, "gateway"), readyTimeoutMs: 120000,
      transport: new ConnectorIDEHostTransport(registry, { canonicalDirectory() { throw Error("Unexpected SSH/local IDE"); }, launch() { throw Error("Unexpected SSH/local IDE"); } }),
      resolve: () => ({ owner: "fixture", projectId: fixture.nativeProjectId, sessionId: "fixture-session", nativeThreadId: fixture.threadId,
        hostId: fixture.hostId, workspace: fixture.roots[0], rootPaths: fixture.roots, projectName: "CLI browser test" }),
      refresh: async () => {
        const state = await registry.invoke<any>(fixture.hostId, "inspectThread", [fixture.threadId]);
        assert.equal(state.persistence, "active"); assert.equal(state.projectId, fixture.nativeProjectId);
        return { owner: "fixture", projectId: fixture.nativeProjectId, sessionId: "fixture-session", nativeThreadId: fixture.threadId,
          hostId: fixture.hostId, workspace: state.cwd, rootPaths: fixture.roots, projectName: "CLI browser test" };
      } });
    manager.configStore.save({ ...manager.config(), enabled: true, port, publicOrigin: origin,
      hosts: [{ hostId: fixture.hostId, enabled: true, binary: "code-server" }], profile: { settings: {}, extensions: ["tuttieee.emacs-mcx"] } });
    access = new IDEAccessServer(manager); access.setAccessAuthority({ isSubjectAllowed: s => s.basis === subject.basis && s.epoch === subject.epoch
      && ["accountId", "actorId", "channel", "providerId"].every(key => s.principal[key as keyof typeof s.principal] === subject.principal[key as keyof typeof subject.principal]) }); await access.reload(false);
    return manager;
  };
  let manager = await create(); const entry = manager.entry(principal.accountId, "fixture-session")!;
  browser = await isolatedBrowser(t, root, { commandTimeoutMs: 30000 }); const { call, evaluate } = browser;
  browser.onEvent((method, params) => { if (method === "Page.javascriptDialogOpening" && params.type === "beforeunload") void call("Page.handleJavaScriptDialog", { accept: true }); });
  const duringNavigation = async (expression: string) => { try { return await evaluate(expression); } catch (error) {
    if (/Inspected target navigated|Execution context was destroyed|Cannot find context/.test(String(error))) return false; throw error;
  } };
  const ready = async () => {
    const until = Date.now() + 120000;
    while (Date.now() < until) { if (await duringNavigation("Boolean(document.querySelector('.monaco-workbench'))")) return; await new Promise(r => setTimeout(r, 200)); }
    throw Error(`Workbench unavailable: ${await evaluate("document.body.innerText.slice(0,600)")}`);
  };
  const key = async (key: string, code: string, modifiers = 0) => {
    const virtual = ({ Enter: 13, Escape: 27, F1: 112, End: 35 } as Record<string, number>)[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    await call("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, windowsVirtualKeyCode: virtual, ...(key === "Enter" ? { text: "\r" } : {}) });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: virtual });
  };
  const command = async (title: string) => {
    await key("Escape", "Escape"); await key("F1", "F1");
    await eventually(() => evaluate("Boolean(document.querySelector('.quick-input-widget:not([style*=\"display: none\"]) input'))"), "Command palette missing");
    await evaluate("document.querySelector('.quick-input-widget input').select()"); await call("Input.insertText", { text: `>${title}` });
    await eventually(() => evaluate(`document.querySelector('.quick-input-widget')?.innerText.includes(${JSON.stringify(title)})`), `Command missing: ${title}`); await key("Enter", "Enter");
  };
  const check = async (name: string, body: () => Promise<void>) => { let failure: unknown; await t.test(name, async () => { try { await body(); } catch (error) {
    failure = error; process.stderr.write(`Browser check failed: ${String(error)}\n`);
    t.diagnostic(JSON.stringify(await rpc("diagnostics")));
    t.diagnostic(await duringNavigation("document.body.innerText.slice(0,2000)"));
    try { const shot = await call("Page.captureScreenshot", { format: "png", fromSurface: true }); fs.writeFileSync(path.join(os.tmpdir(), "connector-ide-browser-failure.png"), Buffer.from(shot.data, "base64")); } catch {}
    throw error;
  } }); if (failure) throw failure; };
  await check("paired personal browser enters the remote workbench using Gateway approval", async () => {
    await call("Page.navigate", { url: entry.url + "?auth_check=1" });
    await eventually(() => evaluate("document.body.innerText.includes('等待 Gateway 授权')"), "Browser proof page missing");
    const request = access!.pendingAccess()[0]; assert.ok(request);
    await access!.approveAccess(request.id, entry.id, true, undefined, subject);
    await evaluate(`setTimeout(()=>location.assign(${JSON.stringify(entry.url + "?auth_check=1")}),50); true`); await ready();
  });
  await check("both Git roots and an actual Linux terminal are usable through Connector", async () => {
    await eventually(() => evaluate("document.body.innerText.includes('alpha') && document.body.innerText.includes('beta')"), "Explorer roots missing");
    await command("Source Control: Focus on Changes View");
    // The remote extension host starts after the workbench shell. Wait for
    // actual repository discovery, not merely the first rendered panel.
    await eventually(() => evaluate("document.querySelector('.scm-view')?.innerText.includes('alpha') && document.querySelector('.scm-view')?.innerText.includes('beta')"), "Git repositories missing", 60000);
    await command("Terminal: Create New Terminal");
    await eventually(() => evaluate("document.activeElement?.classList.contains('xterm-helper-textarea')"), "Terminal did not open");
    await call("Input.insertText", { text: `pwd > '${path.posix.join(fixture.root, "terminal-cwd.txt").replace(/'/g, "'\\''")}'` }); await key("Enter", "Enter");
    const cwd = await eventually(() => rpc("read", { file: "terminal-cwd.txt" }), "Terminal receipt missing"); assert.equal(cwd.trim(), fixture.roots[0]);
  });
  await check("profile, Emacs navigation and actual remote file save work", async () => {
    await key("Escape", "Escape"); await key("p", "KeyP", process.platform === "darwin" ? 4 : 2);
    await eventually(() => evaluate("Boolean(document.querySelector('.quick-input-widget input'))"), "Open file input missing");
    await evaluate("document.querySelector('.quick-input-widget input').select()"); await call("Input.insertText", { text: path.posix.join(fixture.roots[0], "alpha.txt") });
    await eventually(() => evaluate("document.querySelector('.quick-input-list')?.innerText.includes('alpha.txt')"), "File search missing"); await key("Enter", "Enter");
    await eventually(() => evaluate("Boolean(document.querySelector('.editor-instance .view-lines'))"), "Editor missing");
    const style = await evaluate("(()=>{const s=getComputedStyle(document.querySelector('.editor-instance .view-lines'));return {size:s.fontSize,line:s.lineHeight,dark:document.querySelector('.monaco-workbench').classList.contains('vs-dark'),chat:[...document.querySelectorAll('.auxiliarybar')].some(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).display!=='none')}})()");
    assert.equal(style.size, "12px"); assert.equal(style.line, "18px"); assert.equal(style.dark, true); assert.equal(style.chat, false);
    assert.ok(manager.list()[0].profile?.installed.some(x => x.id === "tuttieee.emacs-mcx"));
    await key("End", "End"); await key("a", "KeyA", 2); await call("Input.insertText", { text: "EMACS_" }); await key("s", "KeyS", process.platform === "darwin" ? 4 : 2);
    await eventually(async () => (await rpc("read", { file: "alpha/alpha.txt" }))?.startsWith("EMACS_alpha sample"), "Remote save failed");
  });
  await check("Gateway IDE restart preserves browser grant and file, without resubmitting native input", async () => {
    await evaluate("setTimeout(()=>location.assign('about:blank'),50); true"); await eventually(() => duringNavigation("location.href === 'about:blank'"), "Navigation stalled");
    await access!.close(); registry.close();
    await eventually(() => { try { return registry.ideConnection(fixture.hostId, { accountId: principal.accountId, subject, threadId: fixture.threadId, workspace: fixture.roots[0] }).connection.open; } catch { return false; } }, "Connector did not reconnect");
    manager = await create(); assert.equal(manager.entry(principal.accountId, "fixture-session")?.url, entry.url);
    await evaluate(`setTimeout(()=>location.assign(${JSON.stringify(entry.url)}),50); true`); await ready();
    assert.equal(access!.pendingAccess().length, 0); assert.ok((await rpc("read", { file: "alpha/alpha.txt" })).startsWith("EMACS_"));
    assert.deepEqual(await rpc("status"), { nativeInputs: fixture.nativeInputs, nativeAlive: true });
  });
  await check("revocation blocks the old browser session", async () => {
    access!.revoke(); await evaluate(`setTimeout(()=>location.assign(${JSON.stringify(entry.url)}),50); true`);
    await eventually(() => duringNavigation("document.body.innerText.includes('等待 Gateway 授权')"), "Revoked session survived");
    assert.equal(await evaluate("Boolean(document.querySelector('.monaco-workbench'))"), false);
  });
});
