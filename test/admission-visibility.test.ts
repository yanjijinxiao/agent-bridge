import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdmissionService } from "../src/bridge/admission.js";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { parseChannelActionValue } from "../src/channels/action-card.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { PeerRegistry } from "../src/peer/registry.js";
import type { ChannelPrincipal } from "../src/channels/principal.js";

const admin: ChannelPrincipal = { accountId: "bot", channel: "dingtalk", providerId: "provider", actorId: "admin" };
const person = { ...admin, actorId: "person" };
const rendered = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-visibility-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const personal = new Set<string>(), groups = new Set<string>(), ide = new Set<string>(), changes: string[] = [];
  let now = 1000;
  const options = { root, now: () => now,
    accounts: () => [{ accountId: "bot", channel: "dingtalk", providerId: "provider" }, { accountId: "other-bot", channel: "dingtalk", providerId: "other-provider" }],
    allowed: (_account: string, actor: string, conversation: string) => personal.has(actor) || groups.has(conversation),
    accessStatus: (p: ChannelPrincipal, conversation: string) => ({ personal: personal.has(p.actorId), conversation: groups.has(conversation), ide: ide.has(p.actorId) }),
    allow: (_account: string, target: string) => { changes.push(target); personal.add(target); } };
  const service = new AdmissionService(options);
  const enroll = () => { const r = service.observe(admin, "admin-dm", "direct"); service.setAdmin(r.id, r.version); personal.add(admin.actorId); };
  const request = (actor: string, chat: string) => service.observe({ ...person, actorId: actor }, chat, "group");
  return { root, service, options, personal, groups, ide, changes, enroll, request, tick: () => now += 24 * 60 * 60_000 };
}

test("access defaults to the current person's current-chat status without exposing or creating other requests", t => {
  const f = fixture(t), own = f.request(person.actorId, "room"), other = f.request("private-other-person", "room");
  const elsewhere = f.request(person.actorId, "private-other-room"), before = fs.readFileSync(path.join(f.root, "admission.json"), "utf8");
  const text = rendered(f.service.command(person, "room", "group", ""));
  assert.match(text, /当前聊天|未获准/); assert.ok(text.includes(own.id));
  for (const hidden of [other.id, elsewhere.id, "private-other-person", "private-other-room"]) assert.ok(!text.includes(hidden), hidden);
  assert.equal(fs.readFileSync(path.join(f.root, "admission.json"), "utf8"), before);
  assert.deepEqual(f.changes, []);
  const detail = rendered(f.service.command(person, "room", "group", `show ${own.id}`));
  assert.ok(detail.includes(own.id)); assert.doesNotMatch(detail, /仅允许此用户|允许整个群聊|actionGroups/);
  assert.throws(() => f.service.command(person, "room", "group", `show ${other.id}`), /范围|权限/);
});

test("access shows existing personal/group sources without granting IDE or rewriting admission", t => {
  const f = fixture(t);
  f.groups.add("room");
  const group = rendered(f.service.command(person, "room", "group", ""));
  assert.match(group, /本群授权/); assert.match(group, /Web IDE 配对资格：未获准/);
  f.personal.add(person.actorId);
  const personal = rendered(f.service.command(person, "room", "group", ""));
  assert.match(personal, /个人授权/); assert.match(personal, /本群授权/);
  assert.match(personal, /Web IDE 配对资格：未获准/);
  f.ide.add(person.actorId);
  assert.match(rendered(f.service.command(person, "room", "group", "")), /Web IDE 配对资格：已获准/);
  f.personal.clear(); f.groups.clear(); f.ide.clear();
  assert.match(rendered(f.service.command(person, "room", "group", "")), /IM 准入：未获准/);
  assert.deepEqual(f.changes, []); assert.equal(fs.existsSync(path.join(f.root, "admission.json")), false);
});

test("admins see this chat by default; cross-chat admission listing is explicit and private", t => {
  const f = fixture(t); f.enroll();
  const here = f.request("here-person", "room"), there = f.request("elsewhere-person", "elsewhere-room");
  const foreign = f.service.observe({ ...person, accountId: "other-bot", providerId: "other-provider" }, "foreign-room", "group");
  const local = rendered(f.service.command(admin, "room", "group", ""));
  assert.ok(local.includes(here.id)); assert.ok(!local.includes(there.id)); assert.ok(!local.includes(foreign.id));
  const directDefault = rendered(f.service.command(admin, "admin-dm", "direct", ""));
  assert.ok(!directDefault.includes(here.id)); assert.ok(!directDefault.includes(there.id));
  const global = rendered(f.service.command(admin, "admin-dm", "direct", "all"));
  assert.ok(global.includes(here.id)); assert.ok(global.includes(there.id)); assert.ok(!global.includes(foreign.id));
  assert.match(global, /show [a-f0-9]{12} --all/);
  assert.throws(() => f.service.command(admin, "room", "group", "all"), /私聊/);
  assert.throws(() => f.service.command(person, "person-dm", "direct", "all"), /管理员/);
});

test("admission listing shows 50 requests with overflow count and preserves current-chat scope", t => {
  const f = fixture(t); f.enroll();
  const requests = Array.from({ length: 51 }, (_, i) => f.request(`applicant-${i}`, "room"));
  const elsewhere = f.request("foreign-applicant", "another-room");
  const text = rendered(f.service.command(admin, "room", "group", ""));
  assert.equal(requests.filter(r => text.includes(r.id)).length, 50);
  assert.match(text, /显示前 50 条，共 51 条/);
  assert.ok(!text.includes(elsewhere.id));
  assert.deepEqual(f.changes, []);
});

test("admission details and copied decision cards enforce the same current-chat or explicit private scope", t => {
  const f = fixture(t); f.enroll(); const r = f.request("other-applicant", "other-room");
  assert.throws(() => f.service.command(admin, "room", "group", `show ${r.id}`), /范围/);
  assert.throws(() => f.service.command(admin, "admin-dm", "direct", `show ${r.id}`), /范围/);
  assert.throws(() => f.service.command(admin, "room", "group", `actor ${r.id} ${r.version}`), /范围/);
  const card = f.service.command(admin, "admin-dm", "direct", `show ${r.id} --all`);
  assert.notEqual(typeof card, "string");
  if (typeof card === "string") return;
  const action = parseChannelActionValue(card.actionGroups[0][0].value)!;
  assert.match(action.arg!, / --all$/);
  assert.throws(() => f.service.command(admin, "room", "group", action.arg!), /私聊/);
  assert.throws(() => f.service.command(person, "person-dm", "direct", action.arg!), /管理员/);
  for (const malformed of [`show ${r.id} --all extra`, `actor ${r.id} ${r.version} --all extra`])
    assert.throws(() => f.service.command(admin, "room", "group", malformed), /私聊|用法/);
  assert.deepEqual(f.changes, []);
  f.service.command(admin, "admin-dm", "direct", action.arg!);
  assert.deepEqual(f.changes, ["other-applicant"]);
  assert.throws(() => f.service.command(admin, "admin-dm", "direct", action.arg!), /已处理/);
});

test("old admission cards survive in their own chat only and lose authority on revocation or expiry", t => {
  const f = fixture(t); f.enroll(); const r = f.request("applicant", "room");
  const oldCommand = `actor ${r.id} ${r.version}`;
  assert.throws(() => f.service.command(admin, "other-room", "group", oldCommand), /范围/);
  f.service.removeAdmin(admin);
  assert.match(rendered(f.service.command(admin, "room", "group", oldCommand)), /没有.*管理员/);
  assert.deepEqual(f.changes, []); f.enroll();
  const reloaded = new AdmissionService(f.options);
  reloaded.command(admin, "room", "group", oldCommand); assert.deepEqual(f.changes, ["applicant"]);
  const pending = f.request("pending", "room"); f.tick();
  assert.throws(() => f.service.command(admin, "room", "group", `show ${pending.id}`), /过期|失效/);
});

test("Bridge takes admission visibility from the actual actor and conversation for command and card callbacks", async t => {
  const f = fixture(t); f.enroll(); const r = f.request("private-applicant", "private-room");
  const replies: string[] = [], cards: any[] = [];
  const bridge = new BridgeService({ accountId: "bot", ideProviderId: "provider", admission: f.service,
    stateStore: new RuntimeStateStore(resolveStatePaths(path.join(f.root, "bridge"))), config: defaultConfig(f.root),
    runner: { run() { throw Error("No model task during permission inspection"); } } as never,
    channel: createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, actions: "available" }, {
      async sendText(input) { replies.push(input.text); return { messageId: "text" }; },
      async sendActionCard(input) { cards.push(input.card); return { messageId: "card" }; }
    }) });
  t.after(() => bridge.suspendUserInputs()); let count = 0;
  const send = (text: string, actor = "admin", chat = "room", kind: "direct" | "group" = "group") => bridge.handleMessage({
    id: String(++count), senderId: actor, replyTargetId: chat, conversationKind: kind, text, attachments: [], raw: {} });
  await send("/access"); assert.ok(!replies.at(-1)!.includes(r.id));
  await send(`/access show ${r.id}`); assert.equal(cards.length, 0);
  await send(`/access show ${r.id} --all`, "admin", "admin-dm", "direct"); assert.equal(cards.length, 1);
  const action = parseChannelActionValue(cards[0].actionGroups[0][0].value)!;
  await send(`/access ${action.arg}`); assert.match(replies.at(-1)!, /私聊/); assert.deepEqual(f.changes, []);
  await send(`/access ${action.arg}`, "stranger", "stranger-dm", "direct"); assert.deepEqual(f.changes, []);
  await send(`/access ${action.arg}`, "admin", "admin-dm", "direct"); assert.deepEqual(f.changes, ["private-applicant"]);
});

test("connect lists only this actor's grants in this bot and chat, including first-use empty state", async t => {
  const f = fixture(t), principal = { accountId: "bot", conversationId: "room", actorId: "person" };
  const grants = [
    { id: "own", principal, hostId: "peer:own:work", scope: "device" },
    { id: "other-chat", principal: { ...principal, conversationId: "another-room" }, hostId: "peer:other-chat:work", scope: "device" },
    { id: "other-person", principal: { ...principal, actorId: "another-person" }, hostId: "peer:other-person:work", scope: "device" },
    { id: "other-bot", principal: { ...principal, accountId: "another-bot" }, hostId: "peer:other-bot:work", scope: "device" }
  ];
  const file = path.join(f.root, "peer-grants.json"); fs.writeFileSync(file, JSON.stringify({ version: 1, grants: grants.map(g => ({ ...g, id: crypto.randomUUID() })) }));
  const registry = new PeerRegistry(file), replies: string[] = [];
  const bridge = new BridgeService({ accountId: "bot", peer: registry, config: { ...defaultConfig(f.root), allowedSenderIds: ["room"] },
    stateStore: new RuntimeStateStore(resolveStatePaths(path.join(f.root, "bridge"))), runner: {} as never,
    channel: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText(input) { replies.push(input.text); return { messageId: "text" }; } }) });
  t.after(() => { bridge.suspendUserInputs(); registry.close(); });
  const send = (actor: string) => bridge.handleMessage({ id: actor, senderId: actor, replyTargetId: "room", conversationKind: "group", text: "/connect", attachments: [], raw: {} });
  await send("person"); const text = replies.at(-1)!;
  assert.match(text, /当前聊天/); assert.ok(text.includes("peer:own:work"));
  for (const g of grants.slice(1)) assert.ok(!text.includes(g.hostId), g.hostId);
  await send("new-person"); const empty = replies.at(-1)!;
  assert.match(empty, /配对/); for (const g of grants) assert.ok(!empty.includes(g.hostId));
});
