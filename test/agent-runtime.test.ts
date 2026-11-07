import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonLineClient, type RuntimeRpc, type RuntimeRequestOptions } from "../src/agents/json-line-client.js";
import { HerdrTuiAdapter } from "../src/agents/herdr/tui.js";
import { HerdrAppAdapter } from "../src/agents/herdr/app.js";
import { RuntimeError, terminalOperations } from "../src/agents/contracts.js";
import { createHerdrRuntime, herdrRuntimeConfigSchema, runtimeEndpointId } from "../src/agents/config.js";

class Rpc implements RuntimeRpc {
  calls: Array<{ method: string; params: any; write: boolean }> = [];
  closed = false;
  constructor(public answer: (method: string, params: any) => unknown) {}
  async request(method: string, params: any = {}, options: RuntimeRequestOptions = {}) {
    await options.prepareWrite?.();
    options.beforeWrite?.();
    this.calls.push({ method, params, write: options.write === true }); return this.answer(method, params);
  }
  close() { this.closed = true; }
}
const agent = () => ({ terminal_id: "terminal-uuid", pane_id: "w1:t1:p1", workspace_id: "workspace-uuid", name: "same-name",
  agent: "codex", agent_status: "idle", state_change_seq: 3, cwd: "/tmp/project", agent_session: { source: "hook", agent: "codex", kind: "id", value: "session1" } });
const terminal = () => ({ address: "t1", name: "same-name", cwd: "/tmp/project", state: "live", pid: 123,
  foreground: { pid: 456, name: "node", argv: ["node", "agent"], cwd: "/tmp/project" }, created_ms: 1234,
  turn: 4, status: { state: "idle", app: "fixture" }, screen: "exact" });
function tuiFixture() {
  const a = agent(); let pane = a;
  const rpc = new Rpc((method, params) => {
    if (method === "ping") return { type: "pong", version: "0.9.5", protocol: 22 };
    if (method === "session.snapshot") return { type: "session_snapshot", snapshot: { version: "0.9.5",
      workspaces: [{ workspace_id: "workspace-uuid", label: "Project" }, { workspace_id: "empty", label: "Empty" }], agents: [a] } };
    if (method === "agent.get") { assert.equal(params.target, a.pane_id); return { type: "agent_info", agent: pane }; }
    if (method === "agent.prompt") return { type: "agent_prompted", agent: pane };
    if (method === "agent.read") return { type: "pane_read", read: { text: "terminal text", truncated: true, pane_id: a.pane_id } };
    throw Error(method);
  });
  return { a, rpc, adapter: new HerdrTuiAdapter("tui", rpc), replace: () => { pane = { ...a, terminal_id: "replacement" }; } };
}
function appFixture() {
  const t = terminal(); let started: boolean | null = true;
  const rpc = new Rpc(method => {
    if (method === "hello") return { generation: 1, version: "0.1.18", core: { id: "core1" },
      methods: ["terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt"] };
    if (method === "doc.get") return { version: 1, value: { spaces: [{ id: "s1", name: "Project", folder: "/tmp/project",
      tabs: [{ root: { type: "block", content: { terminal: "t1" } } }] }, { id: "s2", name: "Empty", folder: "", tabs: [] }] } };
    if (method === "terminal.list") return { terminals: [t], machines: [] };
    if (method === "terminal.get") return t;
    if (method === "terminal.read") return { text: "```codex-im-gateway-actions\n{\"send\":[]}\n```", complete: false, how: "screen" };
    if (method === "terminal.send") return { turn: 4, started, status: "idle" };
    if (method === "terminal.interrupt") return { outcome: "still_working", key: "esc" };
    throw Error(method);
  });
  const view = { list: async () => ({ spaces: [{ id: "s1", name: "Project", folder: "/tmp/project", machine: null,
    tabs: [{ terminals: [{ terminal: "t1" }] }] }, { id: "s2", name: "Empty", folder: "", machine: null, tabs: [] }] }) };
  return { t, rpc, view, adapter: new HerdrAppAdapter("app", rpc, view, "core1"), started: (value: boolean | null) => { started = value; } };
}

test("App accepts a subsequent input after reported done without forcing a blocked terminal", async () => {
  const f = appFixture();
  await f.adapter.send({ target: (await f.adapter.catalog()).resources[0], text: "first", assertCurrent() {} });
  f.t.status.state = "done";
  await f.adapter.send({ target: (await f.adapter.catalog()).resources[0], text: "second", assertCurrent() {} });
  const writes = f.rpc.calls.filter(c => c.method === "terminal.send");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].params, { terminal: "t1", text: "first", force: false, if: "idle", wait: false });
  // Core only exposes idle/working in only_if. Done must not be rewritten to
  // idle, and accepting another turn must never turn on force.
  assert.deepEqual(writes[1].params, { terminal: "t1", text: "second", force: false, wait: false });
});
for (const next of ["working", "blocked", "unknown", "error"]) {
  test(`App done input refuses a ${next} transition at the last write boundary`, async () => {
    const f = appFixture(); f.t.status.state = "done";
    const target = (await f.adapter.catalog()).resources[0];
    let prepared = false;
    await assert.rejects(f.adapter.send({ target, text: "must not type", assertCurrent() {},
      prepareWrite: async () => { prepared = true; f.t.status.state = next; } }), { code: "not-ready" });
    assert.equal(prepared, true);
    assert.equal(f.rpc.calls.some(call => call.write), false);
  });
}

for (const afterState of ["working", "idle", "blocked"] as const) test(`TUI configured interrupt observes ${afterState} without claiming key delivery is completion`, async () => {
  const f = tuiFixture(); f.a.agent_status = "working";
  const adapter = new HerdrTuiAdapter("tui", f.rpc, { codex: "esc" }), original = f.rpc.answer;
  f.rpc.answer = (method, params) => {
    if (method === "pane.send_keys") { assert.deepEqual(params, { pane_id: f.a.pane_id, keys: ["esc"] }); f.a.agent_status = afterState; return { type: "ok" }; }
    return original(method, params);
  };
  assert.equal((await adapter.describe()).operations.interrupt.supported, true);
  const target = await adapter.inspect({ endpointId: "tui", id: f.a.terminal_id });
  const result = await adapter.interrupt({ target, assertCurrent() {} });
  assert.equal(result.kind, "interrupt-requested");
  assert.equal(result.observation, afterState === "idle" ? "stopped" : afterState === "working" ? "still_working" : "unknown");
  assert.equal(f.rpc.calls.filter(c => c.write).length, 1);
});
for (const fault of ["missing-config", "blocked", "moved", "revoked", "lost-observation", "bad-receipt"]) test(`TUI interrupt ${fault} retains exact target and delivery semantics`, async () => {
  const f = tuiFixture(); f.a.agent_status = fault === "blocked" ? "blocked" : "working";
  const adapter = new HerdrTuiAdapter("tui", f.rpc, fault === "missing-config" ? {} : { codex: "ctrl+c" });
  const target = await adapter.inspect({ endpointId: "tui", id: f.a.terminal_id }), original = f.rpc.answer;
  let written = false;
  f.rpc.answer = (method, params) => {
    if (written && fault === "lost-observation") throw Error("offline");
    if (method === "pane.send_keys") { written = true; return fault === "bad-receipt" ? {} : { type: "ok" }; }
    return original(method, params);
  };
  const action = () => adapter.interrupt({ target, assertCurrent() { if (fault === "revoked") throw Error("revoked"); },
    async prepareWrite() { if (fault === "moved") f.a.pane_id = "another-pane"; } });
  if (fault === "lost-observation") assert.equal((await action()).observation, "unknown");
  else if (fault === "bad-receipt") await assert.rejects(action, { submission: "unknown" });
  else await assert.rejects(action);
  assert.equal(f.rpc.calls.filter(c => c.write).length, ["lost-observation", "bad-receipt"].includes(fault) ? 1 : 0);
});
test("TUI interrupt configuration is strict, ordered and part of endpoint authority", () => {
  const base = { version: 1, kind: "herdr-tui", id: "tui", socketPath: "/tmp/tui.sock" };
  const original = runtimeEndpointId(herdrRuntimeConfigSchema.parse(base));
  assert.equal(runtimeEndpointId(herdrRuntimeConfigSchema.parse({ ...base, interruptKeys: {} })), original);
  const configured = (interruptKeys: object) => runtimeEndpointId(herdrRuntimeConfigSchema.parse({ ...base, interruptKeys }));
  assert.notEqual(configured({ codex: "esc" }), original);
  assert.equal(configured({ codex: "esc", claude: "ctrl+c" }), configured({ claude: "ctrl+c", codex: "esc" }));
  for (const interruptKeys of [{ "*": "esc" }, { codex: "yes" }, { codex: ["ctrl+c", "ctrl+c"] }])
    assert.equal(herdrRuntimeConfigSchema.safeParse({ ...base, interruptKeys }).success, false);
});

test("terminal capabilities never advertise native approvals, steering or queue", () => {
  const caps = terminalOperations();
  for (const name of ["interaction", "native-steer", "native-queue", "models", "settings", "goal", "structured-output"] as const)
    assert.equal(caps[name].supported, false);
});
test("TUI rejects pane movement during asynchronous source authorization before prompt write", async () => {
  const f = tuiFixture(), target = await f.adapter.inspect({ endpointId: "tui", id: f.a.terminal_id });
  await assert.rejects(f.adapter.send({ target, text: "hello", assertCurrent() {}, prepareWrite: async () => { f.a.pane_id = "new-pane"; } }), { code: "changed" });
  assert.equal(f.rpc.calls.filter(c => c.write).length, 0);
});
test("App rejects a replacement foreground process after asynchronous source authorization", async () => {
  const f = appFixture(), target = await f.adapter.inspect({ endpointId: "app", id: "t1" });
  await assert.rejects(f.adapter.send({ target, text: "hello", assertCurrent() {}, prepareWrite: async () => { f.t.foreground.pid++; } }), { code: "changed" });
  assert.equal(f.rpc.calls.filter(c => c.write).length, 0);
});
test("App rejects interrupt when authorization wait outlives the running task", async () => {
  const f = appFixture(); f.t.status.state = "working";
  const target = await f.adapter.inspect({ endpointId: "app", id: "t1" });
  await assert.rejects(f.adapter.interrupt({ target, assertCurrent() {}, prepareWrite: async () => { f.t.status.state = "idle"; } }), { code: "not-ready" });
  assert.equal(f.rpc.calls.filter(c => c.write).length, 0);
});
test("TUI preserves empty workspaces and identifies public JSON separately from private protocol 22", async () => {
  const { adapter } = tuiFixture(); assert.equal((await adapter.describe()).protocol.generation, undefined);
  const catalog = await adapter.catalog(); assert.equal(catalog.projects.length, 2); assert.deepEqual(catalog.projects[1].roots, []);
  assert.equal(catalog.resources[0].ref.id, "terminal-uuid");
});
test("TUI resolves stable terminal to its current pane instead of sending name or terminal id", async () => {
  const { adapter, rpc } = tuiFixture(), target = (await adapter.catalog()).resources[0];
  let guarded = 0;
  const receipt = await adapter.send({ target, text: "hello", assertCurrent: () => { guarded++; } });
  assert.equal(receipt.kind, "terminal-written"); assert.equal("turnId" in receipt, false); assert.equal(guarded, 1);
  assert.deepEqual(rpc.calls.filter(c => c.write), [{ method: "agent.prompt", params: { target: "w1:t1:p1", text: "hello" }, write: true }]);
});
test("TUI pane replacement refuses the write", async () => {
  const { adapter, rpc, replace } = tuiFixture(), target = (await adapter.catalog()).resources[0]; replace();
  await assert.rejects(adapter.send({ target, text: "hello", assertCurrent() {} }), { code: "changed", submission: "not-sent" });
  assert.equal(rpc.calls.some(c => c.write), false);
});
for (const state of ["blocked", "working", "unknown"]) test(`TUI ${state} refuses ordinary input without send_keys fallback`, async () => {
  const { adapter, a, rpc } = tuiFixture(), target = (await adapter.catalog()).resources[0]; a.agent_status = state;
  await assert.rejects(adapter.send({ target, text: "yes", assertCurrent() {} }), { code: "not-ready" });
  assert.equal(rpc.calls.some(c => c.write), false);
});
test("TUI source revocation before write propagates without submitting", async () => {
  const { adapter, rpc } = tuiFixture(), target = (await adapter.catalog()).resources[0];
  await assert.rejects(adapter.send({ target, text: "hello", assertCurrent() { throw Error("revoked"); } }), /revoked/);
  assert.equal(rpc.calls.some(c => c.write), false);
});
test("TUI reads visible screen, preserves truncation, never claims transcript", async () => {
  const { adapter, rpc } = tuiFixture(), ref = (await adapter.catalog()).resources[0].ref;
  const output = await adapter.read(ref); assert.equal(output.kind, "terminal-screen"); assert.equal(output.complete, false);
  assert.equal(rpc.calls.find(c => c.method === "agent.read")?.params.source, "visible");
});
test("TUI ambiguous prompt error never triggers a second write", async () => {
  const { adapter, rpc } = tuiFixture(), target = (await adapter.catalog()).resources[0], original = rpc.answer;
  rpc.answer = (m, p) => { if (m === "agent.prompt") throw new RuntimeError("transport", "lost", "unknown"); return original(m, p); };
  await assert.rejects(adapter.send({ target, text: "hello", assertCurrent() {} }), { submission: "unknown" });
  assert.equal(rpc.calls.filter(c => c.write).length, 1);
});
test("App catalogs match terminal ids to spaces and retain empty spaces", async () => {
  const { adapter } = appFixture(), catalog = await adapter.catalog();
  assert.equal(catalog.resources[0].projectId, "s1"); assert.equal(catalog.projects.length, 2); assert.equal(catalog.complete, true);
});
for (const sameId of [true, false]) test(`App catalog does not assign a terminal from ambiguous ${sameId ? "duplicated" : "distinct"} spaces`, async () => {
  const f = appFixture(), layout = await f.view.list(), original = f.rpc.answer;
  const second = { ...layout.spaces[0], id: sameId ? "s1" : "s3" };
  f.view.list = async () => ({ spaces: [layout.spaces[0], second, layout.spaces[1]] });
  if (!sameId) f.rpc.answer = (method, params) => {
    const value = original(method, params);
    if (method === "doc.get") return { ...value, value: { spaces: [...value.value.spaces, { ...value.value.spaces[0], id: "s3" }] } };
    return value;
  };
  const catalog = await f.adapter.catalog();
  assert.equal(catalog.complete, false); assert.equal(catalog.resources[0].projectId, undefined);
  assert.ok(catalog.warnings.some(w => /多个空间/.test(w)));
  await assert.rejects(f.adapter.inspect(catalog.resources[0].ref), /多个空间/);
});
test("App resource inspection preserves project membership used by binding and IDE", async () => {
  const { adapter } = appFixture();
  const listed = (await adapter.catalog()).resources[0], inspected = await adapter.inspect(listed.ref);
  assert.equal(inspected.projectId, listed.projectId); assert.equal(inspected.projectId, "s1");
});
test("App inspection refuses ambiguous space ownership and mismatched machines", async () => {
  const { adapter, view } = appFixture(), ref = (await adapter.catalog()).resources[0].ref;
  const original = view.list, layout = await original();
  view.list = async () => ({ spaces: [layout.spaces[0], layout.spaces[0]] });
  await assert.rejects(adapter.inspect(ref), /多个空间/);
  view.list = async () => ({ spaces: [{ ...layout.spaces[0], machine: "remote" as any }] });
  assert.equal((await adapter.inspect(ref)).projectId, undefined); // mismatched unverified layout grants no membership
});
test("App refuses a different core and never falls back", async () => {
  const { rpc, view } = appFixture();
  const adapter = new HerdrAppAdapter("app", rpc, view, "another-core");
  await assert.rejects(adapter.catalog(), { code: "changed" }); assert.equal(rpc.calls.some(c => c.method === "terminal.list"), false);
});
test("App detects an unsupported hello generation before any resource operation", async () => {
  const rpc = new Rpc(() => ({ generation: 2, version: "1", core: { id: "core1" }, methods: [] }));
  const adapter = new HerdrAppAdapter("app", rpc, { list: async () => ({ spaces: [] }) }, "core1");
  await assert.rejects(adapter.catalog(), { code: "incompatible" }); assert.equal(rpc.calls.length, 1);
});
for (const started of [false, null, true]) test(`App send started=${started} remains terminal-written without native turn`, async () => {
  const f = appFixture(); f.started(started); const target = (await f.adapter.catalog()).resources[0];
  const receipt = await f.adapter.send({ target, text: "hello", assertCurrent() {} });
  assert.equal(receipt.kind, "terminal-written"); assert.equal("turnId" in receipt, false);
  assert.deepEqual(f.rpc.calls.find(c => c.method === "terminal.send")?.params,
    { terminal: "t1", text: "hello", force: false, if: "idle", wait: false });
  assert.equal(f.rpc.calls.filter(c => c.write).length, 1);
});
test("App kept terminal replaced by another foreground cannot receive old input", async () => {
  const { adapter, t, rpc } = appFixture(), target = (await adapter.catalog()).resources[0]; t.foreground.pid++;
  await assert.rejects(adapter.send({ target, text: "hello", assertCurrent() {} }), { code: "changed" });
  assert.equal(rpc.calls.some(c => c.write), false);
});
test("App terminal without program identity cannot receive ordinary input", async () => {
  const { adapter, t, rpc } = appFixture(); (t as any).foreground = null;
  const target = (await adapter.catalog()).resources[0];
  await assert.rejects(adapter.send({ target, text: "hello", assertCurrent() {} }), { code: "changed" });
  assert.equal(rpc.calls.some(c => c.write), false);
});
test("App read never scrolls the program or interprets terminal action blocks", async () => {
  const { adapter, rpc } = appFixture(), ref = (await adapter.catalog()).resources[0].ref;
  const output = await adapter.read(ref); assert.equal(output.complete, false); assert.match(output.text, /codex-im-gateway-actions/);
  assert.equal(output.kind, "terminal-screen"); assert.deepEqual(rpc.calls.find(c => c.method === "terminal.read")?.params, { terminal: "t1", lines: 0 });
});
test("App still-working interrupt reports requested rather than interrupted", async () => {
  const { adapter, t } = appFixture(); t.status.state = "working"; const target = (await adapter.catalog()).resources[0];
  const result = await adapter.interrupt({ target, assertCurrent() {} });
  assert.equal(result.kind, "interrupt-requested"); assert.equal(result.observation, "still_working");
});
test("App remote terminal keeps its actual machine identity", async () => {
  const { adapter, t } = appFixture(); t.address = "linux/t1";
  const result = await adapter.catalog(); assert.equal(result.resources[0].machine, "linux"); assert.equal(result.complete, false);
});
test("App window offline fails catalog rather than returning a substitute empty directory", async () => {
  const { rpc } = appFixture(); const adapter = new HerdrAppAdapter("app", rpc, { list: async () => { throw Error("offline"); } }, "core1");
  await assert.rejects(adapter.catalog(), /offline/);
});
test("closing adapters only disconnects their own clients", () => {
  for (const f of [appFixture(), tuiFixture()]) { f.adapter.close(); assert.equal(f.rpc.closed, true); assert.equal(f.rpc.calls.some(c => c.write), false); }
});

async function socketFixture(t: any, respond: (s: net.Socket, v: any) => void, timeoutMs = 200, dialect: "json-rpc" | "herdr-tui" = "json-rpc",
  extra: Partial<ConstructorParameters<typeof JsonLineClient>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abrpc-")); const socketPath = path.join(dir, "s");
  const sockets = new Set<net.Socket>();
  const server = net.createServer(s => { sockets.add(s); let text = "";
    s.on("data", b => { text += b.toString(); let n; while ((n = text.indexOf("\n")) >= 0) {
      const v = JSON.parse(text.slice(0, n)); text = text.slice(n + 1); respond(s, v);
    } }); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const rpc = new JsonLineClient({ ...extra, socketPath, dialect, timeoutMs });
  t.after(async () => { rpc.close(); for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(dir, { recursive: true, force: true }); });
  return rpc;
}
test("JSONL correlates out-of-order responses and buffers split UTF-8 frames", async t => {
  const requests: any[] = [];
  const rpc = await socketFixture(t, (s, v) => { requests.push(v); if (requests.length === 2) {
    const wire = Buffer.from(requests.reverse().map(v => JSON.stringify({ jsonrpc: "2.0", id: v.id, result: v.method + "你好" })).join("\n") + "\n");
    const split = wire.indexOf(Buffer.from("你")) + 1; s.write(wire.subarray(0, split)); s.write(wire.subarray(split));
  } });
  assert.deepEqual(await Promise.all([rpc.request("a"), rpc.request("b")]), ["a你好", "b你好"]);
});
test("JSONL lost write acknowledgement is unknown and never replayed", async t => {
  let count = 0; const rpc = await socketFixture(t, s => { count++; s.destroy(); });
  await assert.rejects(rpc.request("send", {}, { write: true }), { submission: "unknown" }); assert.equal(count, 1);
});
test("JSONL write timeout is unknown, read timeout is not a submitted task", async t => {
  const rpc = await socketFixture(t, () => {}, 30);
  await assert.rejects(rpc.request("send", {}, { write: true }), { submission: "unknown" });
  await assert.rejects(rpc.request("get"), { submission: "not-sent" });
});
test("JSONL malformed response fails pending writes without retry", async t => {
  const rpc = await socketFixture(t, s => s.write("invalid json\n"));
  await assert.rejects(rpc.request("send", {}, { write: true }), { submission: "unknown" });
});
test("JSONL wrong id cannot acknowledge a write", async t => {
  const rpc = await socketFixture(t, s => s.write('{"jsonrpc":"2.0","id":"wrong","result":{}}\n'), 30);
  await assert.rejects(rpc.request("send", {}, { write: true }), { submission: "unknown" });
});
test("TUI JSONL uses a new connection per request even before the preceding socket close event", async t => {
  let count = 0;
  const rpc = await socketFixture(t, (s, v) => { count++; assert.equal(v.jsonrpc, undefined);
    s.end(JSON.stringify({ id: v.id, result: v.method }) + "\n"); }, 200, "herdr-tui");
  assert.equal(await rpc.request("ping"), "ping"); assert.equal(await rpc.request("session.snapshot"), "session.snapshot");
  assert.equal(count, 2);
});

test("App unknown program identity can be read but gaining an identity mid-read discards the screen", async () => {
  const f = appFixture(), foreground = f.t.foreground; (f.t as any).foreground = null;
  assert.equal((await f.adapter.read({ endpointId: "app", id: "t1" })).kind, "terminal-screen");
  const original = f.rpc.answer;
  f.rpc.answer = (m, p) => { const answer = original(m, p); if (m === "terminal.read") f.t.foreground = foreground; return answer; };
  await assert.rejects(f.adapter.read({ endpointId: "app", id: "t1" }), { code: "changed" });
});
test("TUI unknown program identity remains readable without enabling writes", async () => {
  const f = tuiFixture(); (f.a as any).agent = null; f.a.agent_status = "unknown";
  const ref = (await f.adapter.catalog()).resources[0].ref;
  assert.equal((await f.adapter.read(ref)).kind, "terminal-screen");
  const target = await f.adapter.inspect(ref);
  await assert.rejects(f.adapter.send({ target, text: "no", assertCurrent() {} }), { code: "changed" });
});
test("TUI discards a response naming another pane even when original terminal is still present", async () => {
  const f = tuiFixture(), original = f.rpc.answer;
  f.rpc.answer = (m, p) => m === "agent.read" ? { type: "pane_read", read: { text: "wrong", truncated: false, pane_id: "w9:p1" } } : original(m, p);
  await assert.rejects(f.adapter.read({ endpointId: "tui", id: "terminal-uuid" }), { code: "changed" });
});
test("App checks source after last readiness await, including interrupt writes", async () => {
  const f = appFixture(); const target = (await f.adapter.catalog()).resources[0], original = f.rpc.answer;
  let revoked = false;
  f.rpc.answer = (m, p) => { if (m === "terminal.get") revoked = true; return original(m, p); };
  const assertCurrent = () => { assert.equal(revoked, true); throw Error("revoked during await"); };
  await assert.rejects(f.adapter.send({ target, text: "no", assertCurrent }), /revoked during await/);
  f.t.status.state = "working";
  await assert.rejects(f.adapter.interrupt({ target, assertCurrent }), /revoked during await/);
  assert.equal(f.rpc.calls.some(c => c.write), false);
});
test("JSONL source revocation while connecting prevents any bytes, without claiming ambiguous delivery", async t => {
  let requests = 0, allowed = true;
  const rpc = await socketFixture(t, () => { requests++; });
  const result = rpc.request("send", {}, { write: true, beforeWrite() { if (!allowed) throw new RuntimeError("scope", "revoked"); } });
  allowed = false;
  await assert.rejects(result, { code: "scope", submission: "not-sent" }); assert.equal(requests, 0);
});
test("JSONL async final guard cannot authorize a write", async t => {
  let requests = 0; const rpc = await socketFixture(t, () => { requests++; });
  await assert.rejects(rpc.request("send", {}, { write: true, beforeWrite: async () => {} }), { code: "not-ready", submission: "not-sent" });
  assert.equal(requests, 0);
});
test("JSONL remote error body is absent from returned Error and cause", async t => {
  const rpc = await socketFixture(t, (s, v) => s.write(JSON.stringify({ jsonrpc: "2.0", id: v.id,
    error: { code: 42, message: "sensitive-provider-body" } }) + "\n"));
  await assert.rejects(rpc.request("send", {}, { write: true }), (error: any) => {
    assert.equal(error.submission, "unknown"); assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error), /sensitive-provider-body/); return true;
  });
});
test("JSONL invalid UTF-8 is rejected instead of returning replacement characters", async t => {
  const rpc = await socketFixture(t, (s, v) => s.write(Buffer.concat([
    Buffer.from(`{"jsonrpc":"2.0","id":"${v.id}","result":"`), Buffer.from([0xff]), Buffer.from('"}\n')])));
  await assert.rejects(rpc.request("read"), { code: "transport" });
});
test("JSONL notification observer failure cannot consume matching response", async t => {
  const rpc = await socketFixture(t, (s, v) => s.write(JSON.stringify({ method: "event", params: {} }) + "\n"
    + JSON.stringify({ jsonrpc: "2.0", id: v.id, result: "ok" }) + "\n"), 200, "json-rpc", { notification() { throw Error("observer failed"); } });
  assert.equal(await rpc.request("get"), "ok");
});
test("runtime configuration rejects fallback, implicit paths, unknown kinds and unsupported versions", () => {
  const config = { version: 1, id: "test", kind: "herdr-tui", socketPath: "/tmp/herdr.sock" };
  for (const invalid of [{ ...config, fallback: "codex" }, { ...config, socketPath: "~/herdr.sock" },
    { ...config, kind: "herdr-core" }, { ...config, version: 2 }]) assert.equal(herdrRuntimeConfigSchema.safeParse(invalid).success, false);
  const adapter = createHerdrRuntime(config); adapter.close(); // Construction makes no connection.
});
test("runtime endpoint identity changes with configured service and ignores input property order", () => {
  const config = herdrRuntimeConfigSchema.parse({ version: 1, id: "test", kind: "herdr-tui", socketPath: "/tmp/a" });
  assert.notEqual(runtimeEndpointId(config), runtimeEndpointId({ ...config, socketPath: "/tmp/b" }));
  const reversed = herdrRuntimeConfigSchema.parse({ socketPath: "/tmp/a", kind: "herdr-tui", id: "test", version: 1 });
  assert.equal(runtimeEndpointId(config), runtimeEndpointId(reversed));
  const app = herdrRuntimeConfigSchema.parse({ version: 1, id: "app", kind: "herdr-app", coreSocketPath: "/tmp/core", windowSocketPath: "/tmp/window", expectedCoreId: "core1" });
  assert.notEqual(runtimeEndpointId(app), runtimeEndpointId({ ...app, expectedCoreId: "core2" } as any));
});
test("JSONL oversized partial frame fails pending write without unbounded buffering", async t => {
  const rpc = await socketFixture(t, s => s.write("x".repeat(256)), 200, "json-rpc", { maxFrameBytes: 128 });
  await assert.rejects(rpc.request("send", {}, { write: true }), { submission: "unknown" });
});
test("JSONL oversized request is rejected before any socket request", async t => {
  let calls = 0;
  const rpc = await socketFixture(t, () => { calls++; }, 200, "json-rpc", { maxFrameBytes: 128 });
  await assert.rejects(rpc.request("send", { text: "x".repeat(256) }, { write: true }), { submission: "not-sent" }); assert.equal(calls, 0);
});
test("JSONL close ends an outstanding write as unknown and disallows future calls", async t => {
  let received!: () => void; const seen = new Promise<void>(r => { received = r; });
  const rpc = await socketFixture(t, () => received());
  const pending = rpc.request("send", {}, { write: true }); const rejected = assert.rejects(pending, { submission: "unknown" });
  await seen; rpc.close(); await rejected;
  await assert.rejects(rpc.request("send", {}, { write: true }), { submission: "not-sent" });
});
test("JSONL unavailable configured endpoint is not-sent and never starts another server", async () => {
  const rpc = new JsonLineClient({ socketPath: path.join(os.tmpdir(), `absent-${process.pid}-${Date.now()}.sock`), dialect: "json-rpc" });
  try { await assert.rejects(rpc.request("send", {}, { write: true }), { submission: "not-sent" }); } finally { rpc.close(); }
});
test("JSONL guard closing its owner cannot enqueue a write after final authorization", async t => {
  let requests = 0; const rpc = await socketFixture(t, () => { requests++; });
  await assert.rejects(rpc.request("send", {}, { write: true, beforeWrite: () => rpc.close() }), { submission: "not-sent" });
  assert.equal(requests, 0);
});
