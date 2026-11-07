import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { RuntimeLifecycleCoordinator, runtimeLifecycleSchema, type RuntimeLifecycleAction } from "../src/agents/lifecycle.js";
import { RuntimeError, type AgentRuntimeAdapter, type RuntimeResource, type RuntimeCreate } from "../src/agents/contracts.js";
import { HerdrTuiAdapter } from "../src/agents/herdr/tui.js";
import { HerdrAppAdapter } from "../src/agents/herdr/app.js";
import { HerdrAppViewClient } from "../src/agents/herdr/app-view.js";
import type { RuntimeRpc, RuntimeRequestOptions } from "../src/agents/json-line-client.js";
import { parseRuntimeCreateCommand } from "../src/bridge/runtime-lifecycle-command.js";
import { runtimePeerFixture } from "./runtime-peer-fixture.js";
import { RuntimeWriteGate } from "../src/agents/write-gate.js";
import { RuntimeHandoffCoordinator, RuntimeHandoffJournal } from "../src/agents/handoff.js";

const source = { principal: "user:chat", sourceId: "msg", operationId: "create-msg" };
const launch = (): Extract<RuntimeLifecycleAction, { action: "create" }> => ({ action: "create", program: "codex", args: ["--model", "example"],
  title: "review", cwd: "/tmp/project", clientUserMessageId: "msg" });
const resource = (): RuntimeResource => ({ ref: { endpointId: "runtime", id: "t1" }, kind: "terminal", title: "review", cwd: "/tmp/project",
  state: "idle", evidence: "program-report", identityStrength: "observed", incarnation: "process-1" });
const noop = () => {};
function journal(t: TestContext) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ablifecycle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, "journal.json"); }

test("input and resource close share only the handoff lock; other resources and later close remain independent", async t => {
  const gate = new RuntimeWriteGate(), entered = Promise.withResolvers(), release = Promise.withResolvers(); let closes = 0;
  const adapter = { async send(i: any) { i.assertCurrent(); entered.resolve(); await release.promise;
    return { kind: "terminal-written", ref: i.target.ref, incarnation: i.target.incarnation, started: true }; },
    async closeResource(i: any) { i.assertCurrent(); closes++; return { kind: "closed", ref: i.target.ref, scope: "pane" }; }
  } as AgentRuntimeAdapter;
  const send = new RuntimeHandoffCoordinator(adapter, new RuntimeHandoffJournal(journal(t)), gate);
  const lifecycle = new RuntimeLifecycleCoordinator(adapter, journal(t), gate);
  const running = send.sendOnce({ target: resource(), text: "hello", source, assertCurrent: noop }); await entered.promise;
  const input = { action: "close" as const, threadId: "thread", target: resource(), clientUserMessageId: "close" };
  const closeSource = { ...source, sourceId: "close", operationId: "close" };
  await assert.rejects(lifecycle.execute(input, closeSource, noop), { code: "not-ready", submission: "not-sent" });
  assert.equal(closes, 0);
  assert.equal((await lifecycle.execute({ ...input, target: { ...resource(), ref: { endpointId: "other", id: "t1" } } },
    { ...closeSource, sourceId: "other", operationId: "other" }, noop)).phase, "confirmed");
  release.resolve(); await running;
  assert.equal((await lifecycle.execute(input, closeSource, noop)).phase, "confirmed"); assert.equal(closes, 2);
});

test("lifecycle records topology before launch; same source and restart return evidence without replay", async t => {
  const file = journal(t); let calls = 0;
  const adapter = { async create(input: RuntimeCreate) {
    assert.match(fs.readFileSync(file, "utf8"), /writing/); input.assertCurrent(); calls++;
    input.onCreated(resource().ref); assert.match(fs.readFileSync(file, "utf8"), /created/); return resource();
  } } as AgentRuntimeAdapter;
  const c = new RuntimeLifecycleCoordinator(adapter, file);
  assert.equal((await c.execute(launch(), source, noop)).phase, "confirmed");
  assert.equal((await new RuntimeLifecycleCoordinator(adapter, file).execute(launch(), source, noop)).phase, "confirmed");
  assert.equal(calls, 1); assert.ok(!fs.readFileSync(file, "utf8").includes("--model"));
  await assert.rejects(c.execute({ ...launch(), program: "claude" }, source, noop), { code: "scope" });
});
for (const failure of ["known", "unknown"]) test(`lifecycle ${failure} launch failure retains first topology and never recreates`, async t => {
  const file = journal(t); let calls = 0;
  const adapter = { async create(input: RuntimeCreate) { input.assertCurrent(); calls++; input.onCreated(resource().ref);
    throw new RuntimeError("transport", "startup", failure === "known" ? "not-sent" : "unknown"); } } as AgentRuntimeAdapter;
  const first = await new RuntimeLifecycleCoordinator(adapter, file).execute(launch(), source, noop);
  assert.equal(first.phase, failure === "known" ? "partial" : "unknown"); assert.deepEqual(first.created, resource().ref);
  assert.deepEqual(await new RuntimeLifecycleCoordinator(adapter, file).execute(launch(), source, noop), first); assert.equal(calls, 1);
});
test("lifecycle disk failure before intent cannot invoke adapter", async t => {
  const file = journal(t); let calls = 0; const c = new RuntimeLifecycleCoordinator({ async create() { calls++; return resource(); } } as AgentRuntimeAdapter, file);
  fs.mkdirSync(file); await assert.rejects(c.execute(launch(), source, noop), { submission: "not-sent" }); assert.equal(calls, 0);
});
test("lifecycle intermediate persistence failure prevents second stage and remains unknown", async t => {
  const file = journal(t); let starts = 0;
  const adapter = { async create(input: RuntimeCreate) { input.assertCurrent(); fs.unlinkSync(file); fs.mkdirSync(file);
    input.onCreated(resource().ref); starts++; return resource(); } } as AgentRuntimeAdapter;
  await assert.rejects(new RuntimeLifecycleCoordinator(adapter, file).execute(launch(), source, noop), { submission: "unknown" }); assert.equal(starts, 0);
});
test("lifecycle cached evidence still requires source authorization", async t => {
  const c = new RuntimeLifecycleCoordinator({ async create(i: RuntimeCreate) { i.assertCurrent(); return resource(); } } as AgentRuntimeAdapter, journal(t));
  await c.execute(launch(), source, noop); await assert.rejects(c.execute(launch(), source, () => { throw Error("revoked"); }), /revoked/);
});
test("lifecycle rejects competing create while handoff waits but not after it completes", async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let calls = 0;
  const c = new RuntimeLifecycleCoordinator({ async create(i: RuntimeCreate) { i.assertCurrent(); calls++; entered.resolve(); await release.promise; return resource(); } } as AgentRuntimeAdapter, journal(t));
  const first = c.execute(launch(), source, noop); await entered.promise;
  await assert.rejects(c.execute({ ...launch(), clientUserMessageId: "two" }, { ...source, operationId: "two" }, noop), { code: "not-ready" });
  release.resolve(); await first; await c.execute({ ...launch(), clientUserMessageId: "two" }, { ...source, operationId: "two" }, noop); assert.equal(calls, 2);
});
test("lifecycle malformed result never becomes a confirmed action", async t => {
  const c = new RuntimeLifecycleCoordinator({ async create(i: RuntimeCreate) { i.assertCurrent(); return {} as RuntimeResource; } } as AgentRuntimeAdapter, journal(t));
  assert.equal((await c.execute(launch(), source, noop)).phase, "unknown");
});
test("runtime create parser preserves literal args without shell expansion and rejects ambiguous flags", () => {
  assert.deepEqual(parseRuntimeCreateCommand('--agent codex --name review --cwd "/tmp/with space" -- --message "$(whoami)"'),
    { program: "codex", title: "review", cwd: "/tmp/with space", args: ["--message", "$(whoami)"] });
  for (const value of ['--agent codex', '--agent codex --agent claude --name x', '--agent codex --name "bad', '--agent codex --name x --unknown y'])
    assert.equal(parseRuntimeCreateCommand(value), undefined);
  for (const patch of [{ cwd: "relative" }, { program: "codex;evil" }, { title: "\n" }, { args: ["bad\0"] }])
    assert.equal(runtimeLifecycleSchema.safeParse({ ...launch(), ...patch }).success, false);
});

class Rpc implements RuntimeRpc {
  writes: string[] = [];
  constructor(public answer: (method: string, params: any) => unknown) {}
  async request(method: string, params: any = {}, options: RuntimeRequestOptions = {}) {
    await options.prepareWrite?.(); options.beforeWrite?.(); if (options.write) this.writes.push(method);
    return this.answer(method, params);
  }
  close() {}
}
function tui() {
  let started = false, closed = false;
  const agent = { terminal_id: "t1", pane_id: "w1:t1:p1", workspace_id: "w1", name: "review", agent: "codex", agent_status: "idle", state_change_seq: 1, cwd: "/tmp/project" };
  const rpc = new Rpc((m, p) => {
    if (m === "ping") return { type: "pong", version: "0.9.5" };
    if (m === "session.snapshot") return { type: "session_snapshot", snapshot: { version: "0.9.5", workspaces: [{ workspace_id: "w1", label: "Work" }], agents: started && !closed ? [agent] : [] } };
    if (m === "workspace.create" || m === "tab.create") return { type: m === "tab.create" ? "tab_created" : "workspace_created", root_pane: { pane_id: agent.pane_id, terminal_id: agent.terminal_id } };
    if (m === "pane.get") return { type: "pane_info", pane: { ...agent, agent: null } };
    if (m === "agent.start") { assert.equal(p.pane_id, agent.pane_id); started = true; return { type: "agent_started", agent, argv: ["codex"] }; }
    if (m === "agent.get") { assert.ok(started); return { type: "agent_info", agent }; }
    if (m === "agent.rename") { agent.name = p.name; return { type: "agent_info", agent }; }
    if (m === "pane.close") { assert.equal(p.pane_id, agent.pane_id); closed = true; return { type: "ok" }; }
    throw Error(m);
  });
  return { adapter: new HerdrTuiAdapter("runtime", rpc), rpc, agent };
}
test("TUI creates shell topology through pane.get then starts, names and closes exactly its agent", async () => {
  const f = tui(); let durable = false;
  const target = await f.adapter.create({ ...launch(), assertCurrent: noop, onCreated() { durable = true; } }); assert.ok(durable);
  assert.equal((await f.adapter.rename({ target, title: "renamed", assertCurrent: noop })).title, "renamed");
  assert.equal((await f.adapter.closeResource({ target, assertCurrent: noop })).scope, "pane");
  assert.deepEqual(f.rpc.writes, ["workspace.create", "agent.start", "agent.rename", "pane.close"]);
});
test("TUI source revoked between topology and launch preserves pane without a second write", async () => {
  const f = tui(); let live = true;
  await assert.rejects(f.adapter.create({ ...launch(), assertCurrent() { if (!live) throw Error("revoked"); }, onCreated() { live = false; } }), /revoked/);
  assert.deepEqual(f.rpc.writes, ["workspace.create"]);
});
test("TUI malformed topology acknowledgement never starts an agent", async () => {
  const f = tui(), original = f.rpc.answer; f.rpc.answer = (m, p) => m === "workspace.create" ? { type: "workspace_created" } : original(m, p);
  await assert.rejects(f.adapter.create({ ...launch(), assertCurrent: noop, onCreated: noop }), { submission: "unknown" });
  assert.deepEqual(f.rpc.writes, ["workspace.create"]);
});
test("TUI changed shell pane is not used to launch into another terminal", async () => {
  const f = tui(); await assert.rejects(f.adapter.create({ ...launch(), assertCurrent: noop,
    onCreated() { f.agent.terminal_id = "replacement"; } }), { code: "changed" });
  assert.deepEqual(f.rpc.writes, ["workspace.create"]);
});
test("TUI start rechecks cwd after the final asynchronous source callback", async () => {
  const f = tui(); let callbacks = 0;
  await assert.rejects(f.adapter.create({ ...launch(), assertCurrent: noop, onCreated: noop,
    prepareWrite: async () => { if (++callbacks === 2) f.agent.cwd = "/different"; } }), { code: "changed" });
  assert.deepEqual(f.rpc.writes, ["workspace.create"]);
});
test("TUI startup dialog is not a ready agent for rename", async () => {
  const f = tui(), target = await f.adapter.create({ ...launch(), assertCurrent: noop, onCreated: noop });
  Object.assign(f.agent, { launch_pending: true });
  await assert.rejects(f.adapter.rename({ target, title: "early", assertCurrent: noop }), { code: "not-ready", submission: "not-sent" });
  assert.deepEqual(f.rpc.writes, ["workspace.create", "agent.start"]);
});

function app() {
  let title = "review"; const commands: unknown[] = [];
  const terminal = { address: "t1", name: null, cwd: "/tmp/project", state: "live", pid: 1, created_ms: 100, turn: 0,
    foreground: { pid: 2, name: "codex", argv: ["codex"], cwd: "/tmp/project" }, status: { state: "idle", app: "codex" }, screen: "" };
  const terminals = [{ terminal: "t1" }];
  const view = { async list() { return { spaces: [{ id: "s1", name: "Project", folder: "/tmp/project", machine: null,
    tabs: [{ id: "tab1", name: title, terminals }] }] }; },
    async command(name: any, args: any, options: RuntimeRequestOptions) { await options.prepareWrite?.(); options.beforeWrite?.(); commands.push([name, args]);
      if (name === "tab.rename") { title = args.name; return { ok: true }; }
      return { space: "s1", tab: "tab1", terminal: "t1" }; } };
  const rpc = new Rpc((m, p) => {
    if (m === "hello") return { generation: 1, version: "0.1.18", core: { id: "core" }, methods: ["terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill"] };
    if (m === "doc.get") return { version: 1, value: { spaces: [{ id: "s1", name: "Project", folder: "/tmp/project", tabs: [{ root: { type: "row", children: terminals.map(t => ({ type: "block", content: t })) } }] }] } };
    if (m === "terminal.get") { assert.equal(p.terminal, "t1"); return terminal; }
    if (m === "terminal.kill") { terminal.state = "finished"; return terminal; }
    throw Error(m);
  });
  return { adapter: new HerdrAppAdapter("runtime", rpc, view, "core"), rpc, commands, terminals, terminal };
}
test("App launch explicitly targets project, name, argv and cwd; close only calls terminal kill", async () => {
  const f = app(); const target = await f.adapter.create({ ...launch(), projectId: "s1", assertCurrent: noop, onCreated: noop });
  assert.deepEqual(f.commands[0], ["tab.new", { name: "review", folder: "/tmp/project", argv: ["codex", "--model", "example"], space: "s1" }]);
  assert.equal((await f.adapter.rename({ target, title: "new label", assertCurrent: noop })).title, "new label");
  assert.equal((await f.adapter.closeResource({ target, assertCurrent: noop })).scope, "terminal-process");
  assert.deepEqual(f.rpc.writes, ["terminal.kill"]); assert.equal(f.terminals.length, 1);
});
test("App rename rechecks tab membership after the asynchronous write authorization", async () => {
  const f = app(); const target = await f.adapter.inspect(resource().ref);
  await assert.rejects(f.adapter.rename({ target, title: "unsafe", assertCurrent: noop,
    prepareWrite: async () => { f.terminals.push({ terminal: "t2" }); } }), { code: "changed" });
  assert.equal(f.commands.length, 0);
});
test("TUI close rechecks pane position after asynchronous write authorization", async () => {
  const f = tui(); const target = await f.adapter.create({ ...launch(), assertCurrent: noop, onCreated: noop });
  await assert.rejects(f.adapter.closeResource({ target, assertCurrent: noop,
    prepareWrite: async () => { f.agent.pane_id = "w2:t2:p2"; } }), { code: "changed" });
  assert.deepEqual(f.rpc.writes, ["workspace.create", "agent.start"]);
});
test("App resource rename cannot rename a tab with sibling terminals", async () => {
  const f = app(); const target = await f.adapter.inspect(resource().ref); f.terminals.push({ terminal: "t2" });
  await assert.rejects(f.adapter.rename({ target, title: "wrong", assertCurrent: noop }), { code: "unsupported" }); assert.equal(f.commands.length, 0);
});
test("App mismatched project directory refuses creation before any command", async () => {
  const f = app(); await assert.rejects(f.adapter.create({ ...launch(), projectId: "s1", cwd: "/elsewhere", assertCurrent: noop, onCreated: noop }), { code: "scope" });
  assert.equal(f.commands.length, 0);
});
test("App process replacement prevents close even when terminal address is the same", async () => {
  const f = app(); const target = await f.adapter.inspect(resource().ref); f.terminal.foreground.pid++;
  await assert.rejects(f.adapter.closeResource({ target, assertCurrent: noop }), { code: "changed" }); assert.equal(f.rpc.writes.length, 0);
});
for (const reply of ['{"error":"the window did not answer"}\n', '{"bad":\n', "disconnect"]) test(`App lifecycle window ${reply.trim()} is unknown after write`, async t => {
  const file = journal(t), socket = path.join(path.dirname(file), "s"); let writes = 0;
  const server = net.createServer(s => s.once("data", () => { writes++; if (reply === "disconnect") s.destroy(); else s.end(reply); }));
  await new Promise<void>(r => server.listen(socket, r)); t.after(() => server.close());
  const client = new HerdrAppViewClient(socket); t.after(() => client.close());
  await assert.rejects(client.command("space.new", { name: "test" }, { beforeWrite: noop }), { submission: "unknown" }); assert.equal(writes, 1);
});

for (const kind of ["herdr-tui", "herdr-app"] as const) {
  test(`${kind}: lifecycle traverses real Peer authorization and reuses confirmed receipt after reconnect`, async t => {
    const f = await runtimePeerFixture(t, kind); await f.bind(); let creates = 0;
    f.runtime.create = async input => { await input.prepareWrite?.(); input.assertCurrent(); creates++; const r = { ...resource(), ref: { endpointId: f.resources[0].ref.endpointId, id: "created" }, cwd: f.cwd };
      input.onCreated(r.ref); f.resources.push(r); return r; };
    const input = { ...launch(), cwd: f.cwd, assertCurrent: noop };
    const first = await f.as(() => f.facade.runtimeLifecycle!(input, f.ticket.hostId)); assert.equal(first.phase, "confirmed");
    await f.reconnect(); assert.deepEqual(await f.as(() => f.facade.runtimeLifecycle!(input, f.ticket.hostId)), first); assert.equal(creates, 1);
  });
  test(`${kind}: fixed grant cannot create via lifecycle`, async t => {
    const f = await runtimePeerFixture(t, kind, { fixed: true }); await f.bind(); let creates = 0;
    f.runtime.create = async () => { creates++; return resource(); };
    await assert.rejects(f.as(() => f.facade.runtimeLifecycle!({ ...launch(), assertCurrent: noop }, f.ticket.hostId)), /固定|scope/); assert.equal(creates, 0);
  });
  test(`${kind}: write callback revocation prevents lifecycle creation`, async t => {
    const f = await runtimePeerFixture(t, kind); await f.bind(); let creates = 0, checks = 0;
    f.runtime.create = async i => { await i.prepareWrite?.(); i.assertCurrent(); creates++; return resource(); };
    const record = await f.as(() => f.facade.runtimeLifecycle!({ ...launch(), assertCurrent() { if (++checks > 1) throw Error("revoked"); } }, f.ticket.hostId));
    assert.equal(record.phase, "not-sent"); assert.equal(creates, 0);
  });
}
