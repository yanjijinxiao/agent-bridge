// Deliberately failing audit counterexamples at 4bb6cd2; not part of npm test.
// Run explicitly using the command in README.md. No live Codex or IM is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { peerFixture, principal } from '../../../test/peer-fixture.js';

import path from 'node:path';
import crypto from 'node:crypto';
import { BridgeService } from '../../../src/bridge/service.js';
import { RuntimeStateStore } from '../../../src/state/runtime-state.js';
import { resolveStatePaths } from '../../../src/state/paths.js';
import { defaultConfig } from '../../../src/state/config.js';
import { createChannelClient, TEXT_CAPABILITIES } from '../../../src/channels/client.js';

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
    input.assertCurrent?.(); // The native adapter repeats this after connect/resume waits.
    writes++;
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
