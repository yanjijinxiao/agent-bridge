import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IDEAuthorization, IDE_SESSION_TTL_MS } from "../src/ide/authorization.js";
import { IDEAccessServer } from "../src/ide/access-server.js";
import { IDEEndpointManager } from "../src/ide/endpoint-manager.js";
import { WorkspaceIDEManager } from "../src/ide/manager.js";
import type { IDEAccessSubject } from "../src/ide/access-subject.js";
import { isolatedBrowser, eventually } from "./helpers/gap-browser.js";

const subject: IDEAccessSubject = { principal: { accountId: "account", channel: "dingtalk", providerId: "bot", actorId: "owner" }, basis: "im-personal", epoch: 0 };
const fingerprint = crypto.createHash("sha256").update("policy").digest("hex");

test("project-link sessions are project-only, fixed-deadline, restart-safe and never reusable person identities", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-link-auth-")), file = path.join(root, "authorization.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1000, enabled = true, admitted = true;
  const create = () => new IDEAuthorization(() => now, file, "origin", () => admitted, undefined, undefined,
    s => enabled && s.projectLink === fingerprint);
  const a = create(), p = a.request("a"), policy = { fingerprint, expiresAt: now + 5000, subject };
  assert.equal(a.exchangeProjectLink(p.request.id, "bad", "a", "a", policy, "/root"), undefined);
  assert.equal(a.exchangeProjectLink(p.request.id, p.proof, "b", "b", policy, "/root"), undefined);
  const login = a.exchangeProjectLink(p.request.id, p.proof, "a", "a", policy, "/root")!;
  assert.equal(login.session.expiresAt, policy.expiresAt); assert.equal(login.session.trustWorkspace, true);
  assert.equal(a.rememberBrowser(login.session), undefined);
  assert.equal(a.authenticate(login.token, "b"), undefined);
  assert.equal(a.exchangeProjectLink(p.request.id, p.proof, "a", "a", policy, "/root"), undefined);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 4);
  assert.ok(create().authenticate(login.token, "a"));
  assert.equal(fs.readFileSync(file, "utf8").includes(login.token), false);
  assert.equal(new IDEAuthorization(() => now, file, "origin", () => true).authenticate(login.token, "a"), undefined);
  enabled = false; assert.equal(a.active(login.session), false); a.reconcileAccess(); enabled = true;
  assert.equal(create().authenticate(login.token, "a"), undefined, "revoked cookie cannot resurrect");
  const q = a.request("a"), second = a.exchangeProjectLink(q.request.id, q.proof, "a", "a", policy, "/root")!;
  admitted = false; assert.equal(a.active(second.session), false); admitted = true;
  now = policy.expiresAt; assert.equal(a.authenticate(second.token, "a"), undefined);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 4, "never downgrade the provenance format");
});

async function fixture(t: test.TestContext, endpoints = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-link-http-"));
  const probe = net.createServer(); await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as net.AddressInfo).port; await new Promise<void>(r => probe.close(() => r()));
  const origin = `http://127.0.0.1:${port}`, socketPath = path.join(root, "editor.sock");
  const upstream = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(`<p id="editor">editor ready</p><pre>${JSON.stringify(req.headers)}</pre>`); });
  await new Promise<void>(r => upstream.listen(socketPath, r));
  let opened = 0, admitted = true, allowedDevice = true, canonicalGate: (() => Promise<void>) | undefined;
  const manager = new WorkspaceIDEManager({ root, resolve: (_account, session) => ({ owner: "o", sessionId: session, workspace: "/project", hostId: "local", projectName: "project" }),
    transport: { canonicalDirectory: async (_host, dir) => { await canonicalGate?.(); return dir; },
      canAccess: (_host, context) => allowedDevice && context.subject?.principal.actorId === "owner",
      launch: async input => { assert.equal(input.trustWorkspace, true); opened++; return { socketPath, alive: () => true, stop: async () => {} }; } } });
  // Manager's health probe reaches a real Unix HTTP server; no native task is started.
  upstream.removeAllListeners("request"); upstream.on("request", (req, res) => {
    if (req.url === "/healthz") res.end("{}"); else { res.setHeader("Content-Type", "text/html"); res.end('<p id="editor">editor ready</p>'); }
  });
  const policy = { accountId: "account", actorId: "owner", expiresAt: Date.now() + 3600_000 };
  const config = { ...manager.config(), enabled: true, port, publicOrigin: origin,
    hosts: [{ hostId: "local", enabled: true, binary: "code-server", autoInstall: false }], linkAccess: [policy] };
  manager.configStore.save(config);
  const access = endpoints ? new IDEEndpointManager(manager) : new IDEAccessServer(manager);
  access.setAccessAuthority({ isSubjectAllowed: s => admitted && s.principal.actorId === "owner",
    personalSubject: (account, actor) => { if (account !== "account" || actor !== "owner" || !admitted) throw Error("denied"); return subject; } });
  await access.reload(false); const entry = manager.entry("account", "s")!, foreign = manager.entry("other", "other")!;
  t.after(async () => { await access.close(); await manager.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); fs.rmSync(root, { recursive: true, force: true }); });
  const begin = async () => {
    const r = await fetch(entry.url), page = await r.text();
    const request = /name="request" value="([^"]+)"/.exec(page)?.[1];
    return { response: r, page, request, cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") };
  };
  const exchange = (p: Awaited<ReturnType<typeof begin>>, overrides: { origin?: string; request?: string; cookie?: string } = {}) => fetch(entry.url + "?enter=link", {
    method: "POST", headers: { Origin: overrides.origin ?? origin, Cookie: overrides.cookie ?? p.cookie, Accept: "application/json" },
    body: new URLSearchParams({ request: overrides.request ?? p.request ?? "" }), redirect: "manual" });
  return { root, manager, access, config, origin, entry, foreign, begin, exchange, get opened() { return opened; },
    set admitted(value: boolean) { admitted = value; }, set allowedDevice(value: boolean) { allowedDevice = value; },
    set canonicalGate(value: (() => Promise<void>) | undefined) { canonicalGate = value; } };
}

test("fresh browser enters a trusted project link without an IM confirmation, preserving CSRF and project boundaries", async t => {
  const f = await fixture(t), p = await f.begin(); assert.equal(p.response.status, 200);
  assert.match(p.page, /data-ide-link-enter/); assert.doesNotMatch(p.page, /确认本人|等待 Gateway 授权|\/ide trust|dingtalk-jsapi/);
  assert.equal(f.opened, 0, "GET cannot start the editor");
  for (const bad of [{ origin: "https://foreign.invalid" }, { request: "forged" }, { cookie: "" }]) assert.equal((await f.exchange(p, bad)).status, 403);
  const r = await f.exchange(p); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { location: `/workspace/${f.entry.id}` });
  assert.equal((await f.exchange(p)).status, 403, "browser request redeemed once");
  const cookies = r.headers.getSetCookie(); assert.equal(cookies.some(c => c.startsWith("cig_browser_person=")), false);
  const cookie = cookies.find(c => c.startsWith(`cig_ide_${f.entry.id}=`))!.split(";")[0];
  const page = await (await fetch(f.entry.url, { headers: { Cookie: cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1];
  const open = await fetch(`${f.origin}/open/${f.entry.id}`, { method: "POST", headers: { Cookie: cookie, Origin: f.origin, Accept: "application/json" }, body: new URLSearchParams({ csrf }) });
  assert.equal(open.status, 200); assert.equal(f.opened, 1);
  const other = await (await fetch(f.foreign.url + "?auth_check=1", { headers: { Cookie: cookie } })).text();
  assert.doesNotMatch(other, /data-ide-link-enter|已确认本人/);
  f.allowedDevice = false; assert.equal((await fetch(f.entry.url, { headers: { Cookie: cookie } })).status, 403);
});

test("revocation or policy changes during canonical checks cannot approve a late project-link browser", async t => {
  const f = await fixture(t), p = await f.begin();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => release = r), reached = new Promise<void>(r => entered = r);
  f.canonicalGate = async () => { entered(); await gate; };
  const work = f.exchange(p); await reached; f.admitted = false; release();
  assert.equal((await work).status, 403); assert.equal(f.opened, 0);
  assert.equal((await fetch(f.entry.url)).status, 403);
});

test("turning link mode off and on revokes old cookies, while an expired link stops without an approval loop", async t => {
  const f = await fixture(t, true), personal = await f.begin();
  await f.access.approveAccess(personal.request!, f.entry.id, true, undefined, subject);
  await (f.access as IDEEndpointManager).configure({ ...f.config, linkAccess: [] });
  const login = await fetch(f.entry.url + "?auth_check=1", { headers: { Cookie: personal.cookie }, redirect: "manual" });
  assert.equal(login.status, 303);
  const personalCookie = login.headers.getSetCookie().find(c => c.startsWith(`cig_ide_${f.entry.id}=`))!.split(";")[0];
  await (f.access as IDEEndpointManager).configure(f.config);
  const p = await f.begin(), r = await f.exchange(p);
  const cookie = r.headers.getSetCookie().find(c => c.startsWith(`cig_ide_${f.entry.id}=`))!.split(";")[0];
  await (f.access as IDEEndpointManager).configure({ ...f.config, linkAccess: [] });
  await (f.access as IDEEndpointManager).configure(f.config);
  const page = await (await fetch(f.entry.url, { headers: { Cookie: cookie } })).text();
  assert.match(page, /data-ide-link-enter/, "the old cookie is not reused");
  const preserved = await (await fetch(f.entry.url, { headers: { Cookie: personalCookie } })).text();
  assert.doesNotMatch(preserved, /data-ide-link-enter|确认本人/, "changing link policy preserves independent personal grants");
  assert.match(preserved, /name="csrf"/);
  await (f.access as IDEEndpointManager).configure({ ...f.config, linkAccess: [{ ...f.config.linkAccess[0], expiresAt: Date.now() - 1 }] });
  const expired = await fetch(f.entry.url); assert.equal(expired.status, 403); assert.doesNotMatch(await expired.text(), /确认本人|data-ide-link-enter/);
});

for (const legacy of [false, true]) test(`real fresh Chrome opens a project link directly ${legacy ? "without AbortSignal.timeout" : "with modern browser APIs"}`, {
  skip: !process.env.CODEX_CHROME_TEST_BIN, timeout: 45000,
}, async t => {
  const f = await fixture(t), browser = await isolatedBrowser(t, f.root); t.after(() => browser.close());
  try {
    if (legacy) await browser.call("Page.addScriptToEvaluateOnNewDocument", {
      source: "Object.defineProperty(AbortSignal, 'timeout', {value: undefined, configurable: true});"
    });
    await browser.call("Page.navigate", { url: f.entry.url });
    await eventually(async () => {
      try { return await browser.evaluate("document.querySelector('#editor')?.textContent === 'editor ready'"); }
      catch (error) { if (!String(error).includes("Execution context was destroyed")) throw error; return false; }
    }, "direct editor navigation failed");
    assert.equal(f.opened, 1); assert.match(await browser.evaluate("location.pathname") as string, /^\/ide\//);
    const cookies = await browser.call("Network.getCookies", { urls: [f.entry.url] }) as { cookies: { name: string }[] };
    assert.equal(cookies.cookies.some(c => c.name === "cig_browser_person"), false);
  } catch (error) {
    t.diagnostic(JSON.stringify(await browser.evaluate("({path:location.pathname,text:document.body.innerText})").catch(() => ({}))));
    throw error;
  } finally { await browser.close(); }
});
