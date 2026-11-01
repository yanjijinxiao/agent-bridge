import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { unifiedBackend } from './fixtures/unified-backend.js';
import { CodexAppServerGateway } from '../src/codex/app-server-gateway.js';
import { CodexCommunicationError } from '../src/codex/communication-error.js';
import { InboundReceiptJournal } from '../src/bridge/inbound-receipts.js';
import { ForwardingInbox } from '../src/bridge/forwarding-inbox.js';

test('one native adapter exposes creation, structured helpers, goals, lifecycle and guarded input together',async t=>{
 const f=unifiedBackend(t),g=f.gateway;
 assert.equal((await g.run({cwd:'/tmp',prompt:'create'})).threadId,'created');
 await g.run({cwd:'/tmp',threadId:'thread',prompt:'continue'});
 const schema={type:'object',properties:{intent:{type:'string'}}};
 await g.runEphemeral({cwd:'/tmp',prompt:'classify',outputSchema:schema});
 const helper=f.calls.filter(c=>c.method==='run').at(-1)!.args[0];
 assert.equal(helper.ephemeral,true);assert.equal(helper.sandbox,'read-only');assert.equal(helper.outputSchema,schema);
 await g.setGoal('thread',{objective:'goal'});await g.clearGoal('thread');
 await g.archiveThread('thread');await g.unarchiveThread('thread');await g.deleteThread('thread');
 for(const capability of ['dynamicTools','turnSteering','goals','structuredOutput','approvals','liveFollow'])
  assert.equal((g.backendInfo().capabilities as any)[capability],true,capability);
 assert.deepEqual(f.calls.filter(c=>/Goal|Thread$/.test(c.method)).map(c=>c.method),['setGoal','clearGoal','archiveThread','unarchiveThread','deleteThread']);
});

test('ordinary active input, strict steering and stops preserve their native identity and source guard',async t=>{
 const f=unifiedBackend(t);f.state.runtimeStatus='active';f.state.activeTurnId='current';
 await f.gateway.submitThreadMessage({threadId:'thread',prompt:'more',cwd:'/tmp',clientUserMessageId:'origin'});
 const submitted=f.calls.find(c=>c.method==='steer')!.args[0];
 assert.equal(submitted.expectedTurnId,'current');assert.equal(submitted.clientUserMessageId,'origin');
 await f.gateway.steer({threadId:'thread',prompt:'strict',expectedTurnId:'specific'});
 assert.equal(f.calls.at(-1)!.args[0].expectedTurnId,'specific');
 await assert.rejects(f.gateway.submitThreadMessage({threadId:'thread',prompt:'revoked',cwd:'/tmp',assertCurrent(){throw Error('revoked');}}),/revoked/);
 await f.gateway.stop('thread');assert.equal(f.calls.at(-1)!.method,'stop');
});

test('native queue admission preserves source identity and consumption remains available',async t=>{
 const f=unifiedBackend(t);
 await f.gateway.addQueuedSubmission({threadId:'thread',prompt:'later',clientUserMessageId:'origin'});
 assert.equal(f.calls.find(c=>c.method==='addQueuedSubmission')!.args[0].clientUserMessageId,'origin');
 assert.equal(f.calls.some(c=>c.method==='runQueuedSubmission'),false);
 await f.gateway.runQueuedSubmission({threadId:'thread',cwd:'/tmp'});
 assert.equal(f.calls.at(-1)!.method,'runQueuedSubmission');
});

test('accepted input is reconciled read-only without consuming a native queue entry again',async t=>{
 const f=unifiedBackend(t); const result=await f.gateway.runQueuedSubmission({threadId:'thread',acceptedTurnId:'accepted',observeOnly:true,cwd:'/tmp'});
 assert.equal(result.text,'done');assert.equal(f.calls.some(c=>/run|addQueuedSubmission/.test(c.method)),false);
});

for(const phase of ['preflight','submission','observation'] as const)test(`${phase} failure cannot switch protocol, create a replacement thread or replay`,async t=>{
 const f=unifiedBackend(t);f.fail(new CodexCommunicationError(phase,'native/start','thread',phase==='observation'?'turn':undefined));
 await assert.rejects(f.gateway.run({threadId:'thread',cwd:'/tmp',prompt:'once'}),CodexCommunicationError);
 assert.deepEqual(f.calls.map(c=>c.method),['run']);
});

test('retired exec choice is rejected before starting any executor',()=>{
 assert.throws(()=>new CodexAppServerGateway({backend:'exec'}),/统一.*App Server/);
});

test('persisted IM input survives disconnection and restart with one stable submission after recovery',async t=>{
 const f=unifiedBackend(t),root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-unified-inbox-'));
 let now=1000,inbox:ForwardingInbox,receipts:InboundReceiptJournal;
 const make=()=>{receipts=new InboundReceiptJournal(path.join(root,'receipts.jsonl'),[],{onAccepted:r=>inbox.accepted(r)});
 inbox=new ForwardingInbox({filePath:path.join(root,'inbox.json'),receipts,now:()=>now,
 target:()=>({sessionId:'session',threadId:'thread',hostId:'local',workspace:root,mode:'session',roots:[]}),
 automatic:()=>true,canDispatch:()=>true,notice:async()=>{},dispatch:m=>receipts.handle(m,async()=>{
 await f.gateway.inspectThread('thread');receipts.submitting({sessionId:'session',hostId:'local',threadId:'thread'});
 await f.gateway.run({cwd:root,threadId:'thread',prompt:m.text,clientUserMessageId:receipts.receipt(m.id)!.clientUserMessageId,onTurnStarted:e=>{receipts.accepted(e.threadId,e.turnId);}});
 })});};
 t.after(()=>{inbox.stop();fs.rmSync(root,{recursive:true,force:true});});make();
 f.fail(new CodexCommunicationError('preflight','thread/read','thread'));
 const message={id:'im-source',senderId:'actor',replyTargetId:'room',text:'original',raw:{},attachments:[]};
 await inbox.receive(message);assert.equal(receipts.receipt(message.id)?.phase,'received');
 const identity=receipts.receipt(message.id)!.clientUserMessageId;assert.equal(f.calls.some(c=>c.method==='run'),false);
 inbox.stop();make();now+=60001;f.fail();await inbox.receive(message);
 assert.equal(receipts.receipt(message.id)?.phase,'handled');assert.equal(receipts.receipt(message.id)?.clientUserMessageId,identity);
 inbox.stop();make();await inbox.receive(message);assert.equal(f.calls.filter(c=>c.method==='run').length,1);
});
