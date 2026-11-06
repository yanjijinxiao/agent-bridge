import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { resolveLocalAppServerTransport } from "../src/codex/app-server-daemon.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexConnectionSetupError } from "../src/codex/connection-errors.js";
import { PeerError } from "../src/peer/rpc.js";
import { peerNativeHost } from "../src/peer/registry.js";
import { peerFixture } from "./peer-fixture.js";

test("CAT-01.7: existing native socket stays usable when the configured CLI cannot start a daemon", async t => {
  const home = fs.mkdtempSync("/tmp/gw-cat-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const socket = path.join(home, "app-server-control/app-server-control.sock");
  fs.mkdirSync(path.dirname(socket));
  const server = http.createServer(), ws = new WebSocketServer({ server }), methods: string[] = [];
  ws.on("connection", client => client.on("message", bytes => {
    const req = JSON.parse(String(bytes)); methods.push(req.method);
    if (req.id === undefined) return;
    const result = req.method === "initialize" ? {} : { data: [{ id: "local-native", name: "Local task", cwd: home, source: "appServer", status: { type: "idle" }, projectId: null }], nextCursor: null };
    client.send(JSON.stringify({ id: req.id, result }));
  }));
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const invoked = path.join(home, "launcher-invoked"), binary = path.join(home, "old-codex");
  fs.writeFileSync(binary, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(invoked)},"unexpected daemon start");process.exit(17);`);
  fs.chmodSync(binary, 0o700);
  const runner = new AppServerCodexRunner({ codexHome: home, catalogSource: "native", requestTimeoutMs: 2000,
    transport: resolveLocalAppServerTransport({ mode: "daemon", codexHome: home, codexBin: binary }) });
  try {
    const catalog = await runner.listSessionCatalog();
    assert.deepEqual(catalog.threads.map(t => t.threadId), ["local-native"]);
    assert.equal(fs.existsSync(invoked), false);
    assert.deepEqual(methods, ["initialize", "initialized", "thread/list"]);
  } finally {
    await runner.close(); for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => server.close(() => resolve())));
  }
});

for (const mode of ["missing-command", "rejected-start"] as const) test(`CAT-01.7: unavailable local daemon reports safe setup stage (${mode})`, async t => {
  const home = fs.mkdtempSync("/tmp/gw-cat-"); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const binary = path.join(home, "codex");
  if (mode === "rejected-start") {
    fs.writeFileSync(binary, `#!${process.execPath}\nprocess.stderr.write("token=TEST-SECRET"); process.exit(17);`); fs.chmodSync(binary, 0o700);
  }
  const transport = resolveLocalAppServerTransport({ mode: "daemon", codexHome: home, codexBin: binary })!;
  await assert.rejects(transport.prepare!(), (error: unknown) => {
    assert.ok(error instanceof CodexConnectionSetupError);
    assert.equal(error.reason, mode === "missing-command" ? "command-unavailable" : "start-failed");
    assert.doesNotMatch(String(error), /TEST-SECRET/); return true;
  });
});

const fixture = fileURLToPath(new URL("./fixtures/provider-catalog-app-server.mjs", import.meta.url));
test("CAT-01.7: stale socket permits same-home startup but permission failure never starts another service", async t => {
  const home = fs.mkdtempSync("/tmp/gw-cat-"); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, "app-server-control"), socket = path.join(directory, "app-server-control.sock");
  fs.mkdirSync(directory);
  const stale = net.createServer(); await new Promise<void>(resolve => stale.listen(socket, resolve));
  // Closing a Node server unlinks its original path. Preserve a genuine Unix
  // socket inode under another name so this models a crashed native daemon.
  fs.renameSync(socket, socket + ".stale"); await new Promise<void>(resolve => stale.close(() => resolve()));
  fs.renameSync(socket + ".stale", socket);
  const output = path.join(home, "startup-home"), binary = path.join(home, "codex");
  fs.writeFileSync(binary, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(output)},process.env.CODEX_HOME);`); fs.chmodSync(binary, 0o700);
  const transport = resolveLocalAppServerTransport({ mode: "daemon", codexHome: home, codexBin: binary })!;
  await transport.prepare!(); assert.equal(fs.readFileSync(output, "utf8"), home);
  fs.unlinkSync(output);
  fs.chmodSync(directory, 0o000);
  try {
    await assert.rejects(transport.prepare!(), (error: unknown) => error instanceof CodexConnectionSetupError && error.reason === "socket-unavailable");
    assert.equal(fs.existsSync(output), false);
  } finally { fs.chmodSync(directory, 0o700); }
  assert.ok(fs.statSync(socket).isSocket(), "the Connector cannot delete a native socket/lock");
});

test("CAT-01.7: native catalogs keep earlier model providers across every active and archived page", async t => {
  const runner = new AppServerCodexRunner({ catalogSource: "native", requestTimeoutMs: 2000,
    transport: { command: process.execPath, args: [fixture], mode: "daemon-proxy" } });
  t.after(() => runner.close());
  for (const persistence of ["active", "archived"] as const) {
    const states = await runner.listThreads({ persistence });
    assert.deepEqual(states.map(s => s.threadId).sort(), ["current-provider", "previous-provider"]);
  }
});

test("CAT-01.7: local RPC failure crosses Connector with safe stage while remote catalog and host identity survive", async t => {
  const remote = "remote-ssh-discovered:ag_machine2";
  const f = await peerFixture(t, { device: true, nativeHost: remote }); await f.bind();
  const runner = new AppServerCodexRunner({ catalogSource: "native", requestTimeoutMs: 2000,
    transport: { command: process.execPath, args: [fixture, "--reject"], mode: "daemon-proxy" } });
  t.after(() => runner.close());
  f.backend.listSessionCatalog = async (_, host) => host === remote
    ? { backend: "app-server", source: "app-server-storage", threads: [f.thread], hostIds: [], complete: true, warnings: [] }
    : runner.listSessionCatalog();
  const host = peerNativeHost(f.ticket.hostId, remote);
  await f.as(async () => {
    await assert.rejects(f.facade.listSessionCatalog({}, f.ticket.hostId), (error: unknown) => {
      assert.ok(error instanceof PeerError); assert.equal(error.code, "native-request");
      assert.deepEqual(error.data, { operation: "thread/list", rpcCode: -32602 });
      assert.match(error.message, /thread\/list/); assert.doesNotMatch(JSON.stringify(error) + String(error), /TEST-SECRET|private\/user/); return true;
    });
    assert.equal((await f.facade.listSessionCatalog({}, host)).threads.length, 1);
    f.backend.listSessionCatalog = async () => { throw new CodexConnectionSetupError("start-failed", Error("TEST-SECRET")); };
    await assert.rejects(f.facade.listSessionCatalog({}, f.ticket.hostId), (error: unknown) => {
      assert.ok(error instanceof PeerError); assert.equal(error.code, "native-setup");
      assert.deepEqual(error.data, { reason: "start-failed" }); assert.doesNotMatch(JSON.stringify(error) + String(error), /TEST-SECRET/); return true;
    });
  });
  assert.equal(f.registry.label(host), "ag_machine2（经 我的笔记本）");
  assert.equal(f.registry.label(f.ticket.hostId), "我的笔记本");
  assert.equal(f.runs.length, 0); assert.deepEqual(f.stops, []);
});
