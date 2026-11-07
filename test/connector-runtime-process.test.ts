import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { GatewayPeerServer } from "../src/peer/transport.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { connectorOnlyBackend } from "../src/peer/backend.js";
import { peerPrincipal } from "../src/peer/context.js";
import { principal, token } from "./peer-fixture.js";

/** Production main + config + real Peer WS + real adapter JSONL. The only fake
 * is the upstream Herdr process so protocol faults are deterministic. These
 * tests do not stand in for Linux/Mac application acceptance. */
for (const kind of ["herdr-tui", "herdr-app"] as const) for (const signal of ["SIGTERM", "SIGKILL"] as const)
test(`${kind}: executable Connector completes discovery/read/write and ${signal} restart without replay`, { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-process-"));
  // macOS Unix-domain paths must fit sockaddr_un even when TMPDIR is long.
  const socketBase = path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), `ab-${crypto.randomBytes(6).toString("hex")}`);
  const calls: string[] = [], writes: string[] = [], sockets = new Set<net.Socket>();
  let child: ChildProcess | undefined, childOutput = "";
  const cwd = path.join(root, "workspace"); fs.mkdirSync(cwd);
  const agent = { terminal_id: "terminal-1", pane_id: "w1:p1", workspace_id: "w1", name: "fixture", agent: "codex", agent_status: "idle",
    state_change_seq: 1, cwd, agent_session: { source: "hook", agent: "codex", kind: "id", value: "fixture-session" } };
  const terminal = { address: "t1", name: "fixture", cwd, state: "live", pid: 123, created_ms: 1, turn: 0,
    foreground: { pid: 456, name: "node", argv: ["node", "fixture"], cwd }, status: { state: "idle", app: "fixture" }, screen: "fixture" };
  const answer = (method: string, params: any) => {
    calls.push(method);
    switch (method) {
      case "ping": return { type: "pong", version: "0.9.5" };
      case "session.snapshot": return { type: "session_snapshot", snapshot: { version: "0.9.5", workspaces: [{ workspace_id: "w1", label: "Project" }, { workspace_id: "empty", label: "Empty" }], agents: [agent] } };
      case "agent.get": assert.equal(params.target, "w1:p1"); return { type: "agent_info", agent };
      case "agent.read": return { type: "pane_read", read: { text: "upstream screen", truncated: false, pane_id: "w1:p1" } };
      case "agent.prompt": assert.equal(params.target, "w1:p1"); writes.push(params.text); return { type: "agent_prompted", agent };
      case "hello": return { generation: 1, version: "0.1.18", core: { id: "fixture-core" }, methods: ["terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt"] };
      case "doc.get": return { version: 1, value: { spaces: [{ id: "w1", name: "Project", folder: cwd,
        tabs: [{ root: { type: "block", content: { terminal: "t1" } } }] }, { id: "empty", name: "Empty", folder: "", tabs: [] }] } };
      case "terminal.list": return { terminals: [terminal], machines: [] };
      case "terminal.get": assert.equal(params.terminal, "t1"); return terminal;
      case "terminal.read": assert.equal(params.lines, 0); return { text: "upstream screen", complete: true, how: "screen" };
      case "terminal.send": assert.equal(params.force, false); assert.equal(params.if, "idle"); assert.equal(params.wait, false); writes.push(params.text); return { turn: 0, started: null };
      default: throw Error(`Unexpected Herdr method: ${method}`);
    }
  };
  const listen = async (socketPath: string, view = false) => {
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket)); let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk.toString();
        for (let end; (end = buffer.indexOf("\n")) >= 0;) {
          const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (view) {
            assert.deepEqual(request, { ls: true });
            socket.end(JSON.stringify({ spaces: [{ id: "w1", name: "Project", folder: cwd, machine: null,
              tabs: [{ terminals: [{ terminal: "t1" }] }] }, { id: "empty", name: "Empty", folder: "", machine: null, tabs: [] }] }) + "\n");
          } else {
            const result = answer(request.method, request.params);
            const line = JSON.stringify({ ...(kind === "herdr-app" ? { jsonrpc: "2.0" } : {}), id: request.id, result }) + "\n";
            if (kind === "herdr-tui") socket.end(line); else socket.write(line);
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    return server;
  };
  const upstream = await listen(socketBase + ".sock"), window = kind === "herdr-app" ? await listen(socketBase + ".view", true) : undefined;
  const managed = { hostId: "fixture-runtime", nodeId: "fixture", profileId: "work", grantId: crypto.randomUUID() };
  const registry = new PeerRegistry(path.join(root, "gateway-grants.json"), [managed]);
  assert.throws(() => connectorOnlyBackend(registry).backendInfo(managed.hostId), /peer\/discover/,
    "an unregistered managed route must not invent Codex capabilities");
  const gateway = await GatewayPeerServer.listen({ host: "127.0.0.1", port: 0, credentials: { fixture: token },
    accept: (id, connection) => registry.accept(id, connection) });
  const configPath = path.join(root, "connector.json"); fs.writeFileSync(path.join(root, "credential"), token, { mode: 0o600 });
  fs.writeFileSync(configPath, JSON.stringify({ url: gateway.url, nodeId: "fixture", tokenFile: "credential", profileId: "work", stateDir: "state",
    managedRoute: { hostId: managed.hostId, grantId: managed.grantId }, backend: kind,
    runtime: kind === "herdr-tui" ? { version: 1, id: "fixture", kind, socketPath: socketBase + ".sock" }
      : { version: 1, id: "fixture", kind, coreSocketPath: socketBase + ".sock", windowSocketPath: socketBase + ".view", expectedCoreId: "fixture-core" } }));
  const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill(signal); await exited; } child = undefined; };
  t.after(async () => { await stop(); registry.close(); await gateway.close(); for (const socket of sockets) socket.destroy();
    await Promise.all([upstream, ...(window ? [window] : [])].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    for (const suffix of [".sock", ".view"]) fs.rmSync(socketBase + suffix, { force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const start = async () => {
    childOutput = "";
    child = spawn(process.execPath, ["--import", "tsx", "src/peer/index.ts", "--config", configPath], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", chunk => { childOutput += chunk; }); child.stderr!.on("data", chunk => { childOutput += chunk; });
    const until = Date.now() + 8000;
    while (!registry.isOnline(managed.hostId)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > until) throw Error(`Connector failed to register: ${childOutput}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await start(); const facade = connectorOnlyBackend(registry);
  const as = <T>(action: () => T) => peerPrincipal.run(principal, action);
  assert.equal(registry.description(managed.hostId).runtimeContract, 1);
  assert.equal(registry.status().routes[0].runtime?.component, "connector"); // Executor config must not overwrite the handshake.
  const catalog = await as(() => facade.listSessionCatalog({}, managed.hostId)); assert.equal(catalog.threads.length, 1);
  const state = catalog.threads[0]; assert.equal((await as(() => facade.inspectThread(state.threadId, managed.hostId))).projectId, state.projectId);
  assert.equal((await as(() => facade.listProjects(managed.hostId))).projects.length, 2);
  assert.equal((await as(() => facade.runtimeRead!(state.threadId, managed.hostId))).text, "upstream screen");
  const input = { threadId: state.threadId, target: state.resource!, text: "one controlled prompt", clientUserMessageId: "fixture-source", assertCurrent() {} };
  const first = await as(() => facade.runtimeSend!(input, managed.hostId)); assert.equal(first.phase, "confirmed");
  await stop();
  for (let i = 0; registry.isOnline(managed.hostId) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(facade.backendInfo(managed.hostId).id, kind, "disconnect retains the last authenticated runtime instead of Codex fallback");
  await start(); assert.deepEqual(await as(() => facade.runtimeSend!(input, managed.hostId)), first);
  assert.deepEqual(writes, ["one controlled prompt"]);
  assert.ok(!calls.some(m => m.startsWith("thread/") || m.startsWith("turn/") || m === "terminal.run" || m === "agent.start"));
});

test("a failed App handshake closes the socket and exits the Connector without registration", { timeout: 8000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-handshake-"));
  const socketPath = path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), `ab-${crypto.randomBytes(6).toString("hex")}.sock`);
  const sockets = new Set<net.Socket>(); let requests = 0;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.once("data", chunk => {
      requests++; const request = JSON.parse(chunk.toString());
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { generation: 1, version: "0.1.18",
        core: { id: "wrong-core" }, methods: ["terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt"] } }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const config = path.join(root, "config.json"); fs.writeFileSync(config, JSON.stringify({ url: "ws://127.0.0.1:1/gateway/v1/peer", stateDir: "state",
    backend: "herdr-app", runtime: { version: 1, id: "fixture", kind: "herdr-app", coreSocketPath: socketPath,
      windowSocketPath: socketPath + ".unused", expectedCoreId: "expected-core" } }));
  const child = spawn(process.execPath, ["--import", "tsx", "src/peer/index.ts", "--config", config], { stdio: "ignore" });
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(socketPath, { force: true }); });
  const [code] = await once(child, "exit"); assert.equal(code, 1); assert.equal(requests, 1);
  assert.equal(sockets.size, 0, "failure cannot leave the core transport open");
});
