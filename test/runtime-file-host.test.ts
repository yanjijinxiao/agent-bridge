import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import WebSocket from "ws";
import test from "node:test";
import { herdrFileHost } from "../src/agents/herdr/file-host.js";
import { openHostSocketRelay } from "../src/hosts/socket-relay.js";
import { runtimePeerFixture } from "./runtime-peer-fixture.js";
import { principal } from "./peer-fixture.js";
import { ConnectorIDEHostTransport } from "../src/peer/ide-transport.js";
import type { ScriptHost } from "../src/hosts/script-host.js";
import { runtimeFilesystemScope } from "../src/agents/filesystem-scope.js";
const exec = promisify(execFile);

test("filesystem scope keeps program state orthogonal but rejects resource, directory and project substitution", () => {
  const resource = { ref: { endpointId: "app", id: "dev/t1" }, projectId: "dev/s1", machine: "dev", cwd: "/work",
    incarnation: "process1", state: "idle", kind: "terminal", title: "name", identityStrength: "observed", evidence: "program-report" } as const;
  const before = runtimeFilesystemScope(resource);
  assert.equal(runtimeFilesystemScope({ ...resource, incarnation: "process2", state: "working", title: "renamed" }), before);
  for (const change of [{ cwd: "/other" }, { machine: "other" }, { projectId: "dev/s2" }, { ref: { endpointId: "app", id: "dev/t2" } }])
    assert.notEqual(runtimeFilesystemScope({ ...resource, ...change }), before);
});

test("Herdr machine command uses configured via transport, quotes data, and pins profile identity", async () => {
  const profile = { name: "dev", id: "remote-core", target: "sh -c", via: true, session: null, state: "connected" };
  let current = true;
  const host = await herdrFileHost({ async request(method) { assert.equal(method, "machine.list"); return { machines: [profile] }; } } as never,
    "app-pinned", "dev", "resource-one", async () => { if (!current) throw Error("resource changed"); });
  const input = "quotes ' \" $HOME `whoami` $(uname) 中文\n";
  const call = await host.command("process.stdout.write(process.argv[1]);", input);
  assert.equal((await exec(call.command, call.args)).stdout, input);
  profile.id = "different-core";
  await assert.rejects(host.command(""), /机器身份/);
  profile.id = "remote-core"; profile.target = "another command";
  await assert.rejects(host.command(""), /连接配置/);
  profile.target = "sh -c"; profile.state = "connecting";
  await assert.rejects(host.command(""), /尚未连接/);
  profile.state = "connected"; current = false;
  await assert.rejects(host.command(""), /resource changed/);
});

test("Herdr SSH transport refuses option injection and never enables host-key bypass", async () => {
  const profile = { name: "dev", id: "core", target: "user@dev", via: false, session: null, state: "connected" };
  const rpc = { async request() { return { machines: [profile] }; } };
  const host = await herdrFileHost(rpc as never, "app", "dev", "resource-one", async () => {});
  const other = await herdrFileHost(rpc as never, "app", "dev", "resource-two", async () => {});
  assert.notEqual(host.id, other.id, "same-machine resources cannot replace each other's validator");
  const call = await host.command("void 0");
  assert.equal(call.command, "ssh"); assert.ok(call.args.includes("StrictHostKeyChecking=yes"));
  assert.ok(call.args.includes("user@dev")); assert.ok(!call.args.includes("-tt"));
  profile.target = "-oProxyCommand=bad";
  await assert.rejects(herdrFileHost(rpc as never, "app", "dev", "resource-one", async () => {}), /配置无效/);
});

test("Herdr helpers preserve shell home when a Node wrapper resets HOME to root", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-home-wrapper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(root, "node"), `#!/bin/sh\nHOME=/ exec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
  const profile = { name: "wrapped", id: "core", target: `env PATH=${quote(root + ":" + process.env.PATH)} sh -c`,
    via: true, session: null, state: "connected" };
  const host = await herdrFileHost({ async request() { return { machines: [profile] }; } } as never, "app", "wrapped", "files", async () => {});
  const call = await host.command("process.stdout.write(JSON.stringify({home:require('node:os').homedir(),arg:process.argv[1]}));", "explicit input");
  assert.deepEqual(JSON.parse((await exec(call.command, call.args)).stdout), { home: process.env.HOME, arg: "explicit input" });
});

test("host socket relay carries binary half-close traffic, rechecks each connection, and removes its socket", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-")), remote = path.join(root, "remote.sock");
  const server = net.createServer({ allowHalfOpen: true }, socket => socket.pipe(socket));
  await new Promise<void>(resolve => server.listen(remote, resolve));
  let allowed = true, calls = 0;
  const relay = await openHostSocketRelay("host", remote, async (hostId, script, input) => {
    calls++; assert.equal(hostId, "host"); if (!allowed) throw Error("revoked");
    return { command: process.execPath, args: ["-e", script, Buffer.from(JSON.stringify(input)).toString("base64")] };
  });
  t.after(async () => { await relay.stop(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  const body = crypto.randomBytes(4000000);
  const roundTrip = () => new Promise<Buffer>((resolve, reject) => {
    const socket = net.createConnection(relay.socketPath), chunks: Buffer[] = [];
    socket.on("data", b => { chunks.push(b); socket.pause(); setTimeout(() => socket.resume(), 1); }); socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks))); socket.once("connect", () => socket.end(body));
    socket.setTimeout(3000, () => socket.destroy(Error("relay timeout")));
  });
  assert.deepEqual(await roundTrip(), body); assert.equal(calls, 1);
  allowed = false;
  const denied = await roundTrip().catch(error => { assert.ok(["EPIPE", "ECONNRESET"].includes(error.code)); return Buffer.alloc(0); });
  assert.equal(denied.length, 0); assert.equal(calls, 2);
  await Promise.all([relay.stop(), relay.stop()]); assert.equal(fs.existsSync(path.dirname(relay.socketPath)), false);
});

test("remote runtime files and full IDE use resource-owned helpers through actual Connector RPC", async t => {
  const f = await runtimePeerFixture(t, "herdr-app", { webIDE: { enabled: true, autoInstall: false,
    binary: path.resolve("test/fixtures/peer-ide-code-server.mjs") } }); await f.bind();
  f.resources[0].machine = "dev";
  let id = "runtime-host:one", allowed = true, calls = 0;
  f.runtime.fileHost = async () => {
    const expected = id;
    return { id, async verify() { if (!allowed || id !== expected) throw Error("host changed"); }, async command(script, argument) {
      if (!allowed || id !== expected) throw Error("host changed"); calls++;
      if (argument) {
        const data = JSON.parse(Buffer.from(argument, "base64").toString());
        argument = Buffer.from(JSON.stringify({ ...data, dataRoot: path.join(f.root, "remote-ide") })).toString("base64");
      }
      return { command: process.execPath, args: ["-e", script, argument ?? f.root] };
    } } satisfies ScriptHost;
  };
  const source = path.join(f.root, "input.txt"); fs.writeFileSync(source, "remote bytes");
  const fileOptions = { hostId: f.ticket.hostId, threadId: f.id, maxBytes: 1024, scope: "remote-upload",
    accountId: principal.accountId, conversationId: principal.conversationId };
  const staged = await f.as(() => f.facade.stageAttachments!([{ path: source, label: "input.txt", kind: "file" }], fileOptions));
  assert.ok(staged[0].path.includes(".codex-im-gateway/inbound/"));
  assert.equal(fs.readFileSync(staged[0].path, "utf8"), "remote bytes");
  const downloaded = await f.as(() => f.facade.fetchOutputFile!(staged[0].path, fileOptions));
  assert.equal(fs.readFileSync(downloaded.path, "utf8"), "remote bytes"); await downloaded.dispose();
  id = "runtime-host:two";
  await assert.rejects(f.as(() => f.facade.fetchOutputFile!(staged[0].path, fileOptions)), /读取失败|rejected|failed/i);
  // The shared text editor uses this same remote port while retaining its own
  // delegated read/write grant. It must not inherit the owner's full IDE.
  const shareTarget = { hostId: f.ticket.hostId, threadId: f.id };
  const visitor = { ...principal, actorId: "remote-reader", conversationId: "visitor-room" };
  const share = (arg: string) => f.registry.sharing.command(principal, "share", arg, shareTarget, () => {});
  fs.writeFileSync(path.join(f.cwd, "shared.txt"), "original");
  await share("claim --ide");
  const code = /SH-[A-F0-9]{32}/.exec((await share("invite")).text)![0];
  await f.registry.sharing.command(visitor, "join", code, undefined, () => {});
  const sharing = await f.registry.sharingCall(shareTarget.hostId, "status", shareTarget, principal, () => {});
  await share(`approve ${sharing.requests[0].id} --ide write`);
  const edit = (method: string, args: object) => f.registry.sharingCall(shareTarget.hostId, method, { ...shareTarget, ...args }, visitor, () => {});
  const original = await edit("workspace.read", { path: "shared.txt" });
  await edit("workspace.write", { path: "shared.txt", hash: original.hash, text: "edited remotely" });
  await assert.rejects(edit("workspace.write", { path: "shared.txt", hash: original.hash, text: "stale" }));
  assert.equal(fs.readFileSync(path.join(f.cwd, "shared.txt"), "utf8"), "edited remotely");
  const context = { accountId: principal.accountId, threadId: f.id, workspace: f.cwd,
    subject: { principal: { accountId: principal.accountId, actorId: principal.actorId, channel: "dingtalk", providerId: "test" }, basis: "im-personal", epoch: 0 } } as const;
  const transport = new ConnectorIDEHostTransport(f.registry, { canonicalDirectory() { throw Error("local fallback"); }, launch() { throw Error("local fallback"); } } as never);
  const cwd = await transport.canonicalDirectory(f.ticket.hostId, f.cwd, context);
  const launch = await transport.launch({ hostId: f.ticket.hostId, workspace: cwd, context, id: crypto.randomBytes(16).toString("hex"),
    binary: "code-server", settings: {}, extensions: [], trustWorkspace: true });
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const req = http.get({ socketPath: launch.socketPath, path: "/healthz", agent: false }, res => {
        let body = ""; res.on("data", b => body += b); res.on("end", () => resolve(body)); res.on("error", reject);
      }); req.on("error", reject); req.setTimeout(5000, () => req.destroy(Error("IDE timeout")));
    });
    const response = JSON.parse(result);
    assert.equal(response.cwd, cwd); assert.ok(calls >= 5);
    assert.match(response.args[response.args.indexOf("--socket") + 1], /\.codex-im-gateway\/sockets\//,
      "remote socket must survive an ephemeral Node container's /tmp");
    const ws = new WebSocket(`ws+unix://${launch.socketPath}:/`);
    try {
      await once(ws, "open"); const received = once(ws, "message");
      const payload = crypto.randomBytes(1000000); ws.send(payload);
      const [body, binary] = await received; assert.equal(binary, true); assert.deepEqual(body, payload);
    } finally { ws.terminate(); }
    allowed = false;
    await assert.rejects(transport.canonicalDirectory(f.ticket.hostId, f.cwd, context));
    await assert.rejects(edit("workspace.read", { path: "shared.txt" }));
  } finally { await launch.stop(); }
  assert.equal(f.writes.length, 0); assert.equal(f.stops.length, 0);
});
