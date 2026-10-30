import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { createPeerChannelAdapter, attachPeerConversation } from "../src/peer/channel.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { peerFixture, principal } from "./peer-fixture.js";

test("pair the device, choose a session entirely in DingTalk, then switch to another local session", async t => {
  const f = await peerFixture(t, { device: true }), paths = resolveStatePaths(path.join(f.root, "gateway-state")), store = new RuntimeStateStore(paths);
  const replies: string[] = [];
  const localUnavailable = new Proxy(f.facade, { get(target, key) {
    if (key === "listSessionCatalog") return (input: any, host: string) => {
      assert.ok(host.startsWith("peer:"), "Device selection must not depend on Codex installed on Gateway");
      return target.listSessionCatalog(input, host);
    };
    return Reflect.get(target, key);
  } });
  const service = new BridgeService({ config: { ...defaultConfig(paths.root), allowedSenderIds: [principal.actorId], streamReplies: false },
    accountId: principal.accountId, stateStore: store, runner: localUnavailable, peer: f.registry,
    channel: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText(input) { replies.push(input.text); return { messageId: crypto.randomUUID() }; } }) });
  t.after(() => service.suspendUserInputs());
  const send = (text: string) => service.handleMessage({ id: crypto.randomUUID(), senderId: principal.actorId, replyTargetId: principal.conversationId,
    text, attachments: [], raw: {} });
  await assert.rejects(f.as(() => f.facade.listSessionCatalog({}, f.ticket.hostId)), /未获准/);
  await send(`/connect ${f.ticket.code}`);
  assert.equal(store.getBoundSession(principal.conversationId), undefined);
  assert.ok(replies.some(text => text.includes("我的笔记本")));
  assert.ok(replies.at(-1)?.includes(f.thread.title!)); assert.ok(replies.at(-1)?.includes(f.thread.cwd!));
  await send("还没选择会话的普通消息"); assert.equal(f.runs.length, 0);
  await send("/session R1"); await send("继续第一个任务");
  assert.equal(f.runs[0].threadId, f.thread.threadId);
  // A new local session becomes discoverable without restarting or editing config.
  f.threads.push({ ...f.thread, threadId: "second-native", title: "新的网关任务", cwd: "/device-only/another-project", updatedAt: "2026-10-30T10:00:00Z" });
  await send("/sessions"); assert.ok(replies.at(-1)?.includes("新的网关任务"));
  const visibleRow = replies.at(-1)!.split("\n").find(line => line.includes("新的网关任务"));
  const selected = /R\d+/.exec(visibleRow ?? "")?.[0]; assert.ok(selected, visibleRow);
  await send(`/session ${selected}`); await send("继续第二个任务");
  assert.equal(f.runs.at(-1)?.threadId, "second-native"); assert.equal(f.runs.at(-1)?.cwd, "/device-only/another-project");
  assert.deepEqual(store.listSessions().map(session => session.hostId), [f.ticket.hostId, f.ticket.hostId]);
  await send("/connect"); assert.ok(replies.at(-1)?.includes("我的笔记本"));
  await f.reconnect(true); await send("第三条消息"); assert.equal(f.runs.at(-1)?.threadId, "second-native");
});

test("DingTalk-normalized chat pairs and continues the exact existing device session", async t => {
  const f = await peerFixture(t), paths = resolveStatePaths(path.join(f.root, "gateway-state")), store = new RuntimeStateStore(paths);
  const replies: string[] = [];
  const channel = createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText(input) { replies.push(input.text); return { messageId: crypto.randomUUID() }; } });
  const config = { ...defaultConfig(paths.root), allowedSenderIds: [principal.actorId], model: "gateway-gpt-default", streamReplies: false };
  const service = new BridgeService({ config, accountId: principal.accountId, stateStore: store, channel, runner: f.facade, peer: f.registry });
  t.after(() => service.suspendUserInputs());
  const message = (text: string, senderId = principal.actorId) => ({ id: crypto.randomUUID(), senderId, replyTargetId: principal.conversationId,
    conversationKind: "group" as const, text, attachments: [], raw: {} });
  await service.handleMessage(message(`/connect ${f.ticket.code}`));
  const session = store.getBoundSession(principal.conversationId)!;
  assert.ok(session, replies.join("\n"));
  assert.equal(session.hostId, f.ticket.hostId); assert.equal(session.threadId, f.thread.threadId); assert.equal(session.workspace, f.thread.cwd);
  assert.deepEqual(config.allowedWorkspaces, [paths.root]); // A device workspace is never admitted on the server.
  await service.handleMessage(message("继续任务"));
  assert.equal(f.runs.length, 1, replies.join("\n"));
  assert.equal(f.runs[0].threadId, f.thread.threadId); assert.equal(f.runs[0].model, undefined);
  assert.equal(f.runs[0].cwd, f.thread.cwd); assert.ok(replies.some(text => text.includes("来自设备的回答")));
  await service.handleMessage(message("/history"));
  assert.equal(f.runs.length, 1);
  await service.handleMessage(message("/model"));
  assert.ok(replies.at(-1)?.includes("deepseek-v4.1-flash-1017"));
  await service.handleMessage(message("/balance"));
  assert.ok(replies.at(-1)?.includes("device-only-limit"), replies.at(-1));
  await service.handleMessage(message("/leave")); assert.equal(store.getBoundSession(principal.conversationId), undefined);
});

test("Gateway chat ACL and peer grants both apply even when a group is allowed", async t => {
  const f = await peerFixture(t), store = new RuntimeStateStore(resolveStatePaths(path.join(f.root, "gateway-state")));
  const replies: string[] = [];
  const service = new BridgeService({ config: { ...defaultConfig(f.root), allowedSenderIds: [principal.conversationId], streamReplies: false },
    accountId: principal.accountId, stateStore: store, runner: f.facade, peer: f.registry,
    channel: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText(input) { replies.push(input.text); return { messageId: crypto.randomUUID() }; } }) });
  t.after(() => service.suspendUserInputs());
  const send = (senderId: string, text: string) => service.handleMessage({ id: crypto.randomUUID(), senderId, replyTargetId: principal.conversationId, text, attachments: [], raw: {} });
  await send(principal.actorId, `/connect ${f.ticket.code}`);
  await send("other-member", "执行这个请求").catch(() => {});
  assert.equal(f.runs.length, 0);
  await send(principal.actorId, "执行这个请求"); assert.equal(f.runs.length, 1, replies.join("\n"));
});

for (const channelOn of ["accepted", "dialled"] as const) test(`a remote conversation acts as a real Bridge channel on the ${channelOn} endpoint`, async t => {
  const f = await peerFixture(t), store = new RuntimeStateStore(resolveStatePaths(path.join(f.root, "channel-state")));
  const serverEnd = channelOn === "accepted" ? f.serverConnection : f.clientConnection;
  const clientEnd = channelOn === "accepted" ? f.clientConnection : f.serverConnection;
  const adapter = createPeerChannelAdapter(serverEnd, { nodeId: "interactive-client", actorId: "remote-user", conversationId: "remote-chat" });
  const replies: string[] = [];
  const conversation = attachPeerConversation(clientEnd, "remote-chat", async input => { replies.push(input.text); return { messageId: crypto.randomUUID() }; });
  const service = new BridgeService({ config: { ...defaultConfig(f.root), allowedSenderIds: ["remote-user"] }, stateStore: store,
    channel: adapter.client, runner: f.backend });
  const stop = new AbortController();
  const monitoring = adapter.monitor({ signal: stop.signal, onMessage: message => service.handleMessage(message) });
  t.after(async () => { stop.abort(); await monitoring; conversation.detach(); service.suspendUserInputs(); });
  assert.deepEqual(await conversation.send("help-source", "/help"), { accepted: true });
  assert.ok(replies.some(text => text.includes("/sessions")), replies.join("\n"));
  assert.equal(f.runs.length, 0);
  await assert.rejects(clientEnd.request("conversation.input", { id: "forged", text: "/help", senderId: "administrator" }));
});
