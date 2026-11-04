import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { WorkspaceIDEManager } from "../src/ide/manager.js";
import { IDEAccessServer } from "../src/ide/access-server.js";
import { IDEInstallPendingError } from "../src/ide/installer.js";
import { isolatedBrowser, eventually } from "./helpers/gap-browser.js";

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-progress-"));
  const reserve = net.createServer(); await new Promise<void>(r => reserve.listen(0, "127.0.0.1", r));
  const port = (reserve.address() as net.AddressInfo).port; await new Promise<void>(r => reserve.close(() => r())); const origin = `http://127.0.0.1:${port}`;
  const manager = new WorkspaceIDEManager({ root, resolve: () => ({ owner: "owner", sessionId: "s", hostId: "local", workspace: "/project", projectName: "project" }) });
  manager.configStore.save({ ...manager.config(), enabled: true, port, publicOrigin: origin, hosts: [{ hostId: "local", enabled: true, binary: "code-server" }] });
  let phase: "pending" | "ready" | "error" = "pending", opened = 0;
  manager.open = async () => { opened++; if (phase === "pending") throw new IDEInstallPendingError(); if (phase === "error") throw Error("private SSH stderr must not leak");
    return { id: "i", hostId: "local", workspace: "/project", status: "running", lastUsedAt: Date.now() }; };
  manager.preparationStatus = async () => ({ hostId: "local", version: "4.141.1", updatedAt: "", phase: "gateway-download", bytes: 1048576, total: 251658240 });
  const access = new IDEAccessServer(manager); access.setManagementOrigin(origin); await access.reload(false);
  t.after(async () => { await access.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const entry = manager.entry("a", "s")!, grant = await access.grant(entry.id);
  const authorized = await fetch(`${origin}/authorize`, { method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ entryId: entry.id, token: grant.token }), redirect: "manual" });
  const cookie = authorized.headers.get("set-cookie")!.split(";")[0];
  const page = await (await fetch(entry.url, { headers: { Cookie: cookie } })).text(), csrf = /name="csrf" value="([^"]+)"/.exec(page)![1];
  return { root, manager, access, entry, origin, cookie, csrf, page, get opened() { return opened; }, set phase(value: typeof phase) { phase = value; } };
}

test("IDE preparation JSON keeps progress in place, preserves CSRF and stops on failure", async t => {
  const f = await fixture(t);
  const post = (csrf: string, origin = f.origin) => fetch(`${f.origin}/open/${f.entry.id}`, { method: "POST",
    headers: { Cookie: f.cookie, Origin: origin, Accept: "application/json" }, body: new URLSearchParams({ csrf }), redirect: "manual" });
  for (let i = 0; i < 2; i++) {
    const r = await post(f.csrf); assert.equal(r.status, 202); assert.equal(r.headers.get("location"), null);
    assert.deepEqual(await r.json(), { status: "preparing", phase: "gateway-download", bytes: 1048576, total: 251658240 });
  }
  assert.equal((await post("wrong")).status, 403); assert.equal((await post(f.csrf, "https://other.invalid")).status, 403);
  assert.equal(f.opened, 2);
  f.phase = "error"; const failed = await post(f.csrf); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private SSH/);
  f.phase = "ready"; const ready = await post(f.csrf); assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready", location: `/ide/${f.entry.id}/?folder=%2Fproject` });
  assert.equal(f.access.pendingAccess().length, 0);
});

test("real browser stays on one IDE document while downloading and on preparation failure", {
  skip: !process.env.CODEX_CHROME_TEST_BIN, timeout: 45000,
}, async t => {
  const f = await fixture(t), browser = await isolatedBrowser(t, f.root); t.after(() => browser.close());
  const { call, evaluate } = browser;
  await call("Network.enable");
  const [name, value] = f.cookie.split("="); await call("Network.setCookie", { name, value, url: f.origin, httpOnly: true, sameSite: "Strict" });
  let navigations = 0; browser.onEvent(method => { if (method === "Page.frameNavigated") navigations++; });
  await call("Page.navigate", { url: f.entry.url });
  await eventually(() => evaluate("document.querySelector('[data-ide-open-status]')?.textContent.includes('1.0 / 240.0 MB')"), "Download progress missing");
  const first = navigations; assert.equal(await evaluate("location.pathname"), `/workspace/${f.entry.id}`);
  f.phase = "error";
  await eventually(() => evaluate("document.querySelector('[data-ide-open-status]')?.textContent.includes('失败')"), "Failure was not shown in place");
  assert.equal(navigations, first, "preparation must not navigate between workspace/open pages");
  const count = f.opened; await new Promise(r => setTimeout(r, 5500)); assert.equal(f.opened, count, "failure must stop automatic retries");
  assert.equal(await evaluate("document.querySelector('button').disabled"), false);
});
