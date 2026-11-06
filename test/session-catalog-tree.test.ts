import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Lexer } from "marked";
import { BridgeService } from "../src/bridge/service.js";
import { orderSessionCatalog, type SessionCatalogRow } from "../src/bridge/session-catalog-order.js";
import { sessionCatalogItems } from "../src/bridge/session-catalog-view.js";
import type { CodexProjectCandidate } from "../src/server/codex-projects.js";
import type { CodexSessionCatalog, CodexThreadState } from "../src/codex/backend.js";
import type { ChannelActionCard } from "../src/channels/action-card.js";
import { normalizeDingTalkCardContent } from "../src/channels/dingtalk-markdown.js";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk.js";
import { DingTalkCardRouting } from "../src/channels/dingtalk-card-routing.js";
import { DEFAULT_RESULT_PAGE_BYTES } from "../src/channels/result-pages.js";
import { ChannelPartialDeliveryError } from "../src/channels/errors.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { PeerError } from "../src/peer/rpc.js";

const project = (projectId: string, name = projectId, hostId = "local"): CodexProjectCandidate => ({
  projectId, name, hostId, workspace: "/same", sessionCount: 0, lastUsedAt: ""
});
const thread = (threadId: string, projectId?: string): CodexThreadState => ({
  threadId, title: threadId, projectId, cwd: "/same", persistence: "active", runtimeStatus: "idle", activeFlags: []
});
function fixture(t: { after(fn: () => void): void }, projects: CodexProjectCandidate[], byHost: Record<string, CodexThreadState[]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-session-tree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)), cards: ChannelActionCard[] = [], texts: string[] = [], inspections: string[] = [];
  const failed = new Set<string>(), partial = new Set<string>(), errors = new Map<string, Error>(); let sequence = 0, reads = 0;
  const service = new BridgeService({ stateStore: store,
    config: { ...defaultConfig(root), allowedSenderIds: ["alice"], codexBackend: "app-server", streamReplies: false },
    listCodexProjects: () => projects,
    runner: {
      async listSessionCatalog(input, hostId = "local"): Promise<CodexSessionCatalog> {
        reads++; if (errors.has(hostId)) throw errors.get(hostId)!; if (failed.has(hostId)) throw new Error("offline fixture");
        return { backend: "app-server", source: "desktop-catalog", hostIds: [], warnings: [], complete: !partial.has(hostId),
          threads: (byHost[hostId] ?? []).filter(row => !input?.projectId || row.projectId === input.projectId) };
      },
      async inspectThread(id, hostId = "local") { inspections.push(`${hostId}/${id}`); return byHost[hostId].find(row => row.threadId === id)!; },
      async getHistory() { return []; }
    } as never,
    weixin: { async sendActionCard(x) { cards.push(x.card); return { messageId: "card" }; }, async sendText(x) { texts.push(x.text); return { messageId: "text" }; } }
  });
  return { cards, texts, store, failed, partial, errors, inspections, reads: () => reads,
    send: (text: string) => service.handleMessage({ id: String(sequence++), senderId: "alice", text, raw: {} }) };
}

test("CAT-01.7: partial catalog names the failed local branch and keeps remote sessions selectable", async t => {
  const f = fixture(t, [project("local-project"), project("remote-project", "Remote", "remote")], { remote: [thread("remote-task", "remote-project")] });
  f.errors.set("local", new PeerError("native-setup", "本机 Codex 原生服务启动失败，请检查 daemon start。"));
  await f.send("/sessions");
  const card = f.cards[0];
  assert.match(card.body, /会话列表读取失败；当前仅显示其他可读取主机的结果/);
  assert.match(card.body, /本机 Codex 原生服务启动失败/);
  assert.match(card.body, /\[R1\] remote-task/);
  assert.doesNotMatch(card.body, /暂无未归档会话/);
  assert.deepEqual(card.actionGroups.flat().map(x => x.value.arg), ["remote-task --host remote"]);
});

test("sessions tree retains empty and archived-only projects, renders pinned once and never makes folders selectable", async t => {
  const projects = [project("empty", "Empty"), project("archived", "Archived only"), project("pin", "Pinned project"), project("work", "Work")];
  const f = fixture(t, projects, { local: [{ ...thread("pin-task", "pin"), catalogOrder: { pinnedIndex: 0 } },
    { ...thread("old-task", "archived"), persistence: "archived" }, thread("work-task", "work"), thread("free-task")] });
  await f.send("/sessions");
  const card = f.cards[0];
  assert.match(card.body, /置顶[\s\S]*\[R1\] pin-task[\s\S]*项目[\s\S]*📁 \*\*Empty\*\*\n　暂无未归档会话[\s\S]*📁 \*\*Archived only\*\*\n　暂无未归档会话[\s\S]*📁 \*\*Pinned project\*\*\n　会话已在置顶区显示[\s\S]*📁 \*\*Work\*\*\n　\[R2\] work-task[\s\S]*其他会话[\s\S]*\[R3\] free-task/);
  assert.equal(card.table, undefined);
  assert.equal(card.body.match(/pin-task/g)?.length, 1);
  assert.doesNotMatch(card.body, /old-task/);
  assert.deepEqual(card.actionGroups.flat().map(x => x.value.arg), ["pin-task --host local", "work-task --host local", "free-task --host local"]);
  assert.equal(f.store.listProjects().length, 0, "listing empty folders must not register managed projects");
  const nativeContent = normalizeDingTalkCardContent(card.body);
  assert.match(nativeContent, /Empty/); assert.match(nativeContent, /暂无未归档会话/);
  assert.ok(!Lexer.lex(nativeContent).some(token => token.type === "code" || token.type === "table"));
});

test("empty folders paginate and resize independently of global session R identities and exact host binding", async t => {
  const projects = Array.from({ length: 6 }, (_, i) => project(`e${i}`, `Empty ${i}`));
  projects.push(project("work", "Work", "remote"));
  const f = fixture(t, projects, { remote: [thread("target", "work")] });
  await f.send("/sessions size 5");
  assert.match(f.cards[0].title, /1 个.*1\/2 页/);
  assert.equal(f.cards[0].body.match(/暂无未归档会话/g)?.length, 5);
  assert.deepEqual(f.cards[0].actionGroups.flat().map(x => x.value.arg), ["more"]);
  await f.send("/sessions more");
  assert.match(f.cards.at(-1)!.body, /Empty 5[\s\S]*Work · remote[\s\S]*\[R1\] target/);
  await f.send("/sessions detail R1"); assert.match(f.texts.at(-1)!, /主机：remote/);
  assert.equal(f.inspections.length, 0, "details read the immutable snapshot only");
  await f.send("/sessions size 10");
  assert.match(f.cards.at(-1)!.body, /Empty 0[\s\S]*\[R1\] target/);
  assert.equal(f.reads(), 2, "one read per host, navigation does not rediscover");
  await f.send("/session R1");
  assert.deepEqual(f.inspections, ["remote/target"]);
  assert.equal(f.store.getActiveSession("alice")?.threadId, "target");
  assert.equal(f.store.getActiveSession("alice")?.hostId, "remote");
});

test("offline and incomplete projects stay visible without claiming empty; filtered lists omit unrelated folders", async t => {
  const projects = [project("a", "Same"), project("b", "Same"), project("a", "Same", "remote"), project("c", "Partial", "partial")];
  const f = fixture(t, projects, { local: [thread("found", "b"), thread("standalone")] });
  f.failed.add("remote"); f.partial.add("partial");
  await f.send("/sessions");
  const body = f.cards[0].body;
  assert.equal(body.match(/📁/g)?.length, 4);
  assert.match(body, /Same #\d+ · remote\*\*\n　会话列表暂不可用/);
  assert.match(body, /Partial · partial\*\*\n　会话目录尚未同步完整/);
  assert.equal(body.match(/暂无未归档会话/g)?.length, 1);
  await f.send("/sessions search found");
  assert.equal(f.cards.at(-1)!.body.match(/📁/g)?.length, 1);
  assert.doesNotMatch(f.cards.at(-1)!.body, /暂无未归档会话|📁.*Partial/);
  await f.send("/sessions unassigned");
  assert.doesNotMatch(f.cards.at(-1)!.body, /📁|found/);
  assert.match(f.cards.at(-1)!.body, /standalone/);
  const chosen = f.store.createProject("Chosen", "/same", { sourceProjectId: "a" });
  f.store.activateProject("alice", chosen.id);
  await f.send("/sessions project");
  assert.equal(f.cards.at(-1)!.body.match(/📁/g)?.length, 1);
  assert.match(f.cards.at(-1)!.body, /当前项目\n　暂无未归档会话/);
});

test("filtered pinned rows do not reorder project children or mutate the original snapshot", () => {
  const projects = [project("z", "Z"), project("a", "A")];
  const rows: SessionCatalogRow[] = [{ hostId: "local", state: { ...thread("pin", "a"), catalogOrder: { pinnedIndex: 0 } } },
    { hostId: "local", state: thread("z", "z") }, { hostId: "local", state: thread("a", "a") }];
  const ordered = orderSessionCatalog(rows, projects, []);
  const before = structuredClone(ordered);
  const items = sessionCatalogItems(ordered, projects, { includeEmpty: false, incompleteHosts: new Map() });
  assert.deepEqual(items.map(item => item.kind === "session" ? item.row.state.threadId : "folder"), ["pin", "z", "a"]);
  assert.deepEqual(ordered, before);
});

test("all-empty catalog still sends a folder card with no fake choices or injected Markdown", async t => {
  const f = fixture(t, [project("empty", "[bad](https://invalid)\n```text")]);
  await f.send("/sessions");
  const card = f.cards[0];
  assert.match(card.title, /0 个.*1\/1 页/);
  assert.match(card.body, /暂无未归档会话/);
  assert.doesNotMatch(card.body, /没有符合|\[R\d+\]/);
  assert.equal(card.actionGroups.flat().length, 0);
  const links: string[] = [];
  Lexer.lexInline(card.body).forEach(token => { if (token.type === "link") links.push(token.href); });
  assert.deepEqual(links, []);
  assert.deepEqual(Lexer.lex(card.fallbackText).filter(token => token.type === "code"), []);
  assert.equal(f.store.listProjects().length, 0);
});

for (const count of [2, 8, 50]) test(`DingTalk sends the actual non-table sessions tree as finalized bounded AI cards (${count} folders)`, async t => {
  const f = fixture(t, Array.from({ length: count }, (_, i) => project(String(i), `目录${i}${"长".repeat(38)}`)),
    { local: Array.from({ length: count }, (_, i) => thread(`会话${i}${"长".repeat(45)}`, String(i))) });
  await f.send("/sessions size 50");
  const routing = new DingTalkCardRouting("fake"); routing.remember("room", "2", "staff", "fake");
  const created: string[] = [], finalized: string[] = [];
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "fixture", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", savedAt: "", enabled: true }, { cardRouting: routing,
    streamClient: { async getAccessToken() { return "fake"; } } as never,
    cardClient: { async create(input) { created.push(input.text); }, async update(input) {
      assert.equal(input.finalize, true); finalized.push(input.text);
    } }, async webhookSender() { throw new Error("tree must retain AI card presentation"); }
  });
  const receipt = await adapter.client.sendActionCard({ toUserId: "room", card: f.cards[0] });
  assert.ok(receipt.messageId);
  assert.deepEqual(finalized, created);
  assert.equal(created.join("\n").match(/📁/g)?.length, count);
  assert.equal(created.join("\n").match(/\[R\d+\]/g)?.length, count);
  for (const text of created) assert.ok(Buffer.byteLength(normalizeDingTalkCardContent(text)) <= DEFAULT_RESULT_PAGE_BYTES);
  assert.match(created.at(-1)!, /\/session R编号/);
  assert.equal(adapter.client.capabilities.actions, "not-implemented", "static card rendering cannot advertise clickable native controls");
  assert.equal(created.length > 1, count === 50);
});

test("DingTalk project tree partial delivery retains acknowledged pages and never falls back or resends", async t => {
  const f = fixture(t, Array.from({ length: 50 }, (_, i) => project(String(i), `目录${i}${"长".repeat(38)}`)));
  await f.send("/sessions size 50");
  const routing = new DingTalkCardRouting("fake"); routing.remember("room", "2", "staff", "fake");
  let creates = 0;
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "fixture", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", savedAt: "", enabled: true }, { cardRouting: routing,
    streamClient: { async getAccessToken() { return "fake"; } } as never,
    cardClient: { async create() { creates++; }, async update() { if (creates === 2) throw new Error("lost final acknowledgement"); } },
    async webhookSender() { throw new Error("no alternate delivery after an acknowledged page"); }
  });
  await assert.rejects(adapter.client.sendActionCard({ toUserId: "room", card: f.cards[0] }), error => {
    assert.ok(error instanceof ChannelPartialDeliveryError);
    assert.equal(error.delivered.length, 1);
    assert.match(error.delivered[0].text, /目录0/);
    return true;
  });
  assert.equal(creates, 2);
});
