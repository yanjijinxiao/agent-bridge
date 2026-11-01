import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES, type CodexRunnerInput, type CodexThreadState } from "../src/codex/backend.js";
import { DesktopCodexRunner } from "../src/codex/desktop-runner.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { ThreadEventHub } from "../src/server/thread-event-hub.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

async function fixture(t: test.TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-native-session-'));
  const state:CodexThreadState={threadId:'original-thread',persistence:'active',runtimeStatus:'notLoaded',activeFlags:[],cwd:root,title:'Original session'};
  const runs:CodexRunnerInput[]=[];let failure:Error|undefined;
  const app={id:'app-server',capabilities:APP_SERVER_BACKEND_CAPABILITIES,
    async inspectThread(){if(failure)throw failure;return {...state};},
    async readThreadSnapshot(){if(failure)throw failure;return {state:{...state},turns:[]};},
    async getHistoryPage(){return {messages:[]};},async getRuntimeInfo(){return {};},
    async run(input:CodexRunnerInput){runs.push(input);if(failure)throw failure;
      assert.equal(input.threadId,'original-thread');await input.onTurnStarted?.({threadId:input.threadId,turnId:'continued-turn'});
      return {threadId:input.threadId,turnId:'continued-turn',text:'continued the original session',raw:''};},close(){}};
  const router=new CodexBackendRouter({appServerBackend:app as never});
  t.after(async()=>{await router.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,router,runs,state,methods:[] as string[],available(){state.runtimeStatus='idle';},fail(value?:Error){failure=value;}};
}

for (const channel of ["dingtalk", "weixin", "feishu"] as const) {
  test(`${channel}: a persisted unloaded binding survives sync and ordinary messages continue the same session`, async t => {
    const f = await fixture(t);
    const paths = resolveStatePaths(path.join(f.root, "gateway"));
    const before = new RuntimeStateStore(paths);
    const session = before.createSession("group", f.root, "Original session", undefined, "session", undefined,
      { standalone: true, hostId: "local" });
    before.setSessionThread(session.id, "original-thread");
    before.setSessionFollow(session.id, true);
    const store = new RuntimeStateStore(paths); // Gateway restart must retain the exact binding.
    const texts: string[] = [];
    const client = createChannelClient(channel, TEXT_CAPABILITIES, {
      async sendText(input) { texts.push(input.text); return { messageId: String(texts.length) }; }
    });
    const hub = new ThreadEventHub({ filePath: path.join(f.root, "follow.json"), backend: () => f.router,
      subscriptions: () => [{ key: session.id, hostId: "local", threadId: "original-thread", recipientId: "group", client, managed: false }] });
    t.after(() => hub.stop());
    const bridge = new BridgeService({ stateStore: store,
      config: { ...defaultConfig(f.root), allowedSenderIds: ["actor"], streamReplies: false },
      channel: client, runner: f.router,
      sessionFollow: { status: () => hub.status(session.id), synchronize: () => hub.synchronize(session.id) }
    });
    let sequence = 0;
    const send = (text: string) => bridge.handleMessage({ id: String(++sequence), senderId: "actor",
      replyTargetId: "group", text, raw: {}, attachments: [] });
    await send("/follow sync");
    assert.equal(hub.status(session.id).status, "unconfirmed", "a storage snapshot is not a confirmed live writer");
    assert.equal(f.runs.length, 0, "sync cannot load, resume or start a turn");
    assert.equal(store.getActiveSession("group")?.id, session.id);
    await send("Continue this existing session");
    assert.equal(f.runs.length, 1);
    assert.equal(f.runs[0].hostId, "local");
    assert.equal(f.runs[0].cwd, f.root);
    assert.equal(store.getActiveSession("group")?.id, session.id);
    assert.equal(store.getActiveSession("group")?.threadId, "original-thread");
    assert.equal(store.getActiveSession("group")?.follow, true);
    assert.ok(texts.includes("continued the original session"));
    assert.ok(!f.methods.includes("thread-follower-start-turn"));
    f.available();
    await hub.refresh();
    assert.equal(hub.status(session.id).status, "synced", "the retained subscription recovers when a live owner reappears");
    assert.equal(f.runs.length, 1, "background recovery is read-only");
    await send("/session original-thread --host local");
    assert.equal(store.getActiveSession("group")?.id, session.id, "reselection reuses the same binding");
    assert.equal(f.runs.length, 1);
  });
}


test('an unloaded native session continues without a UI owner discovery or another thread',async t=>{
 const f=await fixture(t);assert.equal((await f.router.inspectThread('original-thread')).runtimeStatus,'notLoaded');
 assert.equal((await f.router.run({threadId:'original-thread',cwd:f.root,prompt:'ordinary'})).threadId,'original-thread');assert.equal(f.runs.length,1);
});

for(const failure of [new Error('thread already has an active writer'),new CodexCommunicationError('submission','turn/start','original-thread'),
 new CodexCommunicationError('observation','turn/observe','original-thread','accepted')])test(`native ${failure.message} does not authorize replay or a replacement session`,async t=>{
 const f=await fixture(t);f.fail(failure);await assert.rejects(f.router.run({threadId:'original-thread',cwd:f.root,prompt:'once'}));assert.equal(f.runs.length,1);
});

test('permission and timeout failures remain unknown observations without resuming a task',async t=>{
 const f=await fixture(t);for(const error of [new Error('permission denied'),new CodexCommunicationError('preflight','thread/read','original-thread')]){
 f.fail(error);await assert.rejects(f.router.inspectThread('original-thread'));}assert.equal(f.runs.length,0);
});
