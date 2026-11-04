import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { loadPeerIdentity, PeerCredentialStore } from "../src/peer/credentials.js";
import { GatewayPeerServer } from "../src/peer/transport.js";
import { PeerConnection } from "../src/peer/rpc.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { principal, token } from "./peer-fixture.js";

function directory(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-enrollment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
const description = { profileId: "default", label: "New device", independent: true, fullIDE: 1,
  info: { id: "app-server", capabilities: {} } };
async function fixture(t: TestContext, enrollment = true) {
  const root = directory(t), storeFile = path.join(root, "devices.json"), grantsFile = path.join(root, "grants.json");
  const store = new PeerCredentialStore(storeFile), registry = new PeerRegistry(grantsFile);
  const server = await GatewayPeerServer.listen({ host: "127.0.0.1", port: 0, credentials: { legacy: token }, deviceStore: store, enrollment,
    accept: (id, connection, pending) => registry.accept(id, connection, pending) });
  t.after(async () => { registry.close(); await server.close(); });
  async function dial(id = "new-device", secret = token, approve: () => Promise<boolean> = async () => true) {
    const socket = new WebSocket(server.url, { headers: { authorization: `Bearer ${secret}`, "x-gateway-peer-id": id, "x-gateway-peer-enroll": "1" } });
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const connection = new PeerConnection(socket); t.after(() => connection.close());
    connection.handle("binding.approve", approve);
    const ticket = await connection.request<{ code: string; hostId: string; enrollment: boolean; paired: boolean }>("peer.register", description);
    return { connection, ticket };
  }
  const denied = (id: string, secret: string) => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(server.url, { headers: { authorization: `Bearer ${secret}`, "x-gateway-peer-id": id, "x-gateway-peer-enroll": "1" } });
    socket.on("error", () => {}); socket.once("open", () => { socket.terminate(); reject(Error("unexpected admission")); });
    socket.once("unexpected-response", (_req, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
  });
  return { root, store, storeFile, grantsFile, registry, server, dial, denied };
}

test("automatic identity is private, stable, Gateway-scoped and never regenerated after corruption", t => {
  const root = directory(t), url = "wss://example.test/gateway/v1/peer";
  const first = loadPeerIdentity(root, url);
  assert.match(first.nodeId, /^device-/); assert.equal(first.token.length, 64);
  assert.deepEqual(loadPeerIdentity(root, url), first);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(root, "device-identity.json")).mode & 0o777, 0o600);
  assert.throws(() => loadPeerIdentity(root, "wss://other.test/gateway/v1/peer"), /another Gateway/);
  fs.writeFileSync(path.join(root, "device-identity.json"), "corrupt");
  assert.throws(() => loadPeerIdentity(root, url));
  assert.equal(fs.readFileSync(path.join(root, "device-identity.json"), "utf8"), "corrupt");
  fs.writeFileSync(path.join(root, "device-identity.json"), "null");
  assert.throws(() => loadPeerIdentity(root, url));
});

test("real Connector entrypoint starts without nodeId or tokenFile and reuses its private identity", async t => {
  const f = await fixture(t), stateDir = path.join(f.root, "client"), file = path.join(f.root, "client.json");
  fs.writeFileSync(file, JSON.stringify({ url: f.server.url, stateDir, codexHome: path.join(f.root, "codex"), codexBin: "/unused-native-binary" }));
  async function startAndStop() {
    const child = spawn(process.execPath, ["--import", "tsx", "src/peer/index.ts", "--config", file], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => child.kill("SIGKILL"));
    let output = "";
    const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Connector did not offer pairing")), 10_000);
      child.stdout.on("data", data => { output += data.toString(); if (output.includes("/connect ")) { clearTimeout(timer); resolve(); } });
      child.once("exit", () => { clearTimeout(timer); reject(Error("Connector exited before pairing")); });
    });
    const identity = JSON.parse(fs.readFileSync(path.join(stateDir, "device-identity.json"), "utf8"));
    assert.ok(!output.includes(identity.token)); assert.match(output, /待登记/);
    child.kill("SIGTERM"); assert.equal(await exited, 0); return identity;
  }
  assert.deepEqual(await startAndStop(), await startAndStop());
  assert.deepEqual(f.registry.fullIDEHosts(), []);
});

test("enrollment is quarantined until IM guard plus device confirmation; reconnect restores grants", async t => {
  const f = await fixture(t); let approvals = 0;
  const first = await f.dial("new-device", token, async () => { approvals++; return true; });
  assert.equal(first.ticket.enrollment, true); assert.equal(f.store.has("new-device"), false);
  assert.deepEqual(f.registry.fullIDEHosts(), []); assert.deepEqual(f.registry.hosts(principal), []);
  assert.throws(() => f.registry.description(first.ticket.hostId));
  await assert.rejects(first.connection.request("execution.call", {}), /unavailable/);
  let guards = 0;
  await f.registry.connect(first.ticket.code, principal, () => { guards++; });
  assert.equal(guards, 2); assert.equal(approvals, 1);
  assert.equal(f.store.matches("new-device", token), true);
  assert.deepEqual(f.registry.hosts(principal), [first.ticket.hostId]);
  assert.ok(f.registry.fullIDEHosts().includes(first.ticket.hostId));
  assert.ok(!fs.readFileSync(f.storeFile, "utf8").includes(token));
  const loaded = new PeerCredentialStore(f.storeFile); assert.equal(loaded.matches("new-device", token), true);
  first.connection.close();
  const second = await f.dial("new-device", token, async () => { approvals++; return true; });
  assert.equal(second.ticket.enrollment, false); assert.equal(second.ticket.paired, true);
  assert.equal(approvals, 1); assert.equal(second.ticket.hostId, first.ticket.hostId);
  await assert.rejects(f.registry.connect(first.ticket.code, principal, () => {}), /过期/);
});

test("wrong credentials for registered or legacy identities cannot fall back to enrollment", async t => {
  const f = await fixture(t), first = await f.dial();
  await f.registry.connect(first.ticket.code, principal, () => {});
  assert.equal(await f.denied("new-device", "x".repeat(40)), 401);
  assert.equal(await f.denied("legacy", "x".repeat(40)), 401);
  assert.equal(first.connection.open, true);
  const legacy = await f.dial("legacy"); assert.equal(legacy.ticket.enrollment, false);
});

test("self enrollment requires explicit listener configuration", async t => {
  const f = await fixture(t, false); assert.equal(await f.denied("new-device", token), 401);
  f.store.enroll("known-device", token, principal);
  assert.equal((await f.dial("known-device")).ticket.enrollment, false);
});

test("denial and final IM revocation do not publish devices or commit credentials", async t => {
  const f = await fixture(t);
  const denied = await f.dial("denied", token, async () => false);
  await assert.rejects(f.registry.connect(denied.ticket.code, principal, () => {}), /未确认/);
  const revoked = await f.dial("revoked"); let guards = 0;
  await assert.rejects(f.registry.connect(revoked.ticket.code, principal, () => { if (++guards === 2) throw Error("revoked"); }), /revoked/);
  assert.equal(f.store.has("denied"), false); assert.equal(f.store.has("revoked"), false);
  assert.deepEqual(f.registry.hosts(principal), []);
  assert.deepEqual(f.registry.fullIDEHosts(), []);
});

test("two pending sockets cannot race to replace the same device identity", async t => {
  const f = await fixture(t), one = await f.dial(), two = await f.dial();
  await f.registry.connect(one.ticket.code, principal, () => {});
  await assert.rejects(f.registry.connect(two.ticket.code, principal, () => {}), /连接已改变/);
  assert.equal(one.connection.open, true);
});

test("credential storage failure publishes neither identity nor grant", async t => {
  const f = await fixture(t), pending = await f.dial();
  fs.mkdirSync(f.storeFile);
  await assert.rejects(f.registry.connect(pending.ticket.code, principal, () => {}));
  assert.equal(f.store.has("new-device"), false); assert.deepEqual(f.registry.hosts(principal), []);
  assert.throws(() => f.registry.description(pending.ticket.hostId));
});

test("grant storage failure leaves identity recoverable but not usable", async t => {
  const f = await fixture(t), pending = await f.dial(); fs.mkdirSync(f.grantsFile);
  await assert.rejects(f.registry.connect(pending.ticket.code, principal, () => {}));
  assert.equal(f.store.has("new-device"), true); assert.deepEqual(f.registry.hosts(principal), []);
  assert.throws(() => f.registry.description(pending.ticket.hostId));
  fs.rmdirSync(f.grantsFile); pending.connection.close();
  const retry = await f.dial(); assert.equal(retry.ticket.enrollment, false);
  await f.registry.connect(retry.ticket.code, principal, () => {});
  assert.deepEqual(f.registry.hosts(principal), [retry.ticket.hostId]);
});

test("expired pairing cannot enroll and disconnected candidates are retired", async t => {
  const f = await fixture(t), pending = await f.dial();
  const now = Date.now; Date.now = () => now() + 6 * 60_000;
  try { await assert.rejects(f.registry.connect(pending.ticket.code, principal, () => {}), /过期/); }
  finally { Date.now = now; }
  pending.connection.close();
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(f.registry.connect(pending.ticket.code, principal, () => {}), /过期/);
  assert.equal(f.store.has("new-device"), false);
});
