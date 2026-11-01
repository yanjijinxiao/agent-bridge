import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {readNativeTurnLifecycle, observeOwnerTurn, readNativeThreadProvenance} from "../src/codex/native-turn-lifecycle.js";
import {CodexBackendRouter} from "../src/codex/runner.js";
import {APP_SERVER_BACKEND_CAPABILITIES} from "../src/codex/backend.js";
import {CodexCommunicationError} from "../src/codex/communication-error.js";

test("partial and contradictory owner snapshots cannot certify an ending", () => {
 const state = {threadId:"thread",persistence:"active" as const,runtimeStatus:"active" as const,activeFlags:[]};
 assert.equal(observeOwnerTurn({state,turns:[{id:"turn",status:"interrupted",messages:[]}]},"thread","turn").source,"unknown");
 assert.equal(observeOwnerTurn({state:{...state,activeTurnId:"new"},turns:[{id:"turn",status:"inProgress",messages:[]}]},"thread","turn").source,"unknown");
 assert.equal(observeOwnerTurn({state:{...state,runtimeStatus:"notLoaded"},turns:[{id:"turn",status:"completed",messages:[]}]},"thread","turn").source,"unknown");
 assert.throws(()=>observeOwnerTurn({state,turns:[]},"other-thread","turn"),/identity mismatch/);
});

test("complete provenance keeps root ownership and never treats inherited child headers or partial logs as authority", async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-complete-provenance-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,"rollout.jsonl");
 const rows=[{type:"session_meta",payload:{id:"thread",source:"cli"}},
  {type:"event_msg",payload:{type:"task_started",turn_id:"main"}},
  {type:"response_item",payload:{type:"agent_message",content:[{type:"input_text",text:'{"type":"task_complete","turn_id":"main"}'}]}}];
 fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join("\n")+"\n");
 assert.deepEqual(await readNativeThreadProvenance(file,"thread"),{threadId:"thread",complete:true,turns:[{id:"main",status:"inProgress"}]});
 assert.equal(await readNativeThreadProvenance(file,"other"),undefined);
 fs.writeFileSync(file,[{type:"session_meta",payload:{id:"child",source:{subagent:{}}}},...rows].map(x=>JSON.stringify(x)).join("\n")+"\n");
 assert.equal(await readNativeThreadProvenance(file,"thread"),undefined);
 assert.equal(await readNativeThreadProvenance(file,"child"),undefined);
 fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join("\n"));assert.equal(await readNativeThreadProvenance(file,"thread"),undefined);
});

test("only exact explicit native endings certify an unloaded turn; partial, guardian and other-turn records do not",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gateway-lifecycle-proof-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,"rollout.jsonl");
 const meta={type:"session_meta",payload:{id:"thread"}},event=(type:string,extra={})=>({type:"event_msg",payload:{type,turn_id:"turn",...extra}});
 const save=(rows:unknown[],newline=true)=>fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join("\n")+(newline?"\n":""));
 save([meta,event("task_started")]);assert.equal((await readNativeTurnLifecycle(file,"thread","turn")).source,"unknown");
 save([meta,event("turn_aborted",{turn_id:"another"})]);assert.equal((await readNativeTurnLifecycle(file,"thread","turn")).status,"unknown");
 save([meta,event("task_complete",{last_agent_message:"actual result"})],false);assert.equal((await readNativeTurnLifecycle(file,"thread","turn")).status,"unknown");
 save([meta,event("task_complete",{last_agent_message:"actual result"})]);assert.deepEqual(await readNativeTurnLifecycle(file,"thread","turn"),{status:"completed",source:"native-event",text:"actual result"});
 assert.equal((await readNativeTurnLifecycle(file,"other-thread","turn")).source,"unknown");
 save([{type:"session_meta",payload:{id:"thread",source:"guardian"}},event("task_complete")]);assert.equal((await readNativeTurnLifecycle(file,"thread","turn")).source,"unknown");
 save([meta,event("turn_aborted")]);assert.equal((await readNativeTurnLifecycle(file,"thread","turn")).status,"interrupted");
 save([meta,event("task_complete"),event("task_started")]);assert.equal((await readNativeTurnLifecycle(file,"thread","turn")).status,"unknown");
});

for(const status of ['inProgress','completed'] as const)test(`queue recovery uses the exact native ${status} receipt without consuming again`,async t=>{
 let writes=0;const router=new CodexBackendRouter({appServerBackend:{
  async readThreadSnapshot(){return {state:{threadId:'thread',persistence:'active',runtimeStatus:status==='inProgress'?'active':'idle',activeFlags:[],activeTurnId:status==='inProgress'?'turn':undefined},
   turns:[{id:'turn',status,messages:[{role:'assistant',text:'NATIVE_RESULT'}]}]};},
  async runQueuedSubmission(){writes++;throw Error('must not resubmit');},close(){}
 } as never});t.after(()=>router.close());
 const pending=router.runQueuedSubmission({threadId:'thread',acceptedTurnId:'turn',observeOnly:true,cwd:'/tmp'});
 if(status==='inProgress')await assert.rejects(pending,CodexCommunicationError);else assert.equal((await pending).text,'NATIVE_RESULT');assert.equal(writes,0);
});
