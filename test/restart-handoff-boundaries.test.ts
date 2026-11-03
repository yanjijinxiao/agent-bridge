import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BridgeService } from "../src/bridge/service.js";
import { ChannelUserInputController } from "../src/bridge/user-input-controller.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("Bridge protects approval notice delivery, then permits restart while the native request awaits a human", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-approval-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gate = Promise.withResolvers<void>(); t.after(() => gate.resolve());
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const service = new BridgeService({ config: defaultConfig(root), stateStore: store,
    runner: {} as never, channel: createChannelClient("generic", TEXT_CAPABILITIES, {
      async sendText() { await gate.promise; return { messageId: "notice" }; }
    }) }); t.after(() => service.suspendUserInputs());
  const approval = service.requestApproval("room", { kind: "command", threadId: "thread", turnId: "turn", itemId: "item" });
  t.after(() => { (service as any).approvals.declineAll("room"); });
  assert.equal(service.hasRestartBlockingWork(), true, "actual outbound notice is protected");
  gate.resolve(); await tick();
  assert.equal(service.listApprovals().length, 1, "the original request remains actionable");
  assert.equal(service.hasRestartBlockingWork(), false, "waiting for a human is not live transfer");
  (service as any).approvals.declineAll("room"); await approval;
});

for (const kind of ["sync", "async"] as const) test(`${kind} questions protect sends, not human waiting, partial answers or durable native uncertainty`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-question-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let delivery = Promise.withResolvers<void>(); t.after(() => delivery.resolve());
  const controller = new ChannelUserInputController(async () => { await delivery.promise; return { messageId: "card" }; }, undefined,
    { filePath: path.join(root, "questions.json"), sendNotice: async () => { await delivery.promise; } });
  t.after(() => controller.close());
  const request = { kind, threadId: "thread", turnId: "turn", itemId: "item", requestId: 1, autoResolutionMs: null,
    questions: [{ id: "one", header: "One", question: "First?" }, { id: "two", header: "Two", question: "Second?" }] };
  const pending = controller.request("room", request);
  assert.equal(controller.hasRestartBlockingWork(), true, "initial card transfer is protected");
  delivery.resolve(); await tick();
  assert.equal(controller.hasRestartBlockingWork(), false, "waiting for a human never protects native execution");
  controller.answer("room", "Q1 first"); await tick();
  assert.equal(controller.hasRestartBlockingWork(), false, "a durable partial answer can be restored while waiting for its sibling");
  controller.answer("room", "Q2 second"); await pending; await tick();
  assert.equal(controller.hasRestartBlockingWork(), false, "native answer receipt waiting is distinct from transport flush");
  delivery = Promise.withResolvers<void>();
  const notice = controller.reportResult("room", request, "confirmed");
  await tick();
  assert.equal(controller.hasRestartBlockingWork(), true, "native resolution notice delivery is protected");
  delivery.resolve(); await notice;
  assert.equal(controller.hasRestartBlockingWork(), false);
});

test("an expired start RPC cannot permanently gate restart after a native completion arrived before its receipt", async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 50, transport: { command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url))], mode: "daemon-proxy" } });
  t.after(() => runner.close());
  await assert.rejects(runner.run({ cwd: "/tmp", prompt: "delayed-turn-receipt" }), { submission: "unconfirmed" });
  assert.equal(runner.hasRestartBlockingWork(), false, "unknown start identity is retained for reconciliation, not an infinite restart latch");
});

for(const boundary of ['follow-read','result-send'])test(`accepted Bridge execution protects the actual ${boundary} boundary`,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-accepted-drain-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new RuntimeStateStore(resolveStatePaths(root)),project=store.createProject('Fixture',root),session=store.createSession('actor',root,'Fixture',project.id);
 store.setSessionThread(session.id,'thread');
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),finished=Promise.withResolvers<void>(),accepted=Promise.withResolvers<void>();
 const service=new BridgeService({stateStore:store,config:{...defaultConfig(root),allowedSenderIds:['actor'],streamReplies:false},
  onTurnStarted:async()=>{accepted.resolve();if(boundary==='follow-read'){entered.resolve();await release.promise;}},
  channel:createChannelClient('generic',TEXT_CAPABILITIES,{async sendText(){entered.resolve();await release.promise;return {messageId:'result'};}}),
  runner:{isIndependentObservation(){return true;},async run(input){await input.onTurnStarted?.({threadId:'thread',turnId:'turn'});await finished.promise;return {threadId:'thread',turnId:'turn',text:'Confirmed result',raw:''};}} as never});
 const pending=service.handleMessage({id:'one',senderId:'actor',text:'Original task',raw:{}});
 try {
  await accepted.promise;
  if(boundary==='result-send'){assert.equal(service.hasRestartBlockingWork(),false);finished.resolve();}
  await entered.promise;
  assert.equal(service.hasRestartBlockingWork(),boundary==='result-send',boundary==='follow-read'?'a read-only follower cannot keep an accepted input critical':'the native task is independent, but this result send is still Gateway work');
 }finally{release.resolve();finished.resolve();await pending;}
 assert.equal(service.hasRestartBlockingWork(),false);
});

test("IN-03.3: a held final delivery does not block a new input to the same session", { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-final-input-overlap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)), project = store.createProject("Fixture", root);
  const session = store.createSession("actor", root, "Fixture", project.id); store.setSessionThread(session.id, "thread");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const inputs: string[] = [], delivered: string[] = [];
  const service = new BridgeService({ stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: false },
    channel: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText({ text }) {
      if (text === "result-1") { entered.resolve(); await release.promise; }
      delivered.push(text); return { messageId: `receipt-${text}` };
    } }),
    runner: { isIndependentObservation() { return true; }, async run(input) {
      inputs.push(input.prompt); const n = inputs.length;
      await input.onTurnStarted?.({ threadId: "thread", turnId: `turn-${n}` });
      if (n === 2) second.resolve();
      return { threadId: "thread", turnId: `turn-${n}`, text: `result-${n}`, raw: "" };
    } } as never });
  const first = service.handleMessage({ id: "source-1", senderId: "actor", text: "input-one", attachments: [], raw: {} });
  let next: Promise<void> | undefined;
  try {
    await entered.promise;
    assert.equal(service.hasRestartBlockingWork(), true, "actual outbound write remains protected");
    next = service.handleMessage({ id: "source-2", senderId: "actor", text: "input-two", attachments: [], raw: {} });
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([second.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("new input blocked on previous final delivery")), 1500); })]); }
    finally { clearTimeout(timer!); }
    await next; assert.equal(inputs.length, 2);
    assert.deepEqual(delivered, ["result-2"], "the old unresolved send is still pending");
    assert.equal(service.hasRestartBlockingWork(), true);
  } finally { release.resolve(); await Promise.allSettled([first, ...(next ? [next] : [])]); }
  assert.deepEqual(delivered, ["result-2", "result-1"]); assert.equal(inputs.length, 2);
  assert.equal(service.hasRestartBlockingWork(), false);
});
