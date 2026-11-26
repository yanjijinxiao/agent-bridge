import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { memberBinding } from "../src/channels/conversation-binding.js";
import type { ChannelMessage } from "../src/channels/message.js";
import { PeerExecutionService } from "../src/peer/execution-service.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { GatewayPeerClient } from "../src/peer/transport.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { peerFixture, token } from "./peer-fixture.js";

test("one Gateway routes by authenticated Connector policy across accounts, selection changes and restart", async t => {
  const a = await peerFixture(t, { device: true, onUnbound: "create-when-unbound", additionalCredentials: { second: token } });
  const dir = path.join(a.root, "second-device");
  fs.mkdirSync(dir);
  const b = await PeerExecutionService.create({ backend: a.backend, stateDir: dir, label: "我的笔记本", profileId: "work",
    onUnbound: "manual", independent: true, approve: async () => true });
  const registered = Promise.withResolvers<{ hostId: string; code: string }>();
  const second = new GatewayPeerClient({ url: a.server.url, nodeId: "second", token,
    connected: async connection => {
      b.attach(connection);
      registered.resolve(await connection.request("peer.register", b.description));
    } });
  t.after(async () => { second.close(); await b.close(); });
  second.start();
  const other = await registered.promise;
  const first = a.ticket.hostId;
  const person = { accountId: "tantan", actorId: "alice", conversationId: "chat" };
  await a.bind(person);
  await a.registry.connect(other.code, person, () => {});
  assert.equal(a.registry.label(first), a.registry.label(other.hostId));
  assert.equal(a.registry.unboundSessionPolicy(other.hostId), "manual");

  function account(accountId: string) {
    const store = new RuntimeStateStore(resolveStatePaths(path.join(a.root, accountId)));
    const service = new BridgeService({ accountId, stateStore: store, config: { ...defaultConfig(dir), allowedSenderIds: ["alice"] },
      firstContact: { groupScope: "member", connector: first }, runner: a.facade, peer: a.registry,
      channel: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText() { return { messageId: "sent" }; } }) });
    const msg = (text: string, kind: ChannelMessage["conversationKind"] = "direct") => service.addressInbound({
      id: crypto.randomUUID(), text, conversationKind: kind, senderId: person.actorId, replyTargetId: person.conversationId, attachments: [], raw: {} });
    return { service, store, msg };
  }
  const one = account("tantan"), two = account("toutou");
  assert.equal(two.msg("hi").firstContactHost, undefined); // same device policy, separate bot admission/grants
  const ticket = await a.reconnect();
  await a.registry.connect(ticket.code, { ...person, accountId: "toutou" }, () => {});
  assert.equal(two.msg("hi").firstContactHost, first);

  const stale = one.msg("previous selection");
  one.store.setConnectorSelection(person, other.hostId);
  assert.equal(one.msg("manual host").firstContactId, undefined);
  one.store.setConnectorSelection(person, first);
  await assert.rejects(one.service.handleMessage(stale), /改变/);
  const input = one.msg("first message");
  assert.equal(input.firstContactHost, first);
  await one.service.handleMessage(input);
  const original = one.store.getBoundSession("chat")!;
  assert.ok(original.threadId);
  one.store.setConnectorSelection(person, other.hostId);
  await one.service.handleMessage(one.msg("continue"));
  assert.equal(a.runs.at(-1)?.threadId, original.threadId);
  // A legacy private device can be unregistered by the time the user leaves.
  one.store.setConnectorSelection(person, "peer:retired:default");
  for (const otherPerson of [{ ...person, actorId: "bob" }, { ...person, conversationId: "elsewhere" }])
    one.store.setConnectorSelection(otherPerson, other.hostId);
  await one.service.handleMessage(one.msg("/leave"));
  const reset = one.store.getConnectorSelection(person)!;
  assert.ok(reset.revision);
  assert.equal(reset.hostId, undefined);
  assert.equal(one.msg("first message after leave").firstContactHost, first);
  for (const otherPerson of [{ ...person, actorId: "bob" }, { ...person, conversationId: "elsewhere" }])
    assert.equal(one.store.getConnectorSelection(otherPerson)?.hostId, other.hostId);
  // An explicit selection made after leave still wins, including a manual device.
  one.store.setConnectorSelection(person, other.hostId);
  assert.equal(one.msg("manual again").firstContactHost, undefined);
  assert.equal(one.msg("member's selected device", "group").firstContactHost, undefined);
  one.service.configureFirstContact({ groupScope: "conversation", connector: first });
  assert.equal(one.msg("shared group default", "group").firstContactHost, first);
  one.service.configureFirstContact({ groupScope: "member", connector: first });
  one.store.setConnectorSelection(person, first);
  assert.equal(one.msg("member's selected device", "group").replyTargetId, memberBinding("chat", "alice"));
  await one.service.handleMessage(one.msg("new after detach"));
  assert.notEqual(one.store.getBoundSession("chat")?.threadId, original.threadId);
  assert.equal(a.management.length, 2);

  const cold = new PeerRegistry(path.join(a.root, "server", "grants.json"));
  assert.equal(cold.isOnline(first), false);
  assert.equal(cold.unboundSessionPolicy(first), "create-when-unbound");
  assert.equal(cold.unboundSessionPolicy(other.hostId), "manual");
  assert.equal(cold.unboundSessionPolicy("peer:unrelated:work"), undefined);
  cold.close();
});

test("a managed Connector's native routes share the device policy; reconnecting without it clears the durable cache", async t => {
  const settings = { device: true, managedHost: "local", nativeHost: "remote", onUnbound: "create" as "create" | undefined };
  const peer = await peerFixture(t, settings);
  assert.equal(peer.registry.unboundSessionPolicy("local"), "create");
  assert.equal(peer.registry.unboundSessionPolicy("remote"), "create");
  settings.onUnbound = undefined;
  await peer.reconnect(true);
  assert.equal(peer.registry.unboundSessionPolicy("local"), undefined);
  assert.equal(peer.registry.unboundSessionPolicy("remote"), undefined);
  const cold = new PeerRegistry(path.join(peer.root, "server", "grants.json"), [peer.managed!]);
  assert.equal(cold.unboundSessionPolicy("local"), undefined);
  cold.close();
});
