import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import test from "node:test";
import WebSocket from "ws";
import { peerFixture, principal } from "./peer-fixture.js";
import { ConnectorIDEHostTransport } from "../src/peer/ide-transport.js";
import { ProcessIDEHostTransport, type IDEHostContext } from "../src/ide/transport.js";
import { WorkspaceIDEManager } from "../src/ide/manager.js";
import { IDEAccessServer } from "../src/ide/access-server.js";
import { IDEConfigStore } from "../src/ide/config.js";
import { eventually } from "./helpers/gap-browser.js";
import { AccountManager } from "../src/server/account-manager.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { resolveStatePaths } from "../src/state/paths.js";

const subject = { principal: { accountId: principal.accountId, channel: "dingtalk" as const, providerId: "test-bot", actorId: principal.actorId }, basis: "im-personal" as const, epoch: 0 };
async function fixture(t: test.TestContext, managedHost?: string) {
  const f = await peerFixture(t, { device: true, managedHost, webIDE: { enabled: true, binary: path.resolve("test/fixtures/peer-ide-code-server.mjs"), autoInstall: false } });
  const roots = ["alpha", "beta"].map(n => { const p = path.join(f.root, n); fs.mkdirSync(p); return fs.realpathSync(p); });
  Object.assign(f.thread, { cwd: roots[0], projectId: "project", projectMembership: "assigned" });
  f.projects.push({ id: "project", name: "CLI project", roots });
  if (!managedHost) await f.bind();
  const context: IDEHostContext = { accountId: principal.accountId, subject, threadId: f.thread.threadId, workspace: roots[0], rootPaths: roots };
  const transport = new ConnectorIDEHostTransport(f.registry, { canonicalDirectory() { throw Error("unexpected local/SSH path"); }, launch() { throw Error("unexpected local/SSH path"); } });
  return { ...f, roots, context, transport, input: { hostId: f.ticket.hostId, id: crypto.randomBytes(16).toString("hex"), binary: "code-server", workspace: roots[0], rootPaths: roots,
    context, settings: {}, extensions: [], trustWorkspace: true }, grant: f.registry.grantsFor(principal)[0] };
}
function request(socketPath: string, url = "/healthz", body?: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    const req = http.request({ socketPath, path: url, method: body ? "POST" : "GET", agent: false }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks))); res.on("error", reject);
    });
    req.setTimeout(10000, () => req.destroy(Error("request timed out"))); req.on("error", reject); req.end(body);
  });
}
async function ready(socketPath: string) { await eventually(async () => { try { return await request(socketPath); } catch { return false; } }, "IDE socket did not become ready"); }

for (const changed of ["directory", "project-roots"]) test(`IDE resolution rejects ${changed} changes during remote canonicalization`, async t => {
  const f = await fixture(t);
  const inspect = f.backend.inspectThread.bind(f.backend);
  let calls = 0;
  t.mock.method(f.backend, "inspectThread", async (...args: Parameters<typeof inspect>) => {
    calls++;
    // First inspect establishes scope; the second is after directory IO.
    if (calls === 2) {
      if (changed === "directory") f.thread.cwd = f.roots[1];
      else f.projects[0].roots = [f.roots[1]];
    }
    return inspect(...args);
  });
  await assert.rejects(f.transport.canonicalDirectory(f.ticket.hostId, f.roots[0], f.context), /项目或目录发生变化/);
  assert.equal(f.runs.length, 0); assert.equal(f.stops.length, 0);
});

test("management can enable a paired full IDE device before a project is bound, without admitting unpaired devices", async t => {
  const f = await peerFixture(t, { device: true, webIDE: { enabled: true, binary: path.resolve("test/fixtures/peer-ide-code-server.mjs"), autoInstall: false } });
  const ide = new WorkspaceIDEManager({ root: f.root, resolve: () => undefined });
  const manager = { ide, listProjects: () => [], options: { peerRegistry: f.registry }, listIDEHosts() { return AccountManager.prototype.listIDEHosts.call(this as never); } };
  const api = await startLocalHttpServer({ paths: resolveStatePaths(f.root), port: 0, accountManager: manager as never }); t.after(() => api.close());
  const origin = api.url;
  const get = async (p: string) => (await fetch(origin + p)).json() as any;
  const before = await get("/api/ide"); assert.deepEqual(before.hosts, ["local"]);
  await f.bind(); assert.equal(f.projects.length, 0); assert.ok((await get("/api/ide")).hosts.includes(f.ticket.hostId));
  const config = { ...ide.config(), hosts: [{ hostId: f.ticket.hostId, enabled: true, binary: "code-server" }] };
  const save = (value: unknown) => fetch(origin + "/api/ide/config", { method: "PUT", headers: { Origin: origin, "Content-Type": "application/json", "X-Codex-IM-Gateway-Token": api.requestToken }, body: JSON.stringify({ config: value }) });
  assert.equal((await save(config)).status, 200);
  assert.equal((await save({ ...config, hosts: [{ ...config.hosts[0], hostId: "peer:stranger:default" }] })).status, 400);
  f.registry.close(); assert.ok(manager.listIDEHosts().includes(f.ticket.hostId), "configured offline host is not silently erased from the form");
  assert.equal(f.runs.length, 0);
});

for (const managedHost of [undefined, "local", "remote-ssh-discovered:existing"]) test(`Connector ${managedHost ?? "personal"} full IDE preserves HTTP bytes, WebSocket traffic and both project roots without SSH`, async t => {
  const f = await fixture(t, managedHost);
  assert.equal(await f.transport.canonicalDirectory(f.ticket.hostId, f.roots[0], f.context), f.roots[0]);
  const launch = await f.transport.launch(f.input); t.after(() => launch.stop()); await ready(launch.socketPath);
  const response = JSON.parse(String(await request(launch.socketPath)));
  assert.equal(response.cwd, f.roots[0]); assert.ok(response.args.includes("--disable-workspace-trust"));
  assert.deepEqual(JSON.parse(fs.readFileSync(launch.workspaceFile!, "utf8")).folders.map((r: any) => r.path), f.roots);
  if (managedHost) assert.equal(path.basename(path.dirname(launch.workspaceFile!)), f.input.id, "migrated IDE must reuse the original instance profile");
  else assert.notEqual(path.basename(path.dirname(launch.workspaceFile!)), f.input.id, "personal Connector retains per-principal profiles");
  const bytes = crypto.randomBytes(2 * 1024 * 1024);
  assert.deepEqual(await request(launch.socketPath, "/echo", bytes), bytes, "payload larger than RPC frame is streamed intact");
  const ws = new WebSocket(`ws+unix://${launch.socketPath}:/`); t.after(() => ws.terminate());
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const received = new Promise<Buffer>(resolve => ws.once("message", data => resolve(Buffer.from(data as Buffer))));
  ws.send(bytes); assert.deepEqual(await received, bytes);
  assert.equal(f.runs.length, 0); assert.equal(f.stops.length, 0);
});

test("Connector IDE rejects foreign identities, delegation, roots, session scope and arbitrary proxy targets", async t => {
  const f = await fixture(t);
  for (const other of [undefined, { ...subject, principal: { ...subject.principal, actorId: "other" } }, { ...subject, principal: { ...subject.principal, accountId: "other" } }]) {
    assert.equal(f.transport.canAccess(f.ticket.hostId, { ...f.context, subject: other }), false);
    await assert.rejects(f.transport.launch({ ...f.input, context: { ...f.context, subject: other } }), /身份|授权/);
  }
  const wrong = { ...f.context, rootPaths: [f.roots[0], f.root] };
  await assert.rejects(f.transport.canonicalDirectory(f.ticket.hostId, f.roots[0], wrong), /不一致/);
  await assert.rejects(f.transport.canonicalDirectory(f.ticket.hostId, f.root, f.context), /not an IDE root/);
  const call = { method: "launch", grant: f.grant, target: { threadId: f.thread.threadId, workspace: f.roots[0], rootPaths: f.roots }, id: f.input.id, profile: { settings: {}, extensions: [] }, prepare: false, trustWorkspace: false };
  await assert.rejects(f.serverConnection.request("ide.call", { ...call, binary: "/bin/sh" }));
  await assert.rejects(f.serverConnection.request("ide.call", { ...call, grant: { ...f.grant, principal: { ...principal, actorId: "forged" } } }));
  await assert.rejects(f.serverConnection.request("ide.call", { method: "connect", grant: f.grant, lease: crypto.randomUUID(), stream: crypto.randomUUID(), socketPath: "/tmp/private.sock" }));
  const delegated = { id: crypto.randomUUID(), principal: { ...principal, actorId: "visitor" }, hostId: f.ticket.hostId, threadId: f.thread.threadId,
    delegation: { version: 2 as const, resourceId: crypto.randomUUID(), permissions: ["ide-read" as const, "ide-write" as const], expiresAt: Date.now() + 60000 } };
  f.registry.addSharedGrant(delegated);
  assert.equal(f.registry.fullIDEAvailable(delegated.principal, { hostId: f.ticket.hostId, threadId: f.thread.threadId }), false);
  await assert.rejects(f.serverConnection.request("ide.call", { ...call, grant: delegated }), /终端/);
  assert.equal(f.runs.length, 0);
});

test("Connector disconnect retires only IDE resources; reconnect opens the same profile without a native input", async t => {
  const f = await fixture(t), old = await f.transport.launch(f.input); await ready(old.socketPath);
  const profile = old.workspaceFile!;
  await f.reconnect(); await eventually(() => !old.alive() && !fs.existsSync(old.socketPath), "old IDE listener survived disconnect");
  const fresh = await f.transport.launch(f.input); t.after(() => fresh.stop()); await ready(fresh.socketPath);
  assert.equal(fresh.workspaceFile, profile); assert.equal(f.runs.length, 0); assert.equal(f.stops.length, 0);
});

test("Connector full IDE browser approval requires the paired person; HTTP credentials stay at Gateway", async t => {
  const f = await fixture(t), reserve = net.createServer();
  await new Promise<void>(r => reserve.listen(0, "127.0.0.1", r)); const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>(r => reserve.close(() => r()));
  const manager = new WorkspaceIDEManager({ root: path.join(f.root, "gateway"), transport: f.transport,
    resolve: () => ({ owner: "owner", projectId: "managed-project", sessionId: "s", nativeThreadId: f.thread.threadId,
      hostId: f.ticket.hostId, workspace: f.roots[0], rootPaths: f.roots, projectName: "CLI" }) });
  manager.configStore.save({ ...manager.config(), enabled: true, port, publicOrigin: `http://127.0.0.1:${port}`,
    hosts: [{ hostId: f.ticket.hostId, enabled: true, binary: "code-server" }] });
  const access = new IDEAccessServer(manager, { verificationIntervalMs: 20 }); access.setAccessAuthority({ isSubjectAllowed: () => true });
  await access.reload(false); t.after(() => access.close()); const entry = manager.entry(principal.accountId, "s")!;
  const initial = await fetch(entry.url + "?auth_check=1"), proof = initial.headers.get("set-cookie")!.split(";")[0];
  const pending = access.pendingAccess()[0];
  await assert.rejects(access.grant(entry.id, true), /本人 IM/);
  await assert.rejects(access.approveAccess(pending.id, entry.id, true, undefined, { ...subject, principal: { ...subject.principal, actorId: "other" } }), /未获/);
  await access.approveAccess(pending.id, entry.id, true, undefined, subject);
  const exchange = await fetch(entry.url + "?auth_check=1", { headers: { Cookie: proof }, redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0];
  const openPage = await (await fetch(entry.url, { headers: { Cookie: cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(openPage)![1], origin = new URL(entry.url).origin;
  const opened = await fetch(`${origin}/open/${entry.id}`, { method: "POST", headers: { Cookie: cookie, Origin: origin }, body: new URLSearchParams({ csrf }), redirect: "manual" });
  assert.equal(opened.status, 303);
  const response = await (await fetch(`${origin}/ide/${entry.id}/headers`, { headers: { Cookie: cookie, Authorization: "secret-for-test-only", "X-Forwarded-For": "private" } })).json() as any;
  assert.equal(response.cwd, f.roots[0]); assert.equal(response.headers.cookie, undefined); assert.equal(response.headers.authorization, undefined); assert.equal(response.headers["x-forwarded-for"], undefined);
  const ws = new WebSocket(`${origin.replace("http:", "ws:")}/ide/${entry.id}/`, { headers: { Cookie: cookie, Origin: origin } });
  t.after(() => ws.terminate());
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const closed = new Promise<void>(resolve => ws.once("close", () => resolve()));
  access.revoke();
  await closed;
  const revoked = await fetch(`${origin}/ide/${entry.id}/headers`, { headers: { Cookie: cookie }, redirect: "manual" }); assert.equal(revoked.status, 303);
});

test("cancelled Connector launch retires its late lease receipt without stopping Codex", async t => {
  const f = await fixture(t), received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), abort = new AbortController();
  const original = f.serverConnection.request.bind(f.serverConnection);
  t.mock.method(f.serverConnection, "request", async (method: string, params: any, ...rest: any[]) => {
    const value = await original(method, params, ...rest);
    if (method === "ide.call" && params.method === "launch") { received.resolve(); await release.promise; }
    return value;
  });
  const pending = f.transport.launch({ ...f.input, signal: abort.signal });
  const rejected = assert.rejects(pending, /abort/i);
  await received.promise;
  const marker = path.join(f.roots[0], "ide-test-process.json"); await eventually(() => fs.existsSync(marker), "owned IDE did not start");
  const { pid } = JSON.parse(fs.readFileSync(marker, "utf8"));
  abort.abort(); release.resolve(); await rejected;
  await eventually(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "cancelled IDE child survived");
  assert.equal(f.runs.length, 0); assert.equal(f.stops.length, 0);
});

test("old Connector remains text-only; full IDE configuration cannot invent SSH or executable authority", async t => {
  const f = await peerFixture(t); await f.bind();
  assert.equal(f.registry.fullIDEAvailable(principal, { hostId: f.ticket.hostId, threadId: f.thread.threadId }), false);
  const store = new IDEConfigStore(f.root);
  for (const extra of [{ autoInstall: true }, { binary: "/bin/sh" }, { access: { publicOrigin: "https://10.0.0.1:8790", bindAddress: "10.0.0.1", port: 8790 } }])
    assert.throws(() => store.save({ ...store.config(), hosts: [{ hostId: f.ticket.hostId, enabled: true, binary: "code-server", ...extra }] }), /Connector/);
  const local = new ConnectorIDEHostTransport(f.registry, new ProcessIDEHostTransport());
  assert.equal(await local.canonicalDirectory("local", f.root), fs.realpathSync(f.root));
});
