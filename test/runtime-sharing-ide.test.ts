import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import { runtimePeerFixture } from "./runtime-peer-fixture.js";
import { principal } from "./peer-fixture.js";
import { ConnectorIDEHostTransport } from "../src/peer/ide-transport.js";
import type { IDEHostContext } from "../src/ide/transport.js";

for (const kind of ["herdr-tui", "herdr-app"] as const) {
  test(`${kind}: owner-approved shared terminal uses the same grant and revocation chain`, async t => {
    const f = await runtimePeerFixture(t, kind); await f.bind();
    const target = { hostId: f.ticket.hostId, threadId: f.id }, visitor = { ...principal, actorId: "visitor", conversationId: "another-room" };
    const share = (arg: string) => f.registry.sharing.command(principal, "share", arg, target, () => {});
    await share("claim --ide");
    const code = /SH-[A-F0-9]{32}/.exec((await share("invite")).text)![0];
    await f.registry.sharing.command(visitor, "join", code, undefined, () => {});
    const status = await f.registry.sharingCall(target.hostId, "status", target, principal, () => {});
    await share(`approve ${status.requests[0].id} --ide read`);
    assert.equal((await f.as(() => f.facade.runtimeRead!(f.id, target.hostId), visitor)).kind, "terminal-screen");
    assert.equal((await f.as(() => f.facade.listSessionCatalog({}, target.hostId), visitor)).threads.length, 1);
    await f.as(() => f.facade.runtimeSend!(f.input("visitor-source"), target.hostId), visitor);
    assert.equal(f.writes.length, 1);
    await share(`revoke ${f.registry.grantsFor(visitor)[0].id}`);
    await assert.rejects(f.as(() => f.facade.runtimeRead!(f.id, target.hostId), visitor));
    await assert.rejects(f.as(() => f.facade.runtimeSend!(f.input("visitor-late"), target.hostId), visitor));
    assert.equal(f.writes.length, 1);
  });
  test(`${kind}: terminal attachments stage into its actual workspace through existing file transport`, async t => {
    const f = await runtimePeerFixture(t, kind); await f.bind();
    const file = path.join(f.root, "input.txt"); fs.writeFileSync(file, "isolated attachment");
    const staged = await f.as(() => f.facade.stageAttachments!([{ kind: "file", label: "input.txt", path: file }], {
      hostId: f.ticket.hostId, accountId: principal.accountId, conversationId: principal.conversationId, threadId: f.id, scope: "test-input", maxBytes: 1024 }));
    assert.equal(staged.length, 1); assert.equal(fs.readFileSync(staged[0].path, "utf8"), "isolated attachment");
    assert.equal(f.writes.length, 0, "transferring a file cannot submit an agent prompt");
  });
  test(`${kind}: full IDE launches on Connector and rejects a remote terminal at a same-named local path`, async t => {
    const f = await runtimePeerFixture(t, kind, { webIDE: { enabled: true, binary: path.resolve("test/fixtures/peer-ide-code-server.mjs"), autoInstall: false } });
    await f.bind();
    const transport = new ConnectorIDEHostTransport(f.registry, { canonicalDirectory() { throw Error("local fallback"); }, launch() { throw Error("local fallback"); } } as never);
    const context: IDEHostContext = { accountId: principal.accountId, threadId: f.id, workspace: f.cwd,
      subject: { principal: { accountId: principal.accountId, actorId: principal.actorId, channel: "dingtalk", providerId: "fixture" }, basis: "im-personal", epoch: 0 } };
    const cwd = await transport.canonicalDirectory(f.ticket.hostId, f.cwd, context); assert.equal(cwd, fs.realpathSync(f.cwd));
    const launch = await transport.launch({ hostId: f.ticket.hostId, id: crypto.randomBytes(16).toString("hex"), binary: "code-server", workspace: cwd,
      context: { ...context, workspace: cwd, rootPaths: undefined }, settings: {}, extensions: [], trustWorkspace: true });
    try {
      let response: string | undefined;
      const deadline = Date.now() + 8000;
      while (!response && Date.now() < deadline) {
        try { response = await new Promise<string>((resolve, reject) => {
          const req = http.get({ socketPath: launch.socketPath, path: "/healthz", agent: false }, res => {
            let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve(body)); res.on("error", reject);
          }); req.setTimeout(1000, () => req.destroy(Error("timeout"))); req.on("error", reject);
        }); } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
      }
      assert.ok(response, "Connector IDE must become reachable"); assert.equal(JSON.parse(response).cwd, cwd);
    } finally { await launch.stop(); }
    f.resources[0].machine = "another-machine";
    await assert.rejects(transport.canonicalDirectory(f.ticket.hostId, f.cwd, context), /另一台|远端|本机/);
    assert.equal(f.writes.length, 0);
  });
}
