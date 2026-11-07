import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {RuntimeObservationController,RuntimeObservationJournal,type RuntimeObservationScope} from "../src/bridge/runtime-observation.js";
import {ChannelTurnPresentation} from "../src/channels/turn-presentation.js";
import {createChannelClient,TEXT_CAPABILITIES} from "../src/channels/client.js";
import type {RuntimeResource} from "../src/agents/contracts.js";

for (const restart of [false,true]) for (const streamEnabled of [false,true])
test(`terminal stages survive rendering and recovery without raw command logs: restart=${restart},stream=${streamEnabled}`,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"terminal-display-"));const file=path.join(root,"observations.json");
 const scope:RuntimeObservationScope={accountId:"test",actorId:"actor",conversationId:"room",sessionId:"s",hostId:"h",threadId:"r",bindingStamp:"g"};
 const target:RuntimeResource={ref:{endpointId:"e",id:"r"},kind:"terminal",title:"test",cwd:root,state:"working",agent:"codex",evidence:"program-report",incarnation:"same",identityStrength:"observed"};
 const cards=new Map<string,string>(), finals:string[]=[],streams:ChannelTurnPresentation[]=[];
 const channel=createChannelClient("dingtalk",{...TEXT_CAPABILITIES,progress:"available",turnStatusHeader:"available",resumableProgress:true}, {
  async sendText(input){finals.push(input.text);return {messageId:"text"};},
  async startTextStream(input){cards.set(input.streamId!,input.text);return {messageId:input.streamId!};},
  async updateTextStream(input){cards.set(input.messageId,input.text);if(input.finalize)finals.push(input.text);}
 });
 let text="› Old request\n• Old answer\nWorked for 1s\n› Current request\n• Architecture checked\n• Ran shell secret-argument\n  └ secret output\n• Inspecting modules";
 let journal=new RuntimeObservationJournal(file);
 const create=()=>new RuntimeObservationController({journal,current:()=>true,progressEnabled:()=>streamEnabled,
  inspect:async()=>structuredClone(target),read:async()=>({kind:"terminal-screen",ref:target.ref,text,complete:true,source:"screen"}),
  decorateText:(_scope,body)=>body+"\n\n[Web IDE](https://example.test/workspace)",
  presentation(row,save){const stream=new ChannelTurnPresentation(channel,"room",{restore:row.checkpoint,save,progressEnabled:streamEnabled,
   interruptControl:"request",decorateProgress:body=>body+"\n\n[Web IDE](https://example.test/workspace)"});streams.push(stream);return stream;}
 });
 let observer=create();t.after(async()=>{observer.close();await Promise.all(streams.map(s=>s.suspend()));fs.rmSync(root,{recursive:true,force:true});});
 const id=observer.begin(scope,target,"input");observer.handed(id,{fingerprint:"a".repeat(64),ref:target.ref,phase:"confirmed",receipt:{kind:"terminal-written",ref:target.ref,incarnation:"same",started:true}});
 await observer.tick();await Promise.all(streams.map(s=>s.flush()));
 if(streamEnabled){assert.equal(cards.size,1);assert.match([...cards.values()][0],/Architecture checked/);assert.match([...cards.values()][0],/Web IDE/);assert.match([...cards.values()][0],/\/stop/);}
 else assert.equal(cards.size,0);
 if(restart){observer.close();await Promise.all(streams.map(s=>s.suspend()));journal=new RuntimeObservationJournal(file);observer=create();}
 await observer.tick();target.state="idle";text=text.replace("Inspecting modules","Modules verified\n\n  Detail at https://example.test/result.")+"\nWorked for 3s\n› Ask Codex to do anything\n  ? for shortcuts";
 await observer.tick();
 assert.equal(finals.length,1);const result=finals[0];assert.match(result,/Architecture checked/);assert.match(result,/Modules verified/);
 assert.equal((result.match(/Architecture checked/g)??[]).length,1);assert.match(result,/输出已收起/);assert.match(result,/Web IDE/);
 assert.doesNotMatch(result,/Old answer|Old request|secret-argument|secret output|Worked for|\/stop|终端画面/);
 assert.match(result,/Modules verified\n\nDetail at https:\/\/example.test\/result\./);
 assert.doesNotMatch(result, /💬|\\\\\./);
 assert.equal(journal.list().length,0);
});
