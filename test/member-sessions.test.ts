import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountManager } from "../src/server/account-manager.js";
import type { ThreadEventHub } from "../src/server/thread-event-hub.js";
import { allowsUnboundSession, firstContactSchema, memberBinding, addressInbound, bindingRecipient } from "../src/channels/conversation-binding.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { loadAccount, publicAccount, setAccountSettings, saveAccount } from "../src/weixin/accounts.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { withBindingDelivery } from "../src/channels/binding-delivery.js";
import { DingTalkChannelAdapter, type DingTalkAICardCreateInput, type DingTalkAICardUpdateInput } from "../src/channels/dingtalk.js";
import { decodeDingTalkInbound } from "../src/channels/dingtalk-inbound.js";
import { TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import type { ChannelMessage } from "../src/channels/message.js";
import type { ChannelMonitorOptions } from "../src/channels/types.js";
import { peerPrincipal } from "../src/peer/context.js";
import { hostedSessionRequest } from "../src/peer/hosted-session.js";
import { message as modelMessage, sharedNativeCore, until } from "./fixtures/shared-native-core.mjs";
import { peerFixture } from "./peer-fixture.js";

const policy = { onUnbound: "create", groupScope: "member", connector: "local" } as const;
test("device policy takes precedence; old first-contact behavior applies only to the old default Connector", () => {
  for (const detached of [true, false]) {
    assert.equal(allowsUnboundSession(undefined, undefined, "local", detached), false);
    assert.equal(allowsUnboundSession("manual", policy, "local", detached), false);
    assert.equal(allowsUnboundSession(undefined, policy, "local", detached), !detached);
    assert.equal(allowsUnboundSession(undefined, policy, "other", detached), false);
    assert.equal(allowsUnboundSession("create-when-unbound", undefined, "other", detached), true);
  }
  assert.throws(() => firstContactSchema.parse({ ...policy, onUnbound: "create-when-unbound" }));
});
const message = (actor: string, chat: string, text: string, kind: "group" | "direct" = "group"): ChannelMessage => ({
  id: crypto.randomUUID(), text, senderId: actor, replyTargetId: chat, conversationKind: kind, attachments: [], raw: {}
});
test("only a verified group member gets a personal binding; literal provider addresses cannot impersonate it", () => {
  const m = message("a:[1]", "room,1", "hi");
  const address = addressInbound(m, policy).replyTargetId!;
  assert.equal(bindingRecipient(address), "room,1");
  assert.notEqual(address, memberBinding("room", "1,a:[1]"));
  assert.equal(addressInbound(m), m);
  assert.equal(addressInbound(m, {...policy, groupScope: "conversation"}), m);
  const dm = message("a", "dm:a", "hi", "direct");
  assert.equal(addressInbound(dm, policy), dm);
  assert.throws(() => addressInbound({...m, senderId: address}, policy));
  assert.throws(() => addressInbound({...m, senderId: "room,1"}, policy));
  assert.throws(() => addressInbound({...m, conversationKind: undefined}, policy));
  assert.throws(() => bindingRecipient("im-member:v1:[]"));
  assert.throws(() => firstContactSchema.parse({...policy, connector: ""}));
});

test("every outbound transport receives the real chat; reference resolution restores the frozen member identity", async () => {
  const received: unknown[] = [], proxy = new Proxy({}, { get: (_target, key) => (input: unknown) => {
    received.push(input);
    return key === "resolveReferences" ? {...input as object,text:"resolved"} : undefined;
  }});
  const scoped = withBindingDelivery(proxy as never), address = memberBinding("room","alice");
  for (const method of ["sendText","sendMedia","sendTyping","sendActionCard","sendTaskCard","sendMentionNotification",
    "sendProgressText","startTextStream","updateTextStream"] as const) {
    const payload = {toUserId:address,text:"payload", other:"unchanged"};
    await scoped[method](payload as never);
    assert.deepEqual(received.pop(),{...payload,toUserId:"room"});
    assert.equal(payload.toUserId,address);
  }
  for (const method of ["conversationIdentity","deliveryRouteStatus"] as const) {
    scoped[method](address); assert.equal(received.pop(),"room");
  }
  const original = {...message("alice","room","quoted"),replyTargetId:address};
  await scoped.resolveAttachments({...original,senderId:address});
  assert.deepEqual(received.pop(),{...original,senderId:"room",replyTargetId:"room"});
  assert.deepEqual(await scoped.resolveReferences(original),{...original,text:"resolved"});
  assert.deepEqual(received.pop(),{...original,replyTargetId:"room"});
  const saved = {version:1 as const,instanceId:"card",stage:"created" as const,recipientId:address};
  const resumed = {toUserId:address,text:"resume",streamId:"card",bootstrap:saved,onBootstrap:(state: typeof saved) => {
    assert.deepEqual(state,saved);
  }};
  await scoped.resumeTextStream(resumed as never);
  const wire = received.pop() as typeof resumed;
  assert.equal(wire.toUserId,"room"); assert.equal(wire.bootstrap.recipientId,"room");
  wire.onBootstrap(wire.bootstrap);
  assert.throws(() => wire.onBootstrap({...wire.bootstrap,recipientId:"other room"}),/provider recipient/);
  assert.throws(() => scoped.resumeTextStream({...resumed,toUserId:memberBinding("room","bob")} as never),/binding recipient/);
});

test("a creation receipt survives restart; manual rebind and detach supersede an automatic origin", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "member-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root), s = new RuntimeStateStore(paths), key = memberBinding("g", "a");
  const ticket = s.reserveFirstContact(key, "local", "a"), after = new RuntimeStateStore(paths);
  assert.deepEqual(after.reserveFirstContact(key, "local", "a"), ticket);
  const created = after.createSession(key, root, "默认会话", undefined, "session", undefined,
    { firstContact: { threadId: "thread", generation: ticket.id }, standalone: true, hostId: "local" });
  assert.equal(after.firstContactReservation(key), undefined);
  assert.equal(new RuntimeStateStore(paths).getBoundSession(key)?.executionGeneration, ticket.id);
  assert.equal(created.createdByFirstContact, true);
  after.leaveSession(key);
  assert.equal(after.isSessionDetached(key), true);
  assert.equal(after.activateSession(created.id).explicitlySelected, true);
});

test("a failed first-contact save cannot authorize native creation and corrupt receipts are preserved", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "member-ticket-"));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const paths = resolveStatePaths(root), state = new RuntimeStateStore(paths);
  const key = memberBinding("room", "person");
  const write = t.mock.method(state,"save",() => { throw Error("fixture storage failure"); });
  assert.throws(() => state.reserveFirstContact(key,"local","person"),/storage failure/);
  assert.equal(state.firstContactReservation(key),undefined);
  write.mock.restore();
  state.reserveFirstContact(key,"local","person");
  const old = JSON.parse(fs.readFileSync(paths.statePath,"utf8"));
  old.firstContacts[key].id = "damaged";
  const corrupt = JSON.stringify(old);
  fs.writeFileSync(paths.statePath,corrupt);
  assert.throws(() => new RuntimeStateStore(paths),/Invalid first contact/);
  assert.equal(fs.readFileSync(paths.statePath,"utf8"),corrupt);
});

// Exercise the production account monitor, pre-ack claim, receipt journal, binding
// store, BridgeService and outbound channel. Only IM transport and native replies are fixtures.
for (const variant of ["existing managed","first-contact-only","native core"] as const) test(
  `group members on ${variant} Connector submit concurrently, resume after restart and deliver to the real group`,
  { skip: variant === "native core" && !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 90000 }, async t => {
  const firstContactOnly = variant === "existing managed" ? undefined : true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "member-ingress-")), paths = resolveStatePaths(root);
  saveAccount(paths, { accountId: "ding", channel: "dingtalk", clientId: "bot", clientSecret: "fixture", enabled: false, firstContact: policy });
  const state = () => new RuntimeStateStore(accountStatePaths(paths, "ding"));
  const device: { device: true; managedHost: string; firstContactOnly?: true; onUnbound?: "manual" | "create" | "create-when-unbound" } = { device: true, managedHost: "local", firstContactOnly };
  const peer = await peerFixture(t, device);
  const setDeviceMode = async (mode: typeof device.onUnbound) => {
    device.onUnbound = mode;
    await peer.reconnect(true);
    assert.equal(peer.registry.unboundSessionPolicy("local"), mode);
  };
  assert.equal(peer.registry.supportsFirstContact("local"),true);
  assert.equal(peer.registry.supportsFirstContact("missing"),undefined);
  const core = variant === "native core" ? await sharedNativeCore(t) : undefined;
  if (core) {
    const runner = core.runner();
    peer.backend.createThread = async input => {
      const result = await runner.createThread(input);
      peer.management.push({method:"create", threadId:result.threadId});
      return result;
    };
    peer.backend.inspectThread = id => runner.inspectThread(id);
    peer.backend.readThreadSnapshot = id => runner.readThreadSnapshot(id);
    peer.run = input => runner.run(input);
  }
  let monitor: ChannelMonitorOptions;
  const deliveries: string[] = [], replies: string[] = [];
  const approved = Promise.withResolvers<void>(), asked = Promise.withResolvers<void>();
  const manager = () => new AccountManager({ paths, peerRegistry: peer.registry, configProvider: () => ({...defaultConfig(root),
    allowedSenderIds: ["a","b"], streamReplies: false, taskboardEnabled: false}), runnerFactory: () => peer.backend,
    channelCapabilities: () => [], adapterFactory: () => ({ client: createChannelClient("dingtalk", TEXT_CAPABILITIES, {
      async sendText(m) { deliveries.push(m.toUserId); replies.push(m.text);
        if (m.text.includes("/approve A")) approved.resolve();
        if (m.text.includes("/answer Q")) asked.resolve();
        return {messageId: crypto.randomUUID()}; } }), async monitor(opts) {
      monitor = opts; opts.onStatus?.({state: "connected"});
      await new Promise<void>(done => opts.signal?.addEventListener("abort", () => done(), {once: true}));
    }}), codexSessionMonitorFactory: () => ({start() {}, async stop() {}}) as never,
    codexDesktopRequestMonitorFactory: () => ({ start() {}, stop() {}, setFollowedThreads() {} }) as never });
  let app = manager();
  t.after(async () => { await app.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const send = (m: ChannelMessage) => { assert.equal(monitor.claimMessage!(m), true); return monitor.onMessage(m); };
  await app.startAccount("ding", false);
  await send(message("a","g","/help")); assert.equal(peer.management.length, 0);
  await send(message("visitor","g","未准入")); assert.equal(peer.management.length, 0);
  const quoteOnly = (actor: string, quotedActor: string): ChannelMessage => ({
    ...message(actor, "g", ""),
    ...decodeDingTalkInbound({ msgtype: "text", text: { content: "", repliedMsg: {
      msgId: "quoted-original", msgType: "text", senderId: quotedActor, text: { content: "/stop MEMBER_A_TEST_INPUT" }
    } } })
  });
  await send(message("a", "g", ""));
  await send(quoteOnly("visitor", "a"));
  assert.equal(peer.management.length, 0);
  assert.equal(peer.runs.length, 0);
  const first = quoteOnly("a", "visitor");
  await Promise.all([send(first), send(message("b","g","MEMBER_B_TEST_INPUT"))]);
  assert.equal(monitor!.claimMessage!(first), false);
  assert.equal(peer.management.length, 2); assert.equal(peer.runs.length, 2);
  const a = state().getBoundSession(memberBinding("g","a"))!, b = state().getBoundSession(memberBinding("g","b"))!;
  assert.notEqual(a.threadId, b.threadId); assert.equal(a.createdByFirstContact, true);
  assert.ok(peer.runs.find(run => run.threadId === a.threadId)?.prompt.includes("/stop MEMBER_A_TEST_INPUT"));
  assert.equal(peer.stops.length, 0);
  assert.deepEqual(peer.runs.map(run => run.threadId).sort(), [a.threadId, b.threadId].sort());
  if (firstContactOnly) {
    assert.deepEqual(peer.registry.managedHosts(), []);
    const person = {accountId: "ding", conversationId: "g", actorId: "a"};
    await peerPrincipal.run(person, async () => {
      assert.equal((await peer.facade.inspectThread(a.threadId!, "local")).threadId, a.threadId);
      await assert.rejects(peer.facade.inspectThread(b.threadId!, "local"), /自己的默认会话/);
      await assert.rejects(peer.facade.listProjects("local"), /自己的默认会话/);
      await assert.rejects(peer.facade.createThread!({standalone: true, clientUserMessageId: crypto.randomUUID()}, "local"), /自己的默认会话/);
    });
    assert.equal(peer.registry.canAccessIDE("local", { accountId: "ding", threadId: a.threadId!, subject: { principal: person } } as never), false);
  }
  assert.ok(deliveries.length && deliveries.every(chat => chat === "g"));
  await app.stopAll(); app = manager(); await app.startAccount("ding", false);
  await send(message("a","g","继续")); assert.equal(peer.runs.at(-1)?.threadId, a.threadId);
  await send(message("a","g2","另一群")); await send(message("a","dm-a","私聊","direct"));
  assert.equal(peer.management.length, 4);
  // A refresh from the DM also reads both group subscriptions. Every active
  // source must remain healthy after that cross-member refresh completes.
  const { threadEvents } = app as unknown as { threadEvents: ThreadEventHub };
  const statuses = await peerPrincipal.run({accountId:"ding",conversationId:"dm-a",actorId:"a"}, () =>
    Promise.all([a, b].map(session => threadEvents.synchronize(JSON.stringify(["ding", session.id])))));
  for (const status of statuses) assert.equal(status.status, "synced", JSON.stringify(status));
  if (core) {
    for (const [own, other, threadId] of [["A","B",a.threadId!], ["B","A",b.threadId!]]) {
      const history = JSON.stringify(await core.runner().getHistory(threadId));
      assert.ok(history.includes("MEMBER_" + own + "_TEST_INPUT"));
      assert.ok(!history.includes("MEMBER_" + other + "_TEST_INPUT"));
    }
    await setDeviceMode("create-when-unbound");
    const dmBefore = state().getBoundSession("dm-a")!;
    // Restore the production shape: an existing DM with a retired private
    // Connector. The IM command must reset only this person's scoped choice.
    await app.stopAll();
    const dmPrincipal = { accountId: "ding", conversationId: "dm-a", actorId: "a" };
    state().setConnectorSelection(dmPrincipal, "peer:retired:default");
    app = manager(); await app.startAccount("ding", false);
    await send(message("a", "dm-a", "/leave", "direct"));
    assert.equal(state().getConnectorSelection(dmPrincipal)?.hostId, undefined);
    assert.match(replies.at(-1)!, /下一条普通消息/);
    await app.stopAll(); app = manager(); await app.startAccount("ding", false);
    await send(message("a", "dm-a", "/status", "direct"));
    assert.equal(state().getBoundSession("dm-a"), undefined);
    const input = message("a", "dm-a", "AFTER_UNBIND_NEW", "direct");
    await send(input); assert.equal(monitor.claimMessage!(input), false);
    const fresh = state().getBoundSession("dm-a")!;
    assert.notEqual(fresh.threadId, dmBefore.threadId);
    await send(message("a", "dm-a", "AFTER_UNBIND_CONTINUE", "direct"));
    const history = JSON.stringify(await core.runner().getHistory(fresh.threadId!));
    assert.match(history, /AFTER_UNBIND_NEW/); assert.match(history, /AFTER_UNBIND_CONTINUE/);
    assert.doesNotMatch(JSON.stringify(await core.runner().getHistory(dmBefore.threadId!)), /AFTER_UNBIND/);
    assert.equal(peer.management.length, 5);
    return;
  }
  await send(message("a","g","/stream off"));
  assert.equal(state().getSession(a.id)?.streamReplies,false);
  assert.equal(state().getSession(b.id)?.streamReplies,undefined);
  await send(message("a","g","/prompt start"));
  const unbuffered = peer.runs.length;
  await send(message("a","g","ONLY_A_DRAFT")); assert.equal(peer.runs.length,unbuffered);
  await send(message("b","g","ONLY_B_PLAIN"));
  assert.equal(peer.runs.at(-1)?.threadId,b.threadId);
  assert.doesNotMatch(peer.runs.at(-1)!.prompt,/ONLY_A_DRAFT/);
  await send(message("a","g","/prompt done"));
  assert.equal(peer.runs.at(-1)?.threadId,a.threadId);
  assert.match(peer.runs.at(-1)!.prompt,/ONLY_A_DRAFT/);
  assert.doesNotMatch(peer.runs.at(-1)!.prompt,/ONLY_B_PLAIN/);
  // Both platform claims precede either dispatch. Their creation receipts
  // must coalesce, while their two distinct native inputs remain ordered.
  const one = message("a", "rapid", "rapid-first"), two = message("a", "rapid", "rapid-second");
  const count = peer.runs.length;
  for (const m of [one, two]) assert.equal(monitor.claimMessage!(m), true);
  await Promise.all([monitor.onMessage(one), monitor.onMessage(two)]);
  await until(() => peer.runs.length === count + 2);
  const rapid = state().getBoundSession(memberBinding("rapid","a"))!;
  assert.equal(peer.management.length, 5);
  assert.deepEqual(peer.runs.slice(count).map(run => run.threadId), [rapid.threadId, rapid.threadId]);
  assert.match(peer.runs[count].prompt, /rapid-first/);
  assert.match(peer.runs[count + 1].prompt, /rapid-second/);
  // Both controllers see the group notice. The native reply belongs exclusively
  // to the sender's personal lane, even when another member knows the number.
  peer.run = async input => {
    const threadId = input.threadId!, turnId = "test-questions";
    await input.onTurnStarted?.({threadId, turnId});
    const request = {threadId, turnId, itemId:"approve", kind:"command" as const, command:"pwd"};
    assert.equal(await input.onApproval?.(request), "accept");
    await input.onApprovalResult?.(request,"confirmed");
    const prompt = {threadId, turnId, itemId:"question", questions:[{id:"q",header:"选项",question:"选哪个？"}]};
    assert.deepEqual(await input.onUserInput?.(prompt), { q:{answers:["mine"]} });
    await input.onUserInputResult?.(prompt,"confirmed");
    return {text:"交互已确认",threadId,turnId,raw:""};
  };
  const task = send(message("a","g","验证互动"));
  const waitFor = async (signal: Promise<void>) => {
    const controller = new AbortController();
    try { await Promise.race([signal, task.then(() => { throw Error("任务提前结束"); }),
      import("node:timers/promises").then(({setTimeout}) => setTimeout(10000, null, {signal:controller.signal})).then(() => { throw Error("未收到互动提示"); })]); }
    finally { controller.abort(); }
  };
  await waitFor(approved.promise);
  const approvalId = replies.join("\n").match(/\/approve (A\d+)/)![1];
  await send(message("b","g","/stop")); assert.ok(!peer.stops.includes(a.threadId!));
  await send(message("b","g","/approve " + approvalId));
  // A ticket posted under the previous policy keeps its original recipient.
  app.updateAccount("ding",{displayName:"探探",firstContact:{...policy,groupScope:"conversation"}});
  await send(message("a","g","/approve " + approvalId));
  await waitFor(asked.promise);
  const questionId = replies.join("\n").match(/\/answer (Q\d+)/)![1];
  await send(message("b","g","/answer " + questionId + " other"));
  await send(message("a","g","/answer " + questionId + " mine"));
  await task;
  app.updateAccount("ding",{displayName:"探探",firstContact:policy});
  await setDeviceMode("create");
  await send(message("a","g","/unbind")); await send(message("a","g","解绑后"));
  assert.equal(peer.management.length, 5); assert.equal(state().getBoundSession(memberBinding("g","a")), undefined);
  await setDeviceMode(undefined);
  assert.equal(state().getBoundSession(memberBinding("g","b"))?.threadId, b.threadId);
  // An account policy edit affects new messages, while the accepted histories
  // and stored personal mappings stay intact when switching back.
  app.updateAccount("ding", {displayName:"探探", firstContact:{...policy, groupScope:"conversation"}});
  const sharedStart = peer.runs.length;
  const sharedA = message("a","shared","first shared"), sharedB = message("b","shared","second shared");
  for (const m of [sharedA, sharedB]) assert.equal(monitor.claimMessage!(m), true);
  peer.run = async input => ({text:"ok",threadId:input.threadId!,turnId:crypto.randomUUID(),raw:""});
  await Promise.all([monitor.onMessage(sharedA), monitor.onMessage(sharedB)]);
  await until(() => peer.runs.length === sharedStart + 2);
  const shared = state().getBoundSession("shared")!;
  assert.ok(shared.threadId);
  assert.deepEqual(peer.runs.slice(sharedStart).map(run => run.threadId), [shared.threadId, shared.threadId]);
  app.updateAccount("ding", {displayName:"探探", firstContact:{onUnbound:"manual", groupScope:"member"}});
  await send(message("a","new-room","manual only")); assert.equal(peer.management.length,6);
  assert.equal(state().getBoundSession(memberBinding("g","b"))?.id,b.id);
  app.updateAccount("ding",{displayName:"探探",firstContact:policy});
  assert.equal(monitor.claimMessage!(sharedA),false);
  assert.equal(state().firstContactReservation(memberBinding("shared","a")),undefined);
  const stale = message("a","changed","旧目标");
  assert.equal(monitor.claimMessage!(stale),true);
  app.updateAccount("ding",{displayName:"探探",firstContact:{onUnbound:"manual",groupScope:"conversation"}});
  await assert.rejects(monitor.onMessage(stale),/改变|核对/);
  assert.equal(peer.management.length,6);
  assert.equal(state().getBoundSession("changed"),undefined);
  app.updateAccount("ding",{displayName:"探探",firstContact:policy});
  const offline = t.mock.method(peer.registry,"isOnline",() => false);
  await send(message("b","offline","等待原设备"));
  assert.equal(peer.management.length,6);
  assert.ok(state().firstContactReservation(memberBinding("offline","b")));
  offline.mock.restore();
  await until(() => peer.runs.at(-1)?.prompt.includes("等待原设备"));
  assert.equal(peer.management.length,7);
  assert.equal(peer.runs.at(-1)?.threadId,state().getBoundSession(memberBinding("offline","b"))?.threadId);

  await setDeviceMode("create-when-unbound");
  const address = memberBinding("g", "a");
  await send(message("a", "g", "/help")); assert.equal(state().firstContactReservation(address), undefined);
  const staleInput = message("a", "g", "STALE_AFTER_DETACH");
  assert.equal(monitor.claimMessage!(staleInput), true);
  await send(message("a", "g", "/unbind"));
  await assert.rejects(monitor.onMessage(staleInput), /改变|核对/);
  const downgraded = message("a", "g", "POLICY_CHANGED");
  assert.equal(monitor.claimMessage!(downgraded), true);
  await setDeviceMode("manual");
  await assert.rejects(monitor.onMessage(downgraded), /改变|核对/);
  assert.equal(peer.management.length, 7);
  await setDeviceMode("create-when-unbound");
  const afterDetach = [message("a", "g", "fresh first"), message("a", "g", "fresh second")];
  for (const m of afterDetach) assert.equal(monitor.claimMessage!(m), true);
  const runsBeforeRecreate = peer.runs.length;
  await Promise.all(afterDetach.map(m => monitor.onMessage(m)));
  await until(() => peer.runs.length === runsBeforeRecreate + 2);
  const fresh = state().getBoundSession(address)!;
  assert.equal(peer.management.length, 8); assert.notEqual(fresh.threadId, a.threadId);
  assert.deepEqual(peer.runs.slice(runsBeforeRecreate).map(run => run.threadId), [fresh.threadId, fresh.threadId]);
  assert.equal(state().getBoundSession(memberBinding("g","b"))?.threadId, b.threadId);
});


test("dedicated hosting defaults to deny for device-wide and future methods and binds create to an exact ticket", () => {
  for (const method of ["listSkills", "serverIdentity", "runEphemeral", "listSessionCatalog", "future-method"])
    assert.equal(hostedSessionRequest(method, ["thread"]), undefined);
  assert.deepEqual(hostedSessionRequest("getRuntimeInfo", ["/workspace","owned"]), {threadId:"owned"});
  assert.deepEqual(hostedSessionRequest("run", [{threadId:"owned"}]), {threadId:"owned"});
  assert.deepEqual(hostedSessionRequest("createThread", [{standalone:true, clientUserMessageId:"t"}]), {reservationId:"t"});
  for (const input of [null, {standalone:false}, {standalone:true, clientUserMessageId:"t", cwd:"/other"}])
    assert.equal(hostedSessionRequest("createThread", [input]), undefined);
});

test("a Connector restricted to one existing session is not offered for first contact", async t => {
  const f = await peerFixture(t);
  assert.equal(f.registry.supportsFirstContact(f.ticket.hostId),false);
  assert.equal(f.registry.status().routes.find(route => route.hostId === f.ticket.hostId)?.supportsFirstContact,false);
});

test("DingTalk group callbacks produce per-member running cards and directed final cards through native Codex", {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout:90000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"member-cards-")), paths = resolveStatePaths(root);
  saveAccount(paths,{accountId:"bot",channel:"dingtalk",clientId:"robot",clientSecret:"test",cardTemplateId:"fixture",
    enabled:false,firstContact:policy});
  const peer = await peerFixture(t,{device:true,managedHost:"local",firstContactOnly:true});
  const native = await sharedNativeCore(t, (body: unknown, n: number) =>
    modelMessage(JSON.stringify(body).includes("ALICE_TEST_TEXT") ? "ALICE_RESULT" : "BOB_RESULT",n));
  const runner = native.runner();
  peer.backend.createThread = input => runner.createThread(input);
  peer.backend.inspectThread = id => runner.inspectThread(id);
  peer.backend.readThreadSnapshot = id => runner.readThreadSnapshot(id);
  peer.run = input => runner.run(input);
  let inbound!: (frame: DWClientDownStream) => void;
  const created: DingTalkAICardCreateInput[] = [], updates: DingTalkAICardUpdateInput[] = [];
  const errors: string[] = [];
  const app = new AccountManager({paths,peerRegistry:peer.registry,runnerFactory:() => peer.backend,
    configProvider:() => ({...defaultConfig(root),allowedSenderIds:["alice","bob"],streamReplies:true,taskboardEnabled:false}),
    adapterFactory:(account, options) => new DingTalkChannelAdapter(account as import("../src/weixin/accounts.js").DingTalkAccount,{...options,
      streamClient:{registerCallbackListener(_topic, cb) { inbound = cb; },async connect() {},disconnect() {},off() {},
        socketCallBackResponse() {},async getAccessToken() { return "fixture"; }},
      emotionClient:{async reply() {},async recall() {}},
      webhookSender: async input => {errors.push(String(input.text));return {messageId:crypto.randomUUID()};},
      cardClient:{async create(input) { created.push(input); for (const stage of ["created","delivery-pending","delivered"] as const) input.onStage?.(stage); },
        async deliver() {},async update(input) {updates.push(input);}}
    }),
    codexSessionMonitorFactory:() => ({start() {},async stop() {}}) as never,
    codexDesktopRequestMonitorFactory:() => ({start() {},stop() {},setFollowedThreads() {}}) as never
  });
  try {
    await app.startAccount("bot",false);
    for (const actor of ["alice","bob"]) {
      const id = "group-source-" + actor;
      inbound({specVersion:"1.0",type:"CALLBACK",headers:{appId:"robot",connectionId:"test",contentType:"application/json",
        messageId:id,time:"0",topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,msgtype:"text",text:{content:actor.toUpperCase()+"_TEST_TEXT"},
        conversationId:"real-room",conversationType:"2",senderStaffId:actor,senderNick:actor,robotCode:"robot",
        sessionWebhook:"https://oapi.dingtalk.com/robot/sendBySession?session=fixture",sessionWebhookExpiredTime:Date.now()+60000})} as DWClientDownStream);
    }
    await until(() => created.filter(card => card.atUserIds && card.text.includes("**已完成**")).length === 2,30000);
    const store = new RuntimeStateStore(accountStatePaths(paths,"bot"));
    for (const actor of ["alice","bob"]) {
      const session = store.getBoundSession(memberBinding("real-room",actor))!;
      const suffix = "默认会话 " + session.threadId!.slice(-8) + " · 我的笔记本";
      const progress = created.find(card => card.text.includes("**进行中**") && card.text.includes(suffix));
      assert.deepEqual(progress?.target,{type:"group",conversationId:"real-room"});
      assert.ok(updates.some(input => input.outTrackId === progress!.outTrackId && input.finalize));
      const final = created.find(card => card.atUserIds?.[actor] && card.text.includes("**已完成**"));
      assert.equal(Object.keys(final!.atUserIds!).join(","),actor);
      assert.ok(final!.text.includes(suffix) && final!.text.includes(actor.toUpperCase()+"_RESULT"));
      assert.deepEqual(final!.target,progress!.target);
    }
    assert.ok(!errors.some(text => text.includes("处理失败")));
  } finally { await app.stopAll(); fs.rmSync(root,{recursive:true,force:true}); }
});

test("account settings preserve opt-in, reject a missing default and expose no bot secret", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "member-settings-")), paths = resolveStatePaths(root);
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  saveAccount(paths,{accountId:"account",channel:"dingtalk",clientId:"bot",clientSecret:"fixture-value",enabled:false});
  assert.equal("firstContact" in loadAccount(paths,"account")!, false);
  setAccountSettings(paths,"account",{displayName:"探探",firstContact:policy});
  const saved = setAccountSettings(paths,"account",{displayName:"探探"});
  assert.deepEqual((publicAccount(saved) as any).firstContact, policy);
  assert.equal("clientSecret" in publicAccount(saved),false);
  assert.throws(() => setAccountSettings(paths,"account",{displayName:"探探",firstContact:{...policy,connector:""}}));
  assert.deepEqual((loadAccount(paths,"account") as any).firstContact,policy);
});
