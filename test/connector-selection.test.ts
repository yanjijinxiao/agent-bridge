import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ConnectorSelection } from "../src/bridge/connector-selection.js";
import { BridgeService } from "../src/bridge/service.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { APP_SERVER_BACKEND_CAPABILITIES, type CodexBridgeBackend, type CodexRunnerInput, type CodexThreadState } from "../src/codex/backend.js";
import { peerPrincipal, type PeerBridgePort, type PeerPrincipal } from "../src/peer/context.js";
import { parseChannelActionValue, type ChannelActionCard } from "../src/channels/action-card.js";

const A = "peer:machine-a:work", B = "peer:machine-b:work";
const who = (actorId = "alice", conversationId = "room", accountId = "bot"): PeerPrincipal => ({ accountId, conversationId, actorId });
const key = (p: PeerPrincipal) => JSON.stringify([p.accountId, p.conversationId, p.actorId]);
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-connector-choice-"));
  const paths = resolveStatePaths(root);
  let store = new RuntimeStateStore(paths);
  const grants = new Map([[key(who()), [A, B]]]), offline = new Set<string>();
  let pairCalls = 0;
  const peer: PeerBridgePort = {
    hosts(p) { return [...grants.get(key(p)) ?? []]; },
    label(host) { return host === "local" ? "Gateway 本地" : "同名电脑"; },
    isOnline(host) { return !offline.has(host); },
    async connect(_code, p, guard) { guard(); pairCalls++; grants.set(key(p), [A]); return { hostId: A, label: "同名电脑" }; }
  };
  const reads: string[] = [], projectReads: string[] = [], runs: CodexRunnerInput[] = [], creates: { host: string; input: any }[] = [], stops: string[] = [];
  const texts: string[] = [], cards: ChannelActionCard[] = [];
  const threads = new Map<string, CodexThreadState[]>(["local", A, B].map(host => [host,
    Array.from({ length: 7 }, (_, i) => ({ threadId: `${host}-thread-${i}`, title: `${host}-task-${i}`, cwd: path.join(root, host.replaceAll(":", "_")),
      projectId: "project", projectMembership: "assigned" as const, persistence: "active" as const, runtimeStatus: "idle" as const, activeFlags: [] }))]));
  let waitCatalog: ((host: string) => Promise<void>) | undefined;
  let waitProjects: ((host: string) => Promise<void>) | undefined;
  let waitCreate: (() => Promise<void>) | undefined;
  let waitInspect: (() => Promise<void>) | undefined;
  const authorized = (host: string) => { if (host.startsWith("peer:")) assert.ok(peer.hosts(peerPrincipal.getStore()!).includes(host), "backend must never receive an unauthorized host"); };
  const runner: CodexBridgeBackend = {
    backendInfo: () => ({ id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
    async listSessionCatalog(_input, host = "local") { authorized(host); reads.push(host); await waitCatalog?.(host);
      return { backend: "app-server", source: "app-server-storage", threads: threads.get(host)!, hostIds: [host], warnings: [], complete: true }; },
    async listProjects(host = "local") { authorized(host); projectReads.push(host); await waitProjects?.(host);
      return { backend: "app-server", projects: [{ id: "project", name: `${host}-project`, roots: [threads.get(host)![0].cwd!] }, { id: "empty", name: `${host}-empty`, roots: [root] }] }; },
    async inspectThread(id, host = "local") { authorized(host); await waitInspect?.(); return threads.get(host)!.find(t => t.threadId === id)!; },
    async getHistory() { return []; },
    async getRuntimeInfo() { return {}; },
    async run(input) { input.assertCurrent?.(); runs.push(input); return { threadId: input.threadId, turnId: "turn", text: "done", raw: "" }; },
    async stop(id) { stops.push(id); return { stopped: true, threadId: id }; },
    async createThread(input, host = "local") { authorized(host); await waitCreate?.(); input.assertCurrent?.(); creates.push({ host, input });
      const state = { ...threads.get(host)![0], threadId: crypto.randomUUID(), cwd: input.cwd ?? root, projectId: input.projectId, title: "new" };
      threads.get(host)!.push(state); return state; }
  } as CodexBridgeBackend;
  const services: BridgeService[] = [];
  const build = (accountId = "bot", resourceOnly = false) => { const bridge = new BridgeService({ accountId, peer, stateStore: store, runner,
    listCodexProjects: () => [{ projectId: "project", name: "local-project", workspace: root, hostId: "local", sessionCount: 7, lastUsedAt: "" }],
    config: { ...defaultConfig(root), allowedSenderIds: resourceOnly ? [] : ["room", "room2"], codexBackend: "app-server", streamReplies: false },
    weixin: { async sendText(x) { texts.push(x.text); return { messageId: crypto.randomUUID() }; },
      async sendActionCard(x) { cards.push(x.card); return { messageId: crypto.randomUUID() }; } } }); services.push(bridge); return bridge; };
  let bridge = build();
  const send = (text: string, p = who(), card = false, service = bridge) => service.handleMessage({ id: crypto.randomUUID(), senderId: p.actorId, replyTargetId: p.conversationId,
    text, attachments: [], raw: {}, ...(card ? { interaction: { kind: "card" as const, messageId: "device-card" } } : {}) });
  t.after(() => { for (const s of services) s.suspendUserInputs(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, get store() { return store; }, peer, grants, offline, reads, projectReads, runs, creates, stops, texts, cards, threads, send, build,
    get pairCalls() { return pairCalls; },
    set waitCatalog(value: typeof waitCatalog) { waitCatalog = value; },
    set waitProjects(value: typeof waitProjects) { waitProjects = value; },
    set waitCreate(value: typeof waitCreate) { waitCreate = value; },
    set waitInspect(value: typeof waitInspect) { waitInspect = value; },
    restart() { bridge.suspendUserInputs(); store = new RuntimeStateStore(paths); bridge = build(); } };
}

async function choose(f: ReturnType<typeof fixture>, code: string, p = who()) { await f.send("/connect", p); await f.send(`/connect use ${code}`, p); }

test("Connector selection persists separately from binding and all ordinary input keeps its original host", async t => {
  const f = fixture(t);
  await f.send(`/session ${A}-thread-0 --host ${A}`);
  const bound = f.store.getBoundSession("room")!;
  await f.send("/sessions"); assert.match(f.texts.at(-1)!, /多个.*Connector/); assert.deepEqual(f.reads, []);
  await choose(f, "C2");
  assert.equal(f.store.getConnectorSelection(who())?.hostId, B);
  assert.equal(f.pairCalls, 0); assert.equal(f.store.getBoundSession("room")?.id, bound.id);
  await f.send("/sessions"); assert.deepEqual(f.reads, [B]);
  assert.match(f.cards.at(-1)!.body, /machine-b.*empty/); assert.doesNotMatch(f.cards.at(-1)!.body, /machine-a/);
  await f.send("继续原任务"); assert.equal(f.runs.at(-1)?.hostId, A); assert.deepEqual(f.stops, []);
  f.restart(); await f.send("/sessions"); assert.equal(f.reads.at(-1), B);
  assert.equal(f.store.getBoundSession("room")?.id, bound.id);
  await f.send("/session R1"); assert.equal(f.store.getBoundSession("room")?.hostId, B);
});

test("Connector first use auto-selects the sole grant and explicit pairing records its catalog without extra approval", async t => {
  const f = fixture(t);
  f.grants.set(key(who()), [A]); await f.send("/sessions");
  assert.equal(f.store.getConnectorSelection(who())?.hostId, A);
  f.grants.set(key(who()), [A, B]); await f.send("/sessions"); assert.deepEqual(f.reads, [A, A]);
  f.grants.set(key(who("bob")), []); await f.send("/connect", who("bob")); assert.match(f.cards.at(-1)!.body, /尚未配对/);
  await f.send("/connect ABCDEF-123456", who("bob")); assert.equal(f.pairCalls, 1);
  assert.equal(f.store.getConnectorSelection(who("bob"))?.hostId, A); assert.equal(f.reads.at(-1), A);
  assert.equal(f.store.getBoundSession("room"), undefined);
});

test("Connector temporary host, all, search and pagination preserve the saved default", async t => {
  const f = fixture(t); await choose(f, "C2");
  await f.send(`/sessions --host ${A}`); assert.equal(f.reads.at(-1), A);
  await f.send("/sessions size 5"); const count = f.reads.length;
  await f.send("/sessions more"); assert.equal(f.reads.length, count); assert.match(f.cards.at(-1)!.body, /machine-a/);
  await f.send("/sessions"); assert.equal(f.reads.at(-1), B);
  await f.send("/sessions search task-3"); assert.match(f.cards.at(-1)!.body, /machine-b:work-task-3/); assert.doesNotMatch(f.cards.at(-1)!.body, /machine-a/);
  const start = f.reads.length; await f.send("/sessions all"); assert.deepEqual(new Set(f.reads.slice(start)), new Set(["local", A, B]));
  assert.equal(f.store.getConnectorSelection(who())?.hostId, B);
  await f.send("/sessions"); assert.equal(f.reads.at(-1), B);
  await f.send("/connect use local"); await f.send("/sessions"); assert.equal(f.reads.at(-1), "local");
});

test("Connector preference is isolated by actor, chat and bot even in one state store", async t => {
  const f = fixture(t);
  for (const p of [who("bob"), who("alice", "room2"), who("alice", "room", "other-bot")]) f.grants.set(key(p), [A, B]);
  await choose(f, "C2"); await choose(f, "C1", who("bob")); await choose(f, "C1", who("alice", "room2"));
  const other = f.build("other-bot"); const p = who("alice", "room", "other-bot");
  await f.send("/connect", p, false, other); await f.send("/connect use C1", p, false, other);
  assert.equal(f.store.getConnectorSelection(who())?.hostId, B);
  for (const principal of [who("bob"), who("alice", "room2"), p]) assert.equal(f.store.getConnectorSelection(principal)?.hostId, A);
  for (const principal of [who(), who("bob"), who("alice", "room2")]) { await f.send("/sessions", principal); assert.equal(f.reads.at(-1), principal.actorId === "alice" && principal.conversationId === "room" ? B : A); }
});

test("Connector cards retain stable same-name identities and reject foreign, refreshed, unversioned or expired choices", async t => {
  const f = fixture(t); await f.send("/connect");
  const action = f.cards.at(-1)!.actionGroups.flat()[1].value;
  assert.deepEqual(parseChannelActionValue(action), action, "channel callback schema accepts Connector selection");
  f.grants.set(key(who()), [B, A]); // reorder does not change snapshot C2 identity
  await f.send(`/connect ${action.arg}`, who(), true); assert.equal(f.store.getConnectorSelection(who())?.hostId, B);
  await f.send("/connect use C1", who(), true); assert.match(f.texts.at(-1)!, /过期或已刷新/);
  f.grants.set(key(who("bob")), [A, B]); await f.send(`/connect ${action.arg}`, who("bob"), true);
  assert.equal(f.store.getConnectorSelection(who("bob")), undefined);
  await f.send("/connect"); await f.send(`/connect ${action.arg}`, who(), true); assert.match(f.texts.at(-1)!, /过期或已刷新/);
  const selection = new ConnectorSelection(f.store, f.peer), snap = selection.list(who()); snap.createdAt -= 16 * 60_000;
  assert.throws(() => selection.select(who(), "C1"), /过期/);
});

test("Connector offline and revoked choices never fall back or reveal cached session details", async t => {
  const f = fixture(t); await choose(f, "C2"); await f.send("/sessions");
  f.offline.add(B); const reads = f.reads.length;
  await f.send("/sessions"); assert.match(f.texts.at(-1)!, /离线/); assert.equal(f.reads.length, reads);
  assert.equal(f.store.getConnectorSelection(who())?.hostId, B);
  f.grants.set(key(who()), [A]); await f.send("/sessions detail R1"); assert.match(f.texts.at(-1)!, /授权已失效/);
  for (const command of ["/sessions", "/project", "/new --standalone"]) { await f.send(command); assert.match(f.texts.at(-1)!, /授权已失效/); }
  assert.equal(f.reads.length, reads); assert.deepEqual(f.creates, []);
  await f.send(`/sessions --host ${A}`); assert.equal(f.reads.at(-1), A);
  assert.equal(f.store.getConnectorSelection(who())?.hostId, B, "explicit recovery browsing does not replace revoked default");
  await choose(f, "C1"); await f.send("/sessions"); assert.equal(f.reads.at(-1), A);
});

test("Connector project and create scopes cannot reuse another device's cwd or source thread", async t => {
  const f = fixture(t); await f.send(`/session ${A}-thread-0 --host ${A}`); const before = f.store.getBoundSession("room")!.id;
  await choose(f, "C2"); await f.send("/new"); assert.match(f.texts.at(-1)!, /另一台设备/);
  await f.send("/sessions project"); assert.match(f.texts.at(-1)!, /另一台设备/);
  await f.send("/project"); assert.deepEqual(f.projectReads, [B]);
  const card = f.cards.at(-1)!; assert.ok(card.table?.rows.every(row => !row.join().includes("machine-a")));
  assert.equal(f.store.getBoundSession("room")!.id, before);
  await f.send("/new C1"); assert.equal(f.creates.at(-1)?.host, B); assert.equal(f.creates.at(-1)?.input.sourceThreadId, undefined);
  assert.equal(f.creates.at(-1)?.input.cwd, f.threads.get(B)![0].cwd);
  await choose(f, "C1"); await f.send("/new --standalone"); assert.equal(f.creates.at(-1)?.host, A);
  assert.equal(f.creates.at(-1)?.input.cwd, undefined); assert.equal(f.creates.at(-1)?.input.standalone, true);
});

test("Connector switching invalidates old session and project numbers without changing bindings", async t => {
  const f = fixture(t); await choose(f, "C1"); await f.send("/sessions");
  const oldAction = f.cards.at(-1)!.actionGroups.flat().find(a => a.value.command === "session")!.value;
  await f.send("/project");
  await choose(f, "C2"); await f.send("/session R1"); assert.match(f.texts.at(-1)!, /列表已过期/);
  await f.send(`/session ${oldAction.arg}`, who(), true); assert.match(f.texts.at(-1)!, /目录已失效/);
  await f.send("/new C1"); assert.match(f.texts.at(-1)!, /没有这份项目列表/);
  assert.deepEqual(f.creates, []); assert.equal(f.store.getBoundSession("room"), undefined);
});

test("Connector shared-resource viewers can select their devices without gaining pairing, local or creation access", async t => {
  const f = fixture(t);
  f.peer.sharing = { admitted: () => true } as never;
  const service = f.build("bot", true);
  const send = (text: string) => f.send(text, who(), false, service);
  await send("/connect"); await send("/connect use C2"); await send("/sessions all");
  assert.deepEqual(new Set(f.reads), new Set([A, B]));
  for (const command of ["/connect use local", "/connect ABCDEF-123456", "/new --standalone", "/sessions --host local"]) {
    await send(command); assert.match(f.texts.at(-1)!, /资源授权/);
  }
  assert.equal(f.store.getConnectorSelection(who())?.hostId, B); assert.equal(f.pairCalls, 0); assert.deepEqual(f.creates, []);
});

for (const operation of ["sessions", "project", "create"] as const) test(`Connector revocation during ${operation} blocks stale results and writes`, async t => {
  const f = fixture(t); await choose(f, "C1");
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const delay = async () => { entered.resolve(); await gate.promise; };
  if (operation === "sessions") f.waitCatalog = delay;
  if (operation === "project") f.waitProjects = delay;
  if (operation === "create") f.waitCreate = delay;
  const start = f.send(operation === "create" ? "/new --standalone" : `/${operation}`);
  await entered.promise; f.grants.set(key(who()), [B]); gate.resolve(); await start;
  assert.match(f.texts.at(-1)!, /授权已失效/); assert.equal(f.store.getBoundSession("room"), undefined); assert.deepEqual(f.creates, []);
});

for (const operation of ["sessions", "project", "create"] as const) test(`Connector generation rejects delayed ${operation} after A to B to A`, async t => {
  const f = fixture(t); await choose(f, "C1");
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const delay = async () => { entered.resolve(); await gate.promise; };
  if (operation === "sessions") f.waitCatalog = delay;
  if (operation === "project") f.waitProjects = delay;
  if (operation === "create") f.waitCreate = delay;
  const start = f.send(operation === "create" ? "/new --standalone" : `/${operation}`);
  await entered.promise; await f.send("/connect use C2"); await f.send("/connect use C1"); gate.resolve(); await start;
  assert.match(f.texts.at(-1)!, /Connector 已改变/);
  assert.equal(f.store.getBoundSession("room"), undefined); assert.deepEqual(f.creates, []);
});

test("Connector state migration preserves binding and rejects corrupt saved preferences instead of selecting local", async t => {
  const f = fixture(t); await choose(f, "C2");
  const state = JSON.parse(fs.readFileSync(f.paths.statePath, "utf8"));
  const before = { sessions: state.sessions, activeSessionIds: state.activeSessionIds, projects: state.projects };
  f.restart(); assert.deepEqual({ sessions: f.store.snapshot.sessions, activeSessionIds: f.store.snapshot.activeSessionIds, projects: f.store.snapshot.projects }, before);
  state.connectorSelections[key(who())] = { hostId: "arbitrary", revision: "x" }; fs.writeFileSync(f.paths.statePath, JSON.stringify(state));
  assert.throws(() => new RuntimeStateStore(f.paths), /Invalid Connector selection/);
  assert.equal(JSON.parse(fs.readFileSync(f.paths.statePath, "utf8")).connectorSelections[key(who())].hostId, "arbitrary");
});

for (const change of ["role", "grant"] as const) test(`Connector session selection rechecks ${change} after native inspection`, async t => {
  const f = fixture(t); await choose(f, "C1"); await f.send("/sessions");
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  f.waitInspect = async () => { entered.resolve(); await gate.promise; };
  const pending = f.send("/session R1");
  const result = pending.catch(error => error);
  await entered.promise;
  if (change === "role") f.store.setRole("room", "alice", "viewer"); else f.grants.set(key(who()), [B]);
  gate.resolve(); const error = await result;
  if (change === "role") assert.ok(error instanceof Error);
  else assert.match(f.texts.at(-1)!, /授权已失效/);
  assert.equal(f.store.getBoundSession("room"), undefined);
});

test("one selected Connector expands native hosts, preserves empty projects and creates on the selected remote project", async t => {
  const f = fixture(t);
  f.peer.isRouted = host => [A, B].includes(host ?? "");
  f.peer.connectorRoot = host => host === B ? A : host;
  f.peer.catalogHosts = host => host === A ? [A, B] : [host];
  await f.send("/connect");
  assert.equal(new ConnectorSelection(f.store, f.peer).list(who()).hosts.length, 1);
  await f.send("/sessions");
  assert.deepEqual(new Set(f.reads), new Set([A, B]));
  assert.match(f.cards.at(-1)!.body, /machine-a.*empty/);
  assert.match(f.cards.at(-1)!.body, /machine-b.*empty/);
  await f.send("/project");
  assert.deepEqual(new Set(f.projectReads), new Set([A, B]));
  // Select through its native project action so creation uses the same host.
  const action = f.cards.at(-1)!.actionGroups.flat().find(a => a.label.includes('machine-b:work-project'));
  assert.ok(action);
  const parsed = parseChannelActionValue(action.value); assert.ok(parsed);
  await f.send(`/${parsed.command} ${parsed.arg ?? ""}`);
  await f.send("/new");
  assert.equal(f.creates.at(-1)?.host, B); assert.equal(f.stops.length, 0);
});
