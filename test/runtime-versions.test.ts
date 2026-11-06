import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import { CONTRACTS, runtimeIdentity } from "../src/runtime/versions.js";
import { diagnostic, installDiagnostics, withDiagnosticContext } from "../src/runtime/diagnostics.js";
import { PeerConnection, PeerConnectionError, PeerError } from "../src/peer/rpc.js";
import { GatewayPeerClient, GatewayPeerServer } from "../src/peer/transport.js";
import { peerFixture, token } from "./peer-fixture.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { fileURLToPath, pathToFileURL } from "node:url";

test("VER-01: identities are process snapshots, independent per component and not mutable by callers", () => {
  const first = runtimeIdentity("gateway");
  const expected = structuredClone(first);
  first.productVersion = "FORGED"; first.contracts.peer.major = 99;
  assert.deepEqual(runtimeIdentity("gateway"), expected);
  assert.notEqual(runtimeIdentity("connector").instanceId, expected.instanceId);
  assert.equal(expected.buildStatus, expected.build ? "sealed" : "unsealed");
});

test("VER-02: new peers report their own runtime, exported hosts and retained offline version", async t => {
  const f = await peerFixture(t, { device: true, nativeHost: "remote-ssh-discovered:dev" });
  const row = f.registry.status().routes[0];
  assert.equal(row.compatibility, "compatible");
  assert.equal(row.runtime?.component, "connector");
  assert.equal(row.runtime?.instanceId, runtimeIdentity("connector").instanceId);
  assert.equal(row.nativeHosts[0].nativeHostId, "remote-ssh-discovered:dev");
  row.runtime!.productVersion = "FORGED";
  assert.notEqual(f.registry.status().routes[0].runtime?.productVersion, "FORGED");
  const saved = f.registry.status().routes[0].runtime;
  const closed = new Promise<void>(resolve => f.serverConnection.onClose(resolve));
  f.client.close(); await closed;
  assert.equal(f.registry.status().routes[0].online, false);
  assert.deepEqual(f.registry.status().routes[0].runtime, saved);
});

test("VER-03: old connectors register unchanged and remain explicitly version-unreported", async t => {
  const f = await peerFixture(t, { device: true });
  f.client.close();
  const socket = new WebSocket(f.server.url, { headers: { "x-gateway-peer-id": "laptop", authorization: `Bearer ${token}` } });
  await new Promise<void>(resolve => socket.once("open", resolve));
  const old = new PeerConnection(socket); t.after(() => old.close());
  await old.request("peer.register", { profileId: "old", label: "Old Connector", independent: true,
    info: { id: "app-server", capabilities: {} } });
  const row = f.registry.status().routes.find(r => r.hostId.endsWith(":old"))!;
  assert.equal(row.compatibility, "legacy"); assert.equal(row.runtime, null);
});

test("VER-04: explicit unsupported is the only negotiation fallback; old strict registration gets no new fields", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  let registers = 0;
  server.on("connection", socket => {
    const old = new PeerConnection(socket);
    old.handle("peer.register", params => { assert.deepEqual(params, { profileId: "test" }); registers++; return {}; });
  });
  const connected = Promise.withResolvers<PeerConnection>();
  const client = new GatewayPeerClient({ url: `ws://127.0.0.1:${(server.address() as any).port}/gateway/v1/peer`, nodeId: "laptop", token,
    connected: async connection => { await connection.request("peer.register", { profileId: "test" }); connected.resolve(connection); } });
  t.after(async () => { client.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  client.start(); const connection = await connected.promise;
  assert.equal(connection.versionStatus().compatibility, "legacy"); assert.equal(registers, 1);
});

for (const field of ["peer", "execution"] as const) test(`VER-05: incompatible ${field} major cannot register or execute even if caller ignores refusal`, async t => {
  let writes = 0;
  const server = await GatewayPeerServer.listen({ host: "127.0.0.1", port: 0, credentials: { laptop: token },
    accept: (_id, connection) => { connection.handle("write", () => { writes++; }); } });
  const socket = new WebSocket(server.url, { headers: { "x-gateway-peer-id": "laptop", authorization: `Bearer ${token}` } });
  await new Promise<void>(resolve => socket.once("open", resolve));
  const connection = new PeerConnection(socket); t.after(async () => { connection.close(); await server.close(); });
  const remote = runtimeIdentity("connector"); remote.contracts[field].major++;
  await assert.rejects(connection.request("protocol.negotiate", remote), e => e instanceof PeerError && e.code === "protocol-incompatible");
  await assert.rejects(connection.request("write"), e => e instanceof PeerError && e.code === "protocol-incompatible");
  assert.equal(writes, 0);
});

test("VER-06: compatible newer minor and different artifact release negotiate without changing authorization", async t => {
  const runtime = runtimeIdentity("connector"); runtime.contracts.peer.minor = 99; runtime.productVersion = "8.0.0";
  const ready = Promise.withResolvers<PeerConnection>();
  const server = await GatewayPeerServer.listen({ host: "127.0.0.1", port: 0, credentials: { laptop: token }, accept() {} });
  const client = new GatewayPeerClient({ url: server.url, nodeId: "laptop", token, runtime, connected: connection => { ready.resolve(connection); } });
  t.after(async () => { client.close(); await server.close(); }); client.start();
  const connection = await ready.promise;
  assert.equal(connection.versionStatus().compatibility, "compatible");
  await assert.rejects(connection.request("execution.call", {}), e => e instanceof PeerError && e.code === "unsupported");
});

test("VER-07: versioned HTTP rejects incompatible requests before writes and keeps legacy bodies", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-ver-")); let writes = 0;
  const server = await startLocalHttpServer({ paths: resolveStatePaths(root), port: 0, accountManager: {
    listSessions: () => [], connectorStatus: () => ({ mode: "connector-only", routes: [] }), prepareRelease: () => { writes++; return {}; }
  } as never });
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const old = await fetch(server.url + "/api/sessions"); assert.equal(old.status, 200);
  assert.deepEqual(await old.json(), { sessions: [] });
  assert.equal(old.headers.get("x-gateway-api-version"), "1.0");
  assert.match(old.headers.get("x-gateway-request-id")!, /^[a-f0-9-]{36}$/);
  const incompatible = await fetch(server.url + "/api/release/prepare", { method: "POST",
    headers: { "x-gateway-api-version": "2.0", "x-codex-im-gateway-token": server.requestToken, origin: server.url, "content-type": "application/json" },
    body: JSON.stringify({ id: crypto.randomUUID() }) });
  assert.equal(incompatible.status, 426); assert.equal((await incompatible.json() as any).submission, "not-submitted"); assert.equal(writes, 0);
  const build: any = await fetch(server.url + "/api/build").then(r => r.json());
  assert.equal(build.runtime.instanceId, old.headers.get("x-gateway-instance"));
  const versions: any = await fetch(server.url + "/api/versions").then(r => r.json());
  assert.deepEqual(versions.gateway, build.runtime);
  assert.deepEqual(versions.connectors, { mode: "connector-only", routes: [] });
});

test("VER-08: concurrent request/native logs retain correlation and exclude payloads and credentials", async t => {
  const records: any[] = []; const restore = installDiagnostics("connector", line => records.push(JSON.parse(line)));
  t.after(restore);
  const runner = new AppServerCodexRunner({ catalogSource: "native", codexBin: fileURLToPath(new URL("./fixtures/provider-catalog-app-server.mjs", import.meta.url)) });
  t.after(() => runner.close());
  await Promise.all(["read-one", "read-two"].map(requestId => withDiagnosticContext({ requestId }, async () => {
    await runner.listSessionCatalog(); diagnostic("test.finished", { prompt: "PAYLOAD-SECRET", token: "TOKEN-SECRET", method: "thread/list" });
  })));
  for (const id of ["read-one", "read-two"]) assert.ok(records.some(r => r.event === "native.request.finished" && r.method === "thread/list" && r.requestId === id));
  console.warn("token=TOKEN-SECRET Bearer BEARER-SECRET https://example.test/path?key=URL-SECRET");
  const text = JSON.stringify(records); assert.doesNotMatch(text, /PAYLOAD-SECRET|TOKEN-SECRET|BEARER-SECRET|URL-SECRET/);
  for (const r of records) { assert.equal(r.schemaVersion, CONTRACTS.log.major); assert.equal(r.runtime.component, "connector"); }
  const f = await peerFixture(t, { device: true });
  f.clientConnection.handle("read.diagnostic", () => { diagnostic("device.read"); return {}; });
  await withDiagnosticContext({ requestId: "http-parent" }, () => f.serverConnection.request("read.diagnostic", { prompt: "PAYLOAD-SECRET" }));
  const emitted = records.find(r => r.event === "device.read");
  assert.ok(records.some(r => r.event === "peer.request.finished" && r.requestId === emitted.requestId && r.phase === "outbound" && r.parentRequestId === "http-parent"));
});

for (const failure of ["malformed", "rejected", "disconnected"] as const) test(`VER-09: ${failure} negotiation never proceeds to registration`, async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  let registered = false; const closed = Promise.withResolvers<void>();
  server.on("connection", socket => {
    const wire = new PeerConnection(socket); socket.once("close", () => closed.resolve());
    wire.handle("protocol.negotiate", () => {
      if (failure === "malformed") return { invalid: true };
      if (failure === "disconnected") socket.terminate();
      throw new PeerError("protocol-incompatible", "Fixture rejection");
    });
  });
  const client = new GatewayPeerClient({ url: `ws://127.0.0.1:${(server.address() as any).port}/gateway/v1/peer`, nodeId: "laptop", token,
    reconnectMs: 60_000, connected: () => { registered = true; } });
  t.after(async () => { client.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  client.start(); await closed.promise; assert.equal(registered, false);
});

test("VER-10: timed-out negotiation is not downgraded to legacy and same-process reconnect preserves identity", async t => {
  const f = await peerFixture(t, { device: true });
  const before = f.registry.status().routes[0].runtime;
  await f.reconnect();
  assert.equal(f.registry.status().routes[0].online, true);
  assert.deepEqual(f.registry.status().routes[0].runtime, before);
  // Fault injection at the transport receipt boundary; the live negotiation
  // timeout itself is bounded by PeerConnection's existing request timer.
  const socket = new WebSocket(f.server.url, { headers: { "x-gateway-peer-id": "laptop", authorization: `Bearer ${token}` } });
  await new Promise<void>(resolve => socket.once("open", resolve));
  const wire = new PeerConnection(socket, runtimeIdentity("connector")); t.after(() => wire.close());
  t.mock.method(wire, "request", async () => { throw new PeerConnectionError(true, true); });
  await assert.rejects(wire.negotiate(), e => e instanceof PeerConnectionError && e.timeout);
});

test("VER-11: a restarted device replaces its reported instance without inheriting stale build metadata", async t => {
  const f = await peerFixture(t, { device: true });
  const before = f.registry.status().routes[0].runtime!;
  f.client.close();
  const runtime = { ...runtimeIdentity("connector"), instanceId: crypto.randomUUID(), productVersion: "9.2.0" };
  const ready = Promise.withResolvers<void>();
  const client = new GatewayPeerClient({ url: f.server.url, nodeId: "laptop", token, runtime,
    connected: async connection => {
      await connection.request("peer.register", { profileId: "work", independent: true, info: { id: "app-server", capabilities: {} } });
      ready.resolve();
    } });
  t.after(() => client.close()); client.start(); await ready.promise;
  const after = f.registry.status().routes[0];
  assert.equal(after.online, true); assert.equal(after.runtime?.instanceId, runtime.instanceId);
  assert.equal(after.runtime?.productVersion, "9.2.0"); assert.notEqual(after.runtime?.instanceId, before.instanceId);
  assert.equal(f.runs.length, 0); assert.equal(f.stops.length, 0);
});

test("VER-12: failed log sinks never change request execution or receipt results", async t => {
  const restore = installDiagnostics("connector", () => { throw Error("fixture sink unavailable"); }); t.after(restore);
  const f = await peerFixture(t, { device: true }); let calls = 0;
  f.clientConnection.handle("read.result", () => { calls++; diagnostic("fixture.event"); return { accepted: true }; });
  assert.deepEqual(await f.serverConnection.request("read.result"), { accepted: true }); assert.equal(calls, 1);
});

test("VER-13: sealed artifact version survives metadata replacement until a new process loads it", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-version-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "dist/runtime"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"));
  for (const name of ["versions", "build-info"]) fs.copyFileSync(`src/runtime/${name}.ts`, path.join(root, `dist/runtime/${name}.ts`));
  const manifest = path.join(root, "dist/build-info.json");
  const build = { commit: "a".repeat(40), sourceHash: "b".repeat(64), builtAt: "2026-11-06T00:00:00.000Z", productVersion: "1.2.3" };
  fs.writeFileSync(manifest, JSON.stringify(build));
  const moduleURL = pathToFileURL(path.join(root, "dist/runtime/versions.ts")).href;
  const read = `import {runtimeIdentity,productVersion} from ${JSON.stringify(moduleURL)};`;
  const first = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", read + `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(manifest)}, ${JSON.stringify(JSON.stringify({ ...build, productVersion: "2.0.0" }))});
    console.log(JSON.stringify({runtime:runtimeIdentity('connector'), version:productVersion()}));`], { encoding: "utf8" });
  const initial = JSON.parse(first); assert.equal(initial.version, "1.2.3"); assert.equal(initial.runtime.productVersion, "1.2.3");
  assert.equal(initial.runtime.buildStatus, "sealed");
  const next = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", read + `console.log(JSON.stringify(runtimeIdentity('connector')));`], { encoding: "utf8" }));
  assert.equal(next.productVersion, "2.0.0"); assert.notEqual(next.instanceId, initial.runtime.instanceId);
});
