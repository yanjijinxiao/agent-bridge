import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {RuntimeObservationController,RuntimeObservationJournal,type RuntimeObservationScope} from "../src/bridge/runtime-observation.js";
import {ChannelTurnPresentation} from "../src/channels/turn-presentation.js";
import {createChannelClient,TEXT_CAPABILITIES} from "../src/channels/client.js";
import type {RuntimeResource} from "../src/agents/contracts.js";
import { channelStreamCheckpointSchema } from "../src/channels/stream-checkpoint.js";

for (const restart of [false,true]) for (const streamEnabled of [false,true]) for (const agent of ["codex","other-agent"])
test(`terminal window replaces one card and recovers: restart=${restart},stream=${streamEnabled},agent=${agent}`,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"terminal-window-"));const file=path.join(root,"observations.json");
 const scope:RuntimeObservationScope={accountId:"test",actorId:"actor",conversationId:"room",sessionId:"s",hostId:"h",threadId:"r",bindingStamp:"g"};
 const target:RuntimeResource={ref:{endpointId:"e",id:"r"},kind:"terminal",title:"test",cwd:root,state:"working",agent,evidence:"program-report",incarnation:"same",identityStrength:"observed"};
 const cards=new Map<string,string>(), finals:string[]=[],streams:ChannelTurnPresentation[]=[];
 const channel=createChannelClient("dingtalk",{...TEXT_CAPABILITIES,progress:"available",turnStatusHeader:"available",progressFooter:"available",resumableProgress:true,resultPageBytes:6000}, {
  async sendText(input){finals.push(input.text);return {messageId:"text"};},
  async startTextStream(input){assert.ok(Buffer.byteLength(input.text)<=6000);cards.set(input.streamId!,input.text);return {messageId:input.streamId!};},
  async updateTextStream(input){assert.ok(Buffer.byteLength(input.text)<=6000);cards.set(input.messageId,input.text);if(input.finalize)finals.push(input.text);}
 });
 const filler="终端文本🧪".repeat(2500);
 let text="OLDEST"+filler+"\n• Stage text\n• Browsing the web\n• Ran command\n  └ command output\nLATEST1";
 let offline=false, journal=new RuntimeObservationJournal(file);
 const create=()=>new RuntimeObservationController({journal,current:()=>true,progressEnabled:()=>streamEnabled,
  inspect:async()=>{if(offline)throw Error("offline");return structuredClone(target);},
  read:async()=>({kind:"terminal-screen",ref:target.ref,text,complete:true,source:"screen"}),
  decorateText:(_scope,body)=>body+"\n\n[Web IDE](https://example.test/workspace)",
  presentation(row,save){const stream=new ChannelTurnPresentation(channel,"room",{restore:row.checkpoint,save,progressEnabled:streamEnabled,
   interruptControl:"request",decorateProgress:body=>body+"\n\n[Web IDE](https://example.test/workspace)"});streams.push(stream);return stream;}
 });
 let observer=create();t.after(async()=>{observer.close();await Promise.all(streams.map(s=>s.suspend()));fs.rmSync(root,{recursive:true,force:true});});
 const id=observer.begin(scope,target,"input");observer.handed(id,{fingerprint:"a".repeat(64),ref:target.ref,phase:"confirmed",receipt:{kind:"terminal-written",ref:target.ref,incarnation:"same",started:true}});
 const flush=()=>Promise.all(streams.map(s=>s.flush()));
 await observer.tick();await flush();
 const streamId=journal.get(id)!.checkpoint!.streamId;
 if(streamEnabled){
  assert.equal(cards.size,1);const card=[...cards.values()][0];assert.match(card,/LATEST1/);assert.doesNotMatch(card,/OLDEST/);
  assert.match(card,/Stage text/);assert.match(card,/Browsing the web/);assert.match(card,/Ran command/);assert.match(card,/command output/);
  assert.match(card,/Web IDE/);assert.match(card,/\/stop/);assert.ok(Buffer.byteLength(card)>5900);
 }else assert.equal(cards.size,0);
 assert.deepEqual(journal.get(id)!.checkpoint!.phaseProgress!.phases,[]);
 channelStreamCheckpointSchema.parse(journal.get(id)!.checkpoint);
 if(restart){observer.close();await flush();journal=new RuntimeObservationJournal(file);observer=create();}
 offline=true;await observer.tick();await flush();
 if(streamEnabled){assert.equal(cards.size,1);assert.match([...cards.values()][0],/LATEST1/);}
 offline=false;text="REPLACED"+filler+"\n• Opened the current page\nLATEST2";
 await observer.tick();await flush();
 assert.equal(journal.get(id)!.checkpoint!.streamId,streamId);
 if(streamEnabled){const card=[...cards.values()][0];assert.match(card,/LATEST2/);assert.doesNotMatch(card,/LATEST1|Stage text/);assert.equal(cards.size,1);}
 target.state="idle";text=filler+"\nFINALWINDOW";
 await observer.tick();assert.equal(finals.length,1);
 const result=finals[0];assert.match(result,/FINALWINDOW/);assert.match(result,/Web IDE/);assert.doesNotMatch(result,/LATEST1|LATEST2|\/stop|阶段小结|完整答复/);
 assert.ok(Buffer.byteLength(result)<=6000);assert.ok(Buffer.byteLength(result)>5600);
 assert.equal(cards.size,streamEnabled?1:0);assert.equal(journal.list().length,0);
});

test("terminal window migrates active legacy phase checkpoints without rotating or clearing card identity",async t=>{
 const cards=new Map<string,string>();
 const channel=createChannelClient("dingtalk",{...TEXT_CAPABILITIES,progress:"available",turnStatusHeader:"available",resumableProgress:true}, {
  async sendText(){throw Error("no fallback");},
  async startTextStream(input){cards.set(input.streamId!,input.text);return {messageId:input.streamId!};},
  async updateTextStream(input){cards.set(input.messageId,input.text);}
 });
 let stream=new ChannelTurnPresentation(channel,"room",{save(){},interruptControl:"request"});t.after(()=>stream.suspend());
 await stream.progress("Old heuristic milestone");await stream.flush();const saved=stream.checkpoint(),id=saved.messageId;
 await stream.suspend();stream=new ChannelTurnPresentation(channel,"room",{restore:saved,save(){},interruptControl:"request"});
 await stream.terminalScreen("new full terminal\n• Ran command");await stream.flush();
 assert.equal(stream.checkpoint().messageId,id);assert.equal(cards.size,1);assert.deepEqual(stream.checkpoint().phaseProgress!.phases,[]);
 assert.doesNotMatch(cards.get(id!)!,/Old heuristic/);assert.match(cards.get(id!)!,/Ran command/);
 await stream.terminalScreen("");await stream.flush();assert.doesNotMatch(cards.get(id!)!,/new full terminal/);
 assert.equal(stream.checkpoint().segments,undefined);
});
