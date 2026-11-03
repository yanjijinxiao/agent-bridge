import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import type { CodexBridgeBackend, CodexRunnerInput } from "../src/codex/backend.js";
import { PeerExecutionService } from "../src/peer/execution-service.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { withPeerBackend } from "../src/peer/backend.js";
import { GatewayPeerClient, GatewayPeerServer } from "../src/peer/transport.js";
import { peerPrincipal } from "../src/peer/context.js";

const identity = { accountId: "contract-bot", conversationId: "contract-chat", actorId: "contract-owner" };
const modes = ["local", "ssh", "connector"] as const;
type Mode = typeof modes[number];
async function fixture(t: TestContext, mode: Mode) {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-contract-"));
  const remote = mode === "ssh" && process.env.CODEX_CONTRACT_SSH_TARGET;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", process.env.CODEX_CONTRACT_SSH_PORT ?? "22", String(remote)];
  const ssh = (command: string, input?: string) => execFileSync("ssh", [...sshArgs, command], { encoding: "utf8", input, timeout: 15000 });
  const remoteNode = process.env.CODEX_CONTRACT_SSH_NODE ?? "node";
  const root = remote ? ssh("mktemp -d ~/gateway-contract-XXXXXX").trim() : localRoot;
  if (!/^\/home\/[^/]+\/gateway-contract-[A-Za-z0-9]+$/.test(root) && remote) throw Error("Unexpected remote test directory");
  const script = path.join(root, "native.mjs");
  // The same existing wire fixture drives all adapters. No fake facade methods.
  let source = fs.readFileSync(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url), "utf8").replaceAll("/tmp/project", root);
  source = source.replace('  if (message.method === "initialize") {', `
  if (message.method === "skills/list") { respond(message.id, {data: [{cwd: message.params.cwds[0], skills: [{name: "contract", path: message.params.cwds[0] + "/SKILL.md", scope: "repo", enabled: true}], errors: []}]}); return; }
  if (message.method === "mcpServerStatus/list") { respond(message.id, {data: [{name: "contract-mcp", authStatus: "notLoggedIn", tools: {one: {name: "one", description: "fixture"}}}]}); return; }
  if (message.method === "server/diagnostics") { respond(message.id, {process: {id: process.pid}}); return; }
  if (message.method === "initialize") {`);
  if (remote) ssh(`${quote(remoteNode)} -e ${quote('require("node:fs").writeFileSync(process.argv[1], require("node:fs").readFileSync(0))')} ${quote(script)}`, source);
  else fs.writeFileSync(script, source);
  const transport = remote
    ? { command: "ssh", args: [...sshArgs, `${quote(remoteNode)} ${quote(script)}`], mode: "remote-daemon" as const }
    : { command: process.execPath, args: [script], mode: "remote-daemon" as const };
  const native = new AppServerCodexRunner({ transport, catalogSource: "native", requestTimeoutMs: 3000 });
  const gateway: CodexAppServerGateway = new CodexAppServerGateway({ appServerBackend: native, timeoutMs: 3000,
    remoteTransportResolver: () => transport,
    metadataConnectionFactory: host => host === "local" ? native : (gateway as any).appServerFor(host),
    historyConnectionFactory: host => host === "local" ? native : (gateway as any).appServerFor(host) });
  let backend: CodexBridgeBackend = gateway, hostId = mode === "ssh" ? "ssh-contract" : "local";
  const cleanups: Array<() => unknown> = [];
  if (mode === "connector") {
    const registry = new PeerRegistry(path.join(root, "gateway", "grants.json"));
    const service = await PeerExecutionService.create({ backend: gateway, profileId: "contract", stateDir: path.join(root, "device"), independent: true, approve: async () => true });
    const server = await GatewayPeerServer.listen({ host: "127.0.0.1", port: 0, credentials: { contract: "synthetic-contract-credential-only" }, accept: (node, connection) => registry.accept(node, connection) });
    const ready = Promise.withResolvers<{ code: string; hostId: string }>();
    const client = new GatewayPeerClient({ url: server.url, nodeId: "contract", token: "synthetic-contract-credential-only", connected: async connection => {
      service.attach(connection); ready.resolve(await connection.request("peer.register", service.description));
    } });
    client.start(); const ticket = await ready.promise;
    await registry.connect(ticket.code, identity, () => {}); hostId = ticket.hostId;
    const trap = new Proxy(gateway, { get(target, key) {
      if (typeof Reflect.get(target, key) === "function" && !["close", "hasInFlightWork", "hasRestartBlockingWork", "isIndependentObservation"].includes(String(key)))
        return () => { throw Error(`Unexpected Gateway-local call: ${String(key)}`); };
      return Reflect.get(target, key);
    } });
    backend = withPeerBackend(trap, registry);
    cleanups.push(() => client.close(), () => registry.close(), () => server.close());
  }
  t.after(async () => { await backend.close(); for (const close of cleanups) await close(); await gateway.close(); if (remote) ssh(`${quote(remoteNode)} -e ${quote('require("node:fs").rmSync(process.argv[1], {recursive:true,force:true})')} ${quote(root)}`);
    fs.rmSync(localRoot, { recursive: true, force: true }); });
  const as = <T>(action: () => Promise<T>) => peerPrincipal.run(identity, action);
  const input = (extra: Partial<CodexRunnerInput> = {}): CodexRunnerInput => ({ hostId, cwd: root, threadId: "thread-existing", prompt: "hello", clientUserMessageId: "contract-source", assertCurrent() {}, ...extra });
  return { root, backend, hostId, as, input };
}

for (const mode of modes) {
  test(`transport contract ${mode}: catalog, history, models, limits, skills, MCP and diagnostics`, async t => {
    const f = await fixture(t, mode), b = f.backend, h = f.hostId, id = "thread-existing";
    await f.as(async () => {
      const state = await b.inspectThread(id, h, { includeTurns: false, timeoutMs: 2000 });
      assert.equal(state.threadId, id); assert.equal(state.cwd, f.root);
      assert.equal((await b.readThreadSnapshot(id, h)).state.threadId, id);
      assert.ok(Array.isArray((await b.listSessionCatalog({}, h)).threads));
      assert.ok(Array.isArray(await b.listThreads({}, h)));
      assert.ok(Array.isArray(await b.getHistory(id, h)));
      assert.ok(Array.isArray((await b.getHistoryPage(id, { limit: 10, sortDirection: "desc" }, h)).messages));
      assert.ok((await b.listModels(h)).length);
      assert.ok(await b.getAccountRateLimits(h));
      assert.ok(await b.getRuntimeInfo(f.root, id, h, { timeoutMs: 2000 }));
      assert.equal((await b.listSkills!(f.root, h))[0].name, "contract");
      assert.equal((await b.listMcpServers!(id, h))[0].tools[0].name, "one");
      assert.ok((await b.serverIdentity!(h)).processId > 0);
    });
  });
  test(`transport contract ${mode}: goal mutation and native queue identity, ordering and deletion`, async t => {
    const f = await fixture(t, mode), b = f.backend, h = f.hostId, id = "thread-existing";
    await f.as(async () => {
      await b.setGoal(id, { objective: "contract goal", tokenBudget: 100 }, h, () => {});
      assert.equal((await b.getGoal(id, h))?.objective, "contract goal");
      await b.clearGoal(id, h, () => {});
      const first = await b.addQueuedSubmission!({ threadId: id, prompt: "first", clientUserMessageId: "source-first", enqueueOnly: true, assertCurrent() {} }, h);
      const second = await b.addQueuedSubmission!({ threadId: id, prompt: "second", clientUserMessageId: "source-second", enqueueOnly: true, assertCurrent() {} }, h);
      assert.equal(first.clientUserMessageId, "source-first");
      assert.deepEqual((await b.listQueuedSubmissions!(id, undefined, h)).data.map(x => x.clientUserMessageId), ["source-first", "source-second"]);
      assert.equal(await b.deleteQueuedSubmission!(id, second.id, h, () => {}), true);
      assert.deepEqual((await b.listQueuedSubmissions!(id, undefined, h)).data.map(x => x.id), [first.id]);
      let starting = 0;
      const result = await b.runQueuedSubmission!({ ...f.input(), threadId: id, queuedSubmissionId: first.id, clientUserMessageId: "source-first", onQueueStarting: () => { starting++; } });
      assert.equal(result.threadId, id); assert.ok(result.text); assert.equal(starting, 1);
      assert.equal((await b.listQueuedSubmissions!(id, undefined, h)).data.length, 0);
    });
  });
  test(`transport contract ${mode}: streaming, original approval identity and native confirmation`, async t => {
    const f = await fixture(t, mode), requests: unknown[] = [], receipts: unknown[] = [];
    await f.as(async () => {
      const result = await f.backend.run(f.input({ prompt: "approval:command", onApproval: async request => { requests.push(request); return "accept"; },
        onApprovalResult: (request, status) => { receipts.push({ request, status }); } }));
      assert.equal(result.threadId, "thread-existing"); assert.ok(result.text);
      assert.equal(requests.length, 1);
      assert.ok(receipts.some((r: any) => r.request === requests[0] && r.status === "confirmed"));
    });
  });
  test(`transport contract ${mode}: new native thread and dynamic tool callback`, async t => {
    const f = await fixture(t, mode); let call: unknown;
    await f.as(async () => {
      const result = await f.backend.run(f.input({ threadId: undefined, prompt: "dynamic-tool",
        dynamicTools: [{ name: "knowledge", description: "test", inputSchema: { type: "object" } }],
        onDynamicToolCall: async value => { call = value; return "contract tool result"; } }));
      assert.equal(result.threadId, "thread-new"); assert.equal((call as any)?.threadId, result.threadId);
      assert.equal((call as any)?.tool, "search"); assert.ok(result.text);
    });
  });
  test(`transport contract ${mode}: user question and original resolution identity`, async t => {
    const f = await fixture(t, mode); let request: unknown; const resolved: unknown[] = [];
    await f.as(async () => {
      await f.backend.run(f.input({ prompt: "request-user-input", onUserInput: async value => {
        request = value; return { direction: { answers: ["方案 A"] } };
      }, onUserInputResult: (value, result) => { resolved.push([value, result]); } }));
      assert.ok(request); assert.ok(resolved.some((r: any) => r[0] === request && r[1] === "confirmed"));
    });
  });
  test(`transport contract ${mode}: empty thread lifecycle does not start a model turn`, async t => {
    const f = await fixture(t, mode), b = f.backend, h = f.hostId;
    await f.as(async () => {
      const created = await b.createThread!({ cwd: f.root, projectBinding: "none", assertCurrent() {} }, h);
      assert.equal(created.threadId, "thread-new");
      assert.equal((await b.renameThread!(created.threadId, "contract title", h, () => {})).title, "contract title");
      await b.archiveThread(created.threadId, h, () => {});
      assert.equal((await b.inspectThread(created.threadId, h)).persistence, "archived");
      assert.equal((await b.unarchiveThread(created.threadId, h, () => {})).persistence, "active");
      await b.archiveThread(created.threadId, h, () => {});
      await b.deleteThread(created.threadId, h, () => {});
      assert.equal((await b.inspectThread(created.threadId, h)).persistence, "missing");
    });
  });
  test(`transport contract ${mode}: source revocation blocks queue and goal writes`, async t => {
    const f = await fixture(t, mode), b = f.backend, h = f.hostId;
    const denied = () => { throw Error("revoked source"); };
    await f.as(async () => {
      await assert.rejects(b.addQueuedSubmission!({ threadId: "thread-existing", prompt: "must not queue", clientUserMessageId: "denied", assertCurrent: denied }, h));
      assert.equal((await b.listQueuedSubmissions!("thread-existing", undefined, h)).data.length, 0);
      await assert.rejects(b.setGoal("thread-existing", { objective: "must not change" }, h, denied));
    });
  });
}
