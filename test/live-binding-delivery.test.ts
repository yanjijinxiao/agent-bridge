import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { message, sharedNativeCore } from "./fixtures/shared-native-core.mjs";

const native = { skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30000 };

for (const standalone of [true, false]) {
  test(`a real native ${standalone ? "independent" : "project"} thread continues after legacy project drift without widening its roles`, native, async t => {
    const core = await sharedNativeCore(t);
    const runner = new CodexAppServerGateway({appServerBackend:core.runner()});
    t.after(() => runner.close());
    const input = await runner.run({cwd:core.root, prompt:"seed thread",
      ...(standalone ? {} : {projectName:"Native project", projectRoots:[core.root]})});
    const paths = resolveStatePaths(path.join(core.root,"gateway"));
    const state = new RuntimeStateStore(paths);
    const project = state.createProject("Original",core.root);
    const other = state.createProject("Other",path.join(core.root,"unused"));
    const session = state.createSession("actor",core.root,"Bound thread",standalone ? undefined : project.id,"session",undefined,{standalone});
    state.setSessionThread(session.id,input.threadId!);
    state.setRole("actor","other-member","viewer");
    const saved=state.snapshot; saved.activeProjectIds.actor=other.id;
    fs.writeFileSync(paths.statePath,JSON.stringify(saved));
    const restored=new RuntimeStateStore(paths);
    const bridge=new BridgeService({stateStore:restored,runner,
      config:{...defaultConfig(core.root),allowedSenderIds:["actor"],streamReplies:false},
      channel:createChannelClient("generic",TEXT_CAPABILITIES,{async sendText(){return {messageId:"reply"};}})});
    await bridge.handleMessage({id:"follow",senderId:"actor",text:"continue after drift",raw:{}});
    const current=new RuntimeStateStore(paths);
    assert.equal(current.getBoundSession("actor")?.threadId,input.threadId);
    assert.notEqual(current.getActiveProject("actor")?.id,other.id);
    assert.deepEqual(current.snapshot.conversationRoles, saved.conversationRoles);
    assert.equal(current.roleFor("actor","other-member"),"viewer");
    assert.equal(core.calls.length,2);
    const history=await runner.getHistory(input.threadId!);
    assert.equal(history.filter(m=>m.role==="user" && m.text.includes("continue after drift")).length,1);
  });
}

test("a failed channel delivery can resume the completed native turn with the original reply exactly once",native, async t=>{
  const core=await sharedNativeCore(t,()=>message("unique native result"));
  const runner=new CodexAppServerGateway({appServerBackend:core.runner()});
  t.after(()=>runner.close());
  const result=await runner.run({cwd:core.root,prompt:"prepare delivery"});
  const threadId=result.threadId!, turnId=result.turnId!;
  let fail=true; const delivered:string[]=[];
  const sub:ThreadSubscription={key:"fixture-binding",hostId:"local",threadId,recipientId:"room",managed:false,
    client:{resumableTextStream:true, async sendText(){return {messageId:"notice"};},
      async startTextStream(input){if(fail)throw Error("fixture channel offline");return {messageId:input.streamId!};},
      async updateTextStream(input){if(fail)throw Error("fixture channel offline");if(input.finalize)delivered.push(input.text);}
    }};
  const open=()=>new ThreadEventHub({filePath:path.join(core.root,"delivery-state.json"),subscriptions:()=>[sub],backend:()=>runner});
  const hub=open();
  await hub.started("local",threadId,turnId,new Date().toISOString());
  await hub.completion("local",threadId,turnId,result.text);
  const blocked=await hub.synchronize(sub.key);
  assert.equal(blocked.resultDelivery?.pending,1);
  assert.equal((await runner.readTurnLifecycle(threadId,turnId)).status,"completed");
  fail=false;
  const resumed=open();
  await resumed.synchronize(sub.key);await resumed.synchronize(sub.key);
  assert.equal(delivered.length,1);
  assert.match(delivered[0],/unique native result/);
  assert.equal((await runner.readTurnLifecycle(threadId,turnId)).status,"completed");
  assert.equal(core.calls.length,1);
});

test("a native project thread and its original history survive worker death after archive and during compensation", native, async t=>{
  const {spawn}=await import("node:child_process");
  const {fileURLToPath}=await import("node:url");
  const core=await sharedNativeCore(t);
  const runner=core.runner();
  const result=await runner.run({cwd:core.root,prompt:"preserve this archived source",projectName:"Archive project",projectRoots:[core.root]});
  const {threadId,turnId}=result;
  const before=await runner.inspectThread(threadId);
  assert.ok(before.projectId);
  const paths=resolveStatePaths(path.join(core.root,"bindings"));
  const store=new RuntimeStateStore(paths);
  const project=store.createProject("Archive project",core.root);
  const binding=store.createSession("actor",core.root,"Original",project.id);store.setSessionThread(binding.id,threadId);
  const child=(phase:string)=>new Promise<{status:number|null;signal:NodeJS.Signals|null;stderr:string}>((resolve,reject)=>{
    const proc=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("./fixtures/archive-recovery-interrupt.mjs",import.meta.url)),core.root,core.endpoint,threadId,turnId,phase],
      {stdio:["ignore","ignore","pipe"],timeout:10000});let stderr="";
    proc.stderr.on("data",chunk=>{stderr+=chunk;});proc.once("error",reject);proc.once("exit",(status,signal)=>resolve({status,signal,stderr}));
  });
  const saved=()=>Object.values(JSON.parse(fs.readFileSync(path.join(core.root,"archive-recovery-fixture.json"),"utf8")))[0] as {restoreActive:boolean};
  for(const step of ["after-archive","during-compensation"]){
    const died=await child(step);assert.equal(died.signal,"SIGKILL",died.stderr);
    assert.equal(saved().restoreActive,true);
  }
  const final=await child("recover");assert.equal(final.status,0,final.stderr);
  assert.equal(saved().restoreActive,false);
  const after=await runner.inspectThread(threadId);
  assert.equal(after.persistence,"active");assert.equal(after.projectId,before.projectId);
  assert.equal(new RuntimeStateStore(paths).getBoundSession("actor")?.threadId,threadId);
  const history=await runner.getHistory(threadId);
  assert.equal(history.filter((row:{text:string})=>row.text.includes("preserve this archived source")).length,1);
  assert.equal(core.calls.length,1);
});
