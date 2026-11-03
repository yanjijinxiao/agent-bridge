import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ThreadEventHub, type ThreadSubscription } from '../src/server/thread-event-hub.js';
import { formatFollowStatus } from '../src/bridge/session-follow.js';

for (const receiptUnavailable of [false, true]) test(`accepted active snapshot still updates progress: ${receiptUnavailable ? 'old receipt unavailable' : 'normal control'}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-receipt-progress-'));
  const writes: string[] = [];
  const sub: ThreadSubscription = {key:'binding',hostId:'local',threadId:'thread',recipientId:'chat',managed:false,
    client:{resumableTextStream:true,async sendText(input){writes.push(input.text);return {messageId:'text'};},
    async startTextStream(input){writes.push(input.text);return {messageId:'original'};},
    async updateTextStream(input){writes.push(input.text);}}};
  const hub = new ThreadEventHub({filePath:path.join(root,'hub.json'),subscriptions:()=>[sub],
    onInputObservation:async()=>{if(receiptUnavailable)throw Error('Native input receipt observation timed out');},
    backend:()=>({async readThreadSnapshot(){return {state:{threadId:'thread',persistence:'active',runtimeStatus:'active',activeFlags:[],activeTurnId:'turn'},
      turns:[{id:'turn',status:'inProgress',messages:[{id:'new-progress',role:'assistant',kind:'progress',text:'CURRENT_REVIEW_PROGRESS'}]}]};}})});
  t.after(async()=>{await hub.stop();fs.rmSync(root,{recursive:true,force:true});});
  await hub.started('local','thread','turn',new Date().toISOString());
  await hub.activity('local','thread','turn','已接收补充输入，正在继续原任务');
  const status = await hub.synchronize('binding');
  assert.ok(writes.some(text=>text.includes('CURRENT_REVIEW_PROGRESS')),
    'read-only progress from an active owner must not be discarded by unrelated input receipt recovery');
  assert.equal(status.status, 'synced'); assert.equal(Boolean(status.inputRecoveryFailure), receiptUnavailable);
  if (receiptUnavailable) assert.match(formatFollowStatus(status).join('\n'), /输入回执恢复/);
});

test('receipt failure withholds final effects until recovery and does not replay input', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-receipt-final-'));
  let receiptFails = true, completed = false, applied = 0;
  const writes: string[] = [];
  const sub: ThreadSubscription = { key: 'binding', hostId: 'local', threadId: 'thread', recipientId: 'chat', managed: false,
    client: { resumableTextStream: true, async sendText(input) { writes.push(input.text); return { messageId: 'text' }; },
      async startTextStream(input) { writes.push(input.text); return { messageId: 'card' }; },
      async updateTextStream(input) { writes.push(input.text); } } };
  const hub = new ThreadEventHub({ filePath: path.join(root, 'hub.json'), subscriptions: () => [sub],
    onInputObservation: async () => { if (receiptFails) throw Error('old receipt timed out'); },
    applyResult: async (_sub, _turn, text) => { applied++; return text; },
    backend: () => ({ async readThreadSnapshot() {
      return { state: { threadId: 'thread', persistence: 'active', runtimeStatus: completed ? 'idle' : 'active', activeFlags: [],
        ...(completed ? {} : { activeTurnId: 'turn' }) }, turns: [{ id: 'turn', status: completed ? 'completed' : 'inProgress',
        messages: [{ id: 'progress', role: 'assistant', kind: 'progress', text: 'live progress' },
          ...(completed ? [{ id: 'answer', role: 'assistant' as const, text: 'FINAL_ANSWER' }] : [])] }] };
    } }) });
  t.after(async () => { await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await hub.started('local', 'thread', 'turn', new Date().toISOString());
  await hub.activity('local', 'thread', 'turn', 'initial'); await hub.synchronize('binding');
  assert.ok(writes.some(text => text.includes('live progress')));
  completed = true; await hub.synchronize('binding');
  assert.equal(applied, 0); assert.equal(writes.some(text => text.includes('FINAL_ANSWER')), false);
  receiptFails = false; const recovered = await hub.synchronize('binding');
  assert.equal(recovered.inputRecoveryFailure, undefined); assert.equal(applied, 1);
  assert.ok(writes.some(text => text.includes('FINAL_ANSWER')));
  await hub.synchronize('binding'); assert.equal(applied, 1);
});

test('a binding removed during receipt recovery receives no late progress', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-receipt-binding-'));
  let enabled = true, writes = 0;
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const sub: ThreadSubscription = { key: 'binding', hostId: 'local', threadId: 'thread', recipientId: 'chat', managed: false,
    client: { async sendText() { writes++; return { messageId: 'text' }; } } };
  const hub = new ThreadEventHub({ filePath: path.join(root, 'hub.json'), subscriptions: () => enabled ? [sub] : [],
    onInputObservation: async () => { entered.resolve(); await resume.promise; throw Error('old receipt timeout'); },
    backend: () => ({ async readThreadSnapshot() { return { state: { threadId: 'thread', persistence: 'active', runtimeStatus: 'active', activeFlags: [], activeTurnId: 'turn' },
      turns: [{ id: 'turn', status: 'inProgress', messages: [{ id: 'progress', role: 'assistant', kind: 'progress', text: 'late private progress' }] }] }; } }) });
  t.after(async () => { resume.resolve(); await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const pending = hub.synchronize('binding'); await entered.promise;
  enabled = false; resume.resolve(); const status = await pending;
  assert.equal(status.failure?.code, 'binding-changed'); assert.equal(writes, 0);
});
