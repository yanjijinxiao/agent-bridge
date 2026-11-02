import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {BridgeService} from '../src/bridge/service.js';
import {AppServerCodexRunner} from '../src/codex/app-server-runner.js';
import {createChannelClient,TEXT_CAPABILITIES} from '../src/channels/client.js';
import {defaultConfig} from '../src/state/config.js';
import {RuntimeStateStore} from '../src/state/runtime-state.js';
import {resolveStatePaths} from '../src/state/paths.js';
import {TurnAudienceJournal} from '../src/bridge/turn-audience.js';

async function until(check:()=>boolean){for(let i=0;i<500&&!check();i++)await new Promise(r=>setTimeout(r,4));assert.ok(check());}
test('native approval pings only its turn participants and confirmation starts one new AI card without starting another task',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'approval-card-roundtrip-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new RuntimeStateStore(resolveStatePaths(root)),project=store.createProject('Project',root);
 const session=store.createSession('room',root,'Task',project.id);store.setSessionThread(session.id,'thread-approval-command');
 const audience=new TurnAudienceJournal(path.join(root,'audience.json'));
 audience.record({bindingKey:'["account","unrelated"]',conversationId:'other-room',hostId:'local',threadId:'thread-approval-command',turnId:'turn-1'},
  {bindingKey:'["account","unrelated"]',conversationId:'other-room',actorId:'unrelated',mention:{userId:'unrelated'}});
 const starts:any[]=[],updates:any[]=[],cards:any[]=[],texts:string[]=[],statuses:boolean[]=[];
 const channel=createChannelClient('dingtalk',{...TEXT_CAPABILITIES,progress:'available',resumableProgress:true,actions:'available',mentions:'available',actionCardMentions:'available'}, {
  async sendText(input){texts.push(input.text);return {messageId:'text'};},
  async startTextStream(input){starts.push(input);return {messageId:input.streamId!};},
  async updateTextStream(input){updates.push(input);},
  async sendActionCard(input){cards.push(input);return {messageId:'approval-card'};},
  async sendMentionNotification(){return {messageId:'final-mention'};},
 });
 const runner=new AppServerCodexRunner({codexBin:fileURLToPath(new URL('fixtures/fake-codex-app-server.mjs',import.meta.url)),requestTimeoutMs:2000});t.after(()=>runner.close());
 let runs=0;const run=runner.run.bind(runner);runner.run=input=>{runs++;return run(input);};
 const service=new BridgeService({accountId:'account',stateStore:store,turnAudience:audience,channel,runner,
  config:{...defaultConfig(root),allowedSenderIds:['actor']},onTurnStatus:status=>{statuses.push(status.active);}});
 t.after(()=>service.suspendUserInputs());
 const pending=service.handleMessage({id:'original-input',senderId:'actor',replyTargetId:'room',mention:{userId:'actor'},text:'approval:command',raw:{}});
 await until(()=>service.listApprovals().length===1&&cards.length===1);
 assert.equal(starts.length,1);assert.equal(cards[0].toUserId,'room');assert.deepEqual(cards[0].mentions,[{userId:'actor'}]);
 const approval=service.listApprovals()[0];
 await service.handleMessage({id:'explicit-approval',senderId:'actor',replyTargetId:'room',text:`/approve ${approval.id}`,raw:{}});
 await pending;
 assert.equal(runs,1);assert.equal(starts.length,2);assert.notEqual(starts[0].streamId,starts[1].streamId);
 assert.match(starts[1].text,/审批已获 Codex 确认/);assert.deepEqual(statuses,[true,false]);
 assert.ok(updates.some(u=>u.messageId===starts[0].streamId&&u.finalize&&u.text.includes('批准决定已获 Codex 确认')));
 assert.equal(texts.some(text=>text.startsWith('Codex 已确认审批')),false,'continuation card is the success notice, not another duplicate card');
 assert.equal(service.acceptedPresentationInputs().filter(input=>input.kind==='approval').length,1);
});
