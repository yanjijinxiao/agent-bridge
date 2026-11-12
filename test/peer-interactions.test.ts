import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { peerFixture } from './peer-fixture.js';
import type { NativeInteractionObserver, NativeApproval, NativeUserInput } from '../src/codex/interactions.js';

async function fixture(t: test.TestContext) {
  const f = await peerFixture(t); await f.bind();
  const observers = new Map<string, NativeInteractionObserver>();
  f.backend.observeThreadInteractions = async (id, host, observer, consumer) => {
    assert.equal(id, f.thread.threadId); assert.equal(host, 'local'); observers.set(consumer!, observer);
  };
  f.backend.unobserveThreadInteractions = async (_id, _host, consumer) => { observers.delete(consumer!); };
  f.backend.interactionSubscriptionReady = () => observers.size > 0;
  await f.reconnect(true);
  const envelope = (): NativeApproval => ({hostId:'local', requestId:42, method:'item/commandExecution/requestApproval',
    request:{kind:'command',threadId:f.thread.threadId,turnId:'turn',itemId:'item',command:'pwd'}});
  t.after(() => f.facade.close());
  return {...f, observers, envelope, native: () => [...observers.values()].at(-1)!};
}

test('independent peer interaction remaps host, preserves request identity and keeps explicit decisions', async t => {
  const f = await fixture(t); let shown: NativeApproval | undefined, confirmed = false;
  await f.facade.observeThreadInteractions!(f.thread.threadId, f.ticket.hostId, {
    async onApproval(input) { shown = input; assert.equal(input.hostId, f.ticket.hostId); assert.equal(input.request.hostId, f.ticket.hostId); return 'decline'; },
    onResult(input, result) { assert.equal(input, shown); assert.equal(result, 'confirmed'); confirmed = true; }
  });
  assert.equal(f.facade.interactionSubscriptionReady!(f.thread.threadId, f.ticket.hostId), true);
  assert.equal(await f.native().onApproval(f.envelope()), 'decline');
  await f.native().onResult!(f.envelope(), 'confirmed'); assert.ok(confirmed);
  await f.facade.unobserveThreadInteractions!(f.thread.threadId, f.ticket.hostId);
  assert.equal(f.observers.size, 0);
});

test('disconnect retires the pending UI without answering, then a fresh subscription can answer the native replay', async t => {
  const f = await fixture(t), shown = Promise.withResolvers<void>(), withdrawn = Promise.withResolvers<void>();
  const old = { async onApproval() { shown.resolve(); return new Promise<undefined>(() => {}); },
    onResult(_input: unknown, result: string) { assert.equal(result, 'withdrawn'); withdrawn.resolve(); } };
  await f.facade.observeThreadInteractions!(f.thread.threadId, f.ticket.hostId, old);
  const pending = f.native().onApproval(f.envelope()); await shown.promise;
  await f.reconnect(); assert.equal(await pending, undefined); await withdrawn.promise;
  for (let n=0;n<100 && f.observers.size;n++) await delay(5);
  await f.facade.observeThreadInteractions!(f.thread.threadId, f.ticket.hostId, {async onApproval(){return 'accept';}});
  assert.equal(await f.native().onApproval(f.envelope()), 'accept');
});

test('INT-02.6: peer disconnect suspends an unanswered async widget and permits only an explicit answer after reattachment', async t => {
  const f = await fixture(t), shown = Promise.withResolvers<void>(), retired = Promise.withResolvers<string>();
  const envelope: NativeUserInput = { hostId: 'local', requestId: 'async:widget', method: 'item/tool/requestUserInput',
    request: { kind: 'async', hostId: 'local', requestId: 'async:widget', itemId: 'widget', threadId: f.thread.threadId, turnId: 'turn',
      questions: [{ id: 'q', header: 'question', question: 'still pending' }], autoResolutionMs: null } };
  await f.facade.observeThreadInteractions!(f.thread.threadId, f.ticket.hostId, { onApproval: async () => undefined,
    onUserInput() { shown.resolve(); return new Promise(() => {}); }, onUserInputResult(_input, result) { retired.resolve(result); } });
  const old = f.native().onUserInput!(envelope); await shown.promise;
  await f.reconnect(); assert.equal(await old, undefined);
  assert.equal(await retired.promise, 'suspended', 'losing the connection is not native withdrawal');
  for (let n = 0; n < 100 && f.observers.size; n++) await delay(5);
  await f.facade.observeThreadInteractions!(f.thread.threadId, f.ticket.hostId, { onApproval: async () => undefined,
    onUserInput: async () => ({ q: { answers: ['explicit answer'] } }) });
  assert.deepEqual(await f.native().onUserInput!(envelope), { q: { answers: ['explicit answer'] } });
});

test('observer failures and stale/wrong thread requests cannot manufacture a decision', async t => {
  const f = await fixture(t);
  await assert.rejects(f.facade.observeThreadInteractions!('wrong', f.ticket.hostId, {async onApproval(){return 'accept';}}));
  await f.facade.observeThreadInteractions!(f.thread.threadId, f.ticket.hostId, {async onApproval(){throw Error('route unavailable');}});
  assert.equal(await f.native().onApproval(f.envelope()), undefined);
  const wrong = f.envelope(); wrong.request.threadId = 'other';
  assert.equal(await f.native().onApproval(wrong), undefined);
  await f.facade.unobserveThreadInteractions!(f.thread.threadId, f.ticket.hostId);
  assert.equal(f.facade.interactionSubscriptionReady!(f.thread.threadId, f.ticket.hostId), false);
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerCodexRunner } from '../src/codex/app-server-runner.js';
import { CodexAppServerGateway } from '../src/codex/app-server-gateway.js';
import { ChannelUserInputController } from '../src/bridge/user-input-controller.js';

test('INT-02.6: a real native question survives Peer reattachment in its original card, accepts one answer and stays closed after replay', {timeout:15000}, async t => {
  const f = await peerFixture(t, {device:true}); await f.bind(); f.thread.threadId='thread'; f.thread.cwd='/tmp';
  const state=path.join(f.root,'async-state.json'),trace=path.join(f.root,'async-trace.jsonl');
  fs.writeFileSync(state,JSON.stringify({allowAsyncSteer:true,items:[{id:'widget',type:'agentMessage',questions:[{title:'pending native question',options:null}]}]}));
  const native=new AppServerCodexRunner({catalogSource:'native',requestTimeoutMs:1000,transport:{command:process.execPath,
    args:[fileURLToPath(new URL('./fixtures/native-request-gap.mjs',import.meta.url)),state,trace],mode:'daemon-proxy'}});
  const gateway=new CodexAppServerGateway({appServerBackend:native,appServerTransport:'stdio'});
  f.backend.observeThreadInteractions=(...a)=>gateway.observeThreadInteractions(...a);
  f.backend.unobserveThreadInteractions=(...a)=>gateway.unobserveThreadInteractions(...a);
  f.backend.interactionSubscriptionReady=(...a)=>gateway.interactionSubscriptionReady(...a);
  const cards:unknown[]=[],notices:string[]=[],journal=path.join(f.root,'questions.json');
  const controller=new ChannelUserInputController(async(_sender,card)=>{cards.push(card);return{messageId:'question-card'};},undefined,
    {filePath:journal,sendNotice:async(_sender,text)=>{notices.push(text);}});
  t.after(async()=>{controller.close();await f.facade.close();await gateway.close();});
  const observer:NativeInteractionObserver={onApproval:async()=>undefined,
    onUserInput:input=>controller.request('chat',input.request),onUserInputResult:(input,result)=>controller.reportResult('chat',input.request,result),
    onObservedUserInputAnswers:receipts=>controller.observeNativeAnswers(receipts)};
  const until=async(check:()=>boolean)=>{for(let n=0;n<300;n++){if(check())return;await delay(10);}assert.fail('async end-to-end condition timed out');};
  const saved=()=>JSON.parse(fs.readFileSync(journal,'utf8')).records;
  await f.reconnect(true);await f.facade.observeThreadInteractions!('thread',f.ticket.hostId,observer);
  await until(()=>cards.length===1);
  const pid=(native as any).child.pid;
  await f.reconnect();await until(()=>!native.interactionSubscriptionReady('thread'));
  await f.facade.observeThreadInteractions!('thread',f.ticket.hostId,observer);
  await until(()=>f.facade.interactionSubscriptionReady!('thread',f.ticket.hostId));
  assert.equal(cards.length,1);assert.equal(saved()[0].id,'Q1');assert.equal(saved()[0].status,'pending');
  assert.equal(notices.some(x=>x.includes('失效')),false);
  assert.match(controller.answer('chat','Q1 explicit IM answer'),/回执/);
  await until(()=>saved()[0].status==='confirmed');
  assert.equal(controller.acceptedPresentationInputs().length,1);
  const calls=()=>fs.readFileSync(trace,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(calls().filter(c=>c.method==='turn/steer').length,1);
  assert.equal(calls().some(c=>c.method==='turn/start'),false);
  assert.equal((native as any).child.pid,pid);
  await f.facade.unobserveThreadInteractions!('thread',f.ticket.hostId);
  await f.facade.observeThreadInteractions!('thread',f.ticket.hostId,observer);await delay(30);
  assert.equal(cards.length,1);assert.equal(calls().filter(c=>c.method==='turn/steer').length,1);
});

test('native JSONL pending approval survives peer reconnect on the same core and receives one explicit answer', {timeout:15000}, async t => {
  const f = await peerFixture(t, {device:true}); await f.bind(); f.thread.threadId='thread';f.thread.cwd='/tmp';
  const state=path.join(f.root,'native-state.json'),trace=path.join(f.root,'native-trace.jsonl');fs.writeFileSync(state,JSON.stringify({approval:true}));
  const native=new AppServerCodexRunner({catalogSource:'native',requestTimeoutMs:1000,transport:{command:process.execPath,
    args:[fileURLToPath(new URL('./fixtures/native-request-gap.mjs',import.meta.url)),state,trace],mode:'daemon-proxy'}});
  const gateway=new CodexAppServerGateway({appServerBackend:native,appServerTransport:'stdio'});
  t.after(async()=>{await f.facade.close();await gateway.close();});
  f.backend.observeThreadInteractions=(...a)=>gateway.observeThreadInteractions(...a);
  f.backend.unobserveThreadInteractions=(...a)=>gateway.unobserveThreadInteractions(...a);
  f.backend.interactionSubscriptionReady=(...a)=>gateway.interactionSubscriptionReady(...a);
  await f.reconnect(true);
  const calls=()=>fs.readFileSync(trace,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  const until=async(check:()=>boolean)=>{for(let n=0;n<200;n++){if(check())return;await delay(10);}assert.fail('native condition timed out');};
  const shown=Promise.withResolvers<void>(),withdrawn=Promise.withResolvers<void>();
  const observer={async onApproval(){shown.resolve();return new Promise<undefined>(()=>{});},onResult(){withdrawn.resolve();}};
  await f.facade.observeThreadInteractions!('thread',f.ticket.hostId,observer);
  // The native fixture intentionally loses its first pending-request replay.
  await f.facade.unobserveThreadInteractions!('thread',f.ticket.hostId);
  await f.facade.observeThreadInteractions!('thread',f.ticket.hostId,observer);await shown.promise;
  await delay(1200);
  assert.equal(f.facade.interactionSubscriptionReady!('thread',f.ticket.hostId),true,'the peer consumer stays subscribed across the readiness heartbeat');
  const pid=(native as any).child.pid;
  await f.reconnect();await withdrawn.promise;
  await until(()=>!native.interactionSubscriptionReady('thread'));
  assert.equal(calls().filter(c=>!c.method).length,0,'disconnect sent no native approval response');
  await f.facade.observeThreadInteractions!('thread',f.ticket.hostId,{async onApproval(){return 'accept';}});
  await until(()=>calls().some(c=>c.id==='approval-1'&&!c.method));
  const decisions=calls().filter(c=>!c.method);assert.equal(decisions.length,1);assert.deepEqual(decisions[0].result,{decision:'accept'});
  assert.equal((native as any).child.pid,pid);assert.equal(calls().some(c=>['turn/start','turn/steer','thread/start'].includes(c.method)),false);
});
