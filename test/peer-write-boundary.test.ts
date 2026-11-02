import { guardNativeWrite } from "../src/codex/write-guard.js";
import assert from 'node:assert/strict';
import test from 'node:test';
import { peerFixture, principal } from './peer-fixture.js';

import path from 'node:path';
import crypto from 'node:crypto';
import { BridgeService } from '../src/bridge/service.js';
import { RuntimeStateStore } from '../src/state/runtime-state.js';
import { resolveStatePaths } from '../src/state/paths.js';
import { defaultConfig } from '../src/state/config.js';
import { createChannelClient, TEXT_CAPABILITIES } from '../src/channels/client.js';

for (const revoke of [false, true]) test(`BIND final native guard ${revoke ? 'rejects a downgraded actor' : 'allows a live actor'}`, {timeout:5000}, async t => {
  const f = await peerFixture(t); await f.bind();
  const paths = resolveStatePaths(path.join(f.root,'bridge-state')), store = new RuntimeStateStore(paths);
  const bridge = new BridgeService({accountId:principal.accountId, stateStore:store, runner:f.facade, peer:f.registry,
    config:{...defaultConfig(paths.root),allowedSenderIds:[principal.actorId],streamReplies:false},
    channel:createChannelClient('dingtalk',TEXT_CAPABILITIES,{async sendText(){return {messageId:crypto.randomUUID()};}})});
  t.after(() => bridge.suspendUserInputs());
  const send = (text:string) => bridge.handleMessage({id:crypto.randomUUID(),senderId:principal.actorId,replyTargetId:principal.conversationId,
    conversationKind:'direct',text,attachments:[],raw:{}});
  await send(`/session ${f.thread.threadId} --host ${f.ticket.hostId}`);
  assert.equal(store.getBoundSession(principal.conversationId)?.threadId,f.thread.threadId);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let writes = 0;
  f.run = async input => {
    entered.resolve(); await release.promise;
    await guardNativeWrite(input.assertCurrent, async () => { writes++; });
    return {threadId:f.thread.threadId, turnId:'new-turn', text:'done', raw:''};
  };
  const pending = send('normal message through the real Bridge').catch(error => ({error}));
  await entered.promise;
  if (revoke) store.setRole(principal.conversationId,principal.actorId,'viewer');
  release.resolve(); await pending;
  assert.equal(writes, revoke ? 0 : 1, 'final native write must obey the current Gateway role');
});

test('INT-01 callback transport failure must not manufacture a decline', {timeout:5000}, async t => {
  const f = await peerFixture(t); await f.bind(); let decision: unknown;
  f.run = async input => {
    decision = await input.onApproval?.({kind:'command', threadId:f.thread.threadId, turnId:'turn', itemId:'item', command:'pwd'});
    return {threadId:f.thread.threadId, turnId:'turn', text:'done', raw:''};
  };
  await f.as(() => f.facade.run(f.input({onApproval: async () => {throw Error('approval route unavailable');}})));
  assert.notEqual(decision, 'decline', 'no user selected reject');
});

test('INT-01 explicit rejection still reaches the native requester', {timeout:5000}, async t => {
  const f = await peerFixture(t); await f.bind(); let decision: unknown;
  f.run = async input => {
    decision = await input.onApproval?.({kind:'command', threadId:f.thread.threadId, turnId:'turn', itemId:'item', command:'pwd'});
    return {threadId:f.thread.threadId, turnId:'turn', text:'done', raw:''};
  };
  await f.as(() => f.facade.run(f.input({onApproval: async () => 'decline'})));
  assert.equal(decision, 'decline');
});

test('INT-01 disconnect while waiting for the human keeps approval undecided', {timeout:5000}, async t => {
  const f = await peerFixture(t); await f.bind();
  const shown = Promise.withResolvers<void>(), nativeFinished = Promise.withResolvers<unknown>();
  f.run = async input => {
    const decision = await input.onApproval?.({kind:'command', threadId:f.thread.threadId, turnId:'turn', itemId:'item', command:'pwd'});
    nativeFinished.resolve(decision);
    return {threadId:f.thread.threadId, turnId:'turn', text:'done', raw:''};
  };
  const pending = f.as(() => f.facade.run(f.input({onApproval: () => {shown.resolve(); return new Promise(() => {});}}))).catch(() => undefined);
  await shown.promise; f.client.close();
  const decision = await nativeFinished.promise; await pending;
  assert.notEqual(decision, 'decline', 'disconnect is not a user decision');
});

import { AppServerCodexRunner } from '../src/codex/app-server-runner.js';
import { fileURLToPath } from 'node:url';

for (const method of ['run', 'steer', 'stop', 'renameThread', 'archiveThread', 'unarchiveThread', 'deleteThread', 'createThread', 'interruptTurn', 'setGoal', 'clearGoal'] as const)
  test(`native JSONL ${method} checks the Gateway after native connection waits`, {timeout:10000}, async t => {
    const f = await peerFixture(t, { device: true }); await f.bind();
    f.thread.threadId = 'thread-existing'; f.thread.cwd = '/tmp/project';
    if (method === 'deleteThread' || method === 'unarchiveThread') f.thread.persistence = 'archived';
    const runner = new AppServerCodexRunner({ requestTimeoutMs: 2000, transport: { command: process.execPath,
      args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-codex-app-server.mjs')], mode: 'remote-daemon' } });
    t.after(() => runner.close());
    const native = runner as any, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const connect = native.ensureConnected.bind(runner), request = native.request.bind(runner), writes: string[] = [];
    native.ensureConnected = async () => { entered.resolve(); await release.promise; await connect(); };
    native.request = async (method: string, ...args: unknown[]) => {
      if (['turn/start', 'turn/steer', 'turn/interrupt', 'thread/start', 'thread/name/set', 'thread/archive', 'thread/unarchive', 'thread/delete', 'thread/goal/set', 'thread/goal/clear'].includes(method)) writes.push(method);
      return request(method, ...args);
    };
    let current = true;
    const guard = () => { if (!current) throw Error('binding/role retired'); };
    f.backend.interruptTurn = (id, turn, _host, guard) => runner.interruptTurn(id, turn, guard);
    f.backend.setGoal = (id, value, _host, guard) => runner.setGoal(id, value, guard);
    f.backend.clearGoal = (id, _host, guard) => runner.clearGoal(id, guard);
    if (method === 'run') f.run = input => runner.run(input);
    if (method === 'steer') f.backend.steer = input => runner.steer(input);
    if (method === 'stop') f.backend.stop = (id, _host, guard) => runner.stop(id, guard);
    if (method === 'createThread') f.backend.createThread = input => runner.createThread(input);
    if (method === 'renameThread') f.backend.renameThread = (id, title, _host, guard) => runner.renameThread(id, title, guard);
    for (const m of ['archiveThread', 'unarchiveThread', 'deleteThread'] as const)
      if (method === m) f.backend[m] = (id, _host, guard) => runner[m](id, guard) as never;
    // The fixture exposes the independently running turn only on this method.
    if (method === 'stop') native.activeTurns.set(f.thread.threadId, 'external-turn');
    const call = () => {
      if (method === 'interruptTurn') return f.facade.interruptTurn!(f.thread.threadId, 'exact-turn', f.ticket.hostId, guard);
      if (method === 'setGoal') return f.facade.setGoal(f.thread.threadId, {objective:'test'}, f.ticket.hostId, guard);
      if (method === 'clearGoal') return f.facade.clearGoal(f.thread.threadId, f.ticket.hostId, guard);
      if (method === 'run') return f.facade.run(f.input({ assertCurrent: guard }));
      if (method === 'steer') return f.facade.steer({ threadId: f.thread.threadId, prompt: 'steer', expectedTurnId: 'external-turn', assertCurrent: guard }, f.ticket.hostId);
      if (method === 'stop') return f.facade.stop(f.thread.threadId, f.ticket.hostId, guard);
      if (method === 'createThread') return f.facade.createThread!({ standalone: true, assertCurrent: guard }, f.ticket.hostId);
      if (method === 'renameThread') return f.facade.renameThread!(f.thread.threadId, 'renamed', f.ticket.hostId, guard);
      return f.facade[method](f.thread.threadId, f.ticket.hostId, guard);
    };
    const pending = f.as(call); const failed = assert.rejects(pending);
    await entered.promise; current = false; release.resolve(); await failed;
    assert.deepEqual(writes, [], 'no JSONL write may reach the native process after source retirement');
  });

test('old Connectors cannot silently skip the final write check', async t => {
  const f = await peerFixture(t); await f.bind(); delete f.registry.description(f.ticket.hostId).writeGuard;
  await assert.rejects(f.as(() => f.facade.run(f.input())), /更新 Connector/);
  assert.equal(f.runs.length, 0);
});

test('missing approval handler also means unanswered', async t => {
  const f = await peerFixture(t); await f.bind(); let decision: unknown = 'unset';
  f.run = async input => { decision = await input.onApproval!({kind:'command',threadId:f.thread.threadId,turnId:'turn',itemId:'item',command:'pwd'});
    return {threadId:f.thread.threadId,turnId:'turn',text:'',raw:''}; };
  await f.as(() => f.facade.run(f.input())); assert.equal(decision, undefined);
});

test('role revocation after native resume blocks turn/start and retains a safe retry classification', async t => {
  const f=await peerFixture(t,{device:true});await f.bind();f.thread.threadId='thread-existing';f.thread.cwd='/tmp/project';
  const runner=new AppServerCodexRunner({requestTimeoutMs:2000,transport:{command:process.execPath,
    args:[fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs',import.meta.url))],mode:'remote-daemon'}});
  t.after(()=>runner.close());f.run=input=>runner.run(input);
  let current=true, revoke=true;const request=(runner as any).request.bind(runner);let starts=0;
  (runner as any).request=async(method:string,...args:unknown[])=>{
    if(method==='turn/start')starts++;
    const result=await request(method,...args);
    if(method==='thread/resume'&&revoke)current=false;
    return result;
  };
  const input=f.input({assertCurrent(){if(!current)throw Error('role downgraded after resume');}});
  await assert.rejects(f.as(()=>f.facade.run(input)),(e:any)=>e.submission==='not-submitted');
  assert.equal(starts,0);assert.equal((runner as any).unconfirmedStarts.has(f.thread.threadId),false);
  revoke=false;current=true;await f.as(()=>f.facade.run(input));assert.equal(starts,1);
});
