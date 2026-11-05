import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ThreadEventHub, type ThreadSubscription } from '../src/server/thread-event-hub.js';
import { formatFollowStatus } from '../src/bridge/session-follow.js';
import { TEXT_CAPABILITIES } from '../src/channels/client.js';

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
    client: { capabilities: { ...TEXT_CAPABILITIES, progress: 'available' }, resumableTextStream: true, async sendText(input) { writes.push(input.text); return { messageId: 'text' }; },
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
  assert.match(writes.at(-1)!, /任务已结束，结果待同步/);
  assert.doesNotMatch(writes.at(-1)!, /\/stop|\*\*进行中\*\*/);
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

for (const nextTurn of [false, true]) test(`pending result source survives restart and ${nextTurn ? 'a new active turn' : 'same-turn retry'} without replaying input`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-result-source-'));
  const frames: any[] = [], actions: string[] = [];
  let authorized = false, active = false;
  const final = 'ORIGINAL_FINAL\n```codex-im-gateway-actions\n{"send":[{"type":"file","path":"/tmp/result.txt"}]}\n```';
  const sub: ThreadSubscription = { key: 'binding', hostId: 'local', threadId: 'thread', recipientId: 'chat', managed: false,
    client: { capabilities: { ...TEXT_CAPABILITIES, progress: 'available' }, resumableTextStream: true,
      async sendText() { assert.fail('no replacement text'); },
      async startTextStream(input) { const messageId = `card-${frames.filter(f => f.start).length}`; frames.push({ ...input, start: true, messageId }); return { messageId }; },
      async updateTextStream(input) { frames.push(input); } } };
  const options = { filePath: path.join(root, 'hub.json'), subscriptions: () => [sub],
    onInputObservation: async () => { if (!authorized) throw Error('old input unavailable'); },
    resultReady: (_s: ThreadSubscription, _turn: string, text: string) => !text.includes('codex-im-gateway-actions') || authorized,
    applyResult: async (_s: ThreadSubscription, turn: string, text: string) => {
      if (!authorized) throw Error('source lookup failed');
      assert.equal(turn, 'original'); assert.equal(text, final, 'retry must keep action-bearing source'); actions.push(turn); return undefined;
    },
    backend: (): any => ({ async readThreadSnapshot() { return {
      state: { threadId: 'thread', persistence: 'active', runtimeStatus: active ? 'active' : 'idle', activeFlags: [], ...(active ? { activeTurnId: 'next' } : {}) },
      // A compacted snapshot can omit action blocks. Persisted source remains
      // the authority/readiness input, never this incomplete visible preview.
      turns: [{ id: 'original', status: 'completed', messages: [{ id: 'final', role: 'assistant', text: 'PUBLIC_ONLY_PREVIEW' }] },
        ...(active ? [{ id: 'next', status: 'inProgress', messages: [{ id: 'p', role: 'assistant', kind: 'progress', text: 'NEW_PROGRESS' }] }] : [])]
    }; } }) };
  let hub = new ThreadEventHub(options);
  t.after(async () => { await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await hub.started('local', 'thread', 'original', new Date().toISOString());
  await hub.activity('local', 'thread', 'original', 'initial progress');
  const originalCard = frames.at(-1).messageId;
  await assert.rejects(hub.completion('local', 'thread', 'original', final));
  assert.match(frames.at(-1).text, /任务已结束，结果待同步/); assert.doesNotMatch(frames.at(-1).text, /\/stop/);
  await hub.synchronize('binding'); assert.equal(actions.length, 0);
  if (nextTurn) {
    active = true; await hub.started('local', 'thread', 'next', new Date().toISOString());
    await hub.activity('local', 'thread', 'next', 'NEW_PROGRESS');
  }
  await hub.stop(); authorized = true; hub = new ThreadEventHub(options);
  await hub.synchronize('binding');
  for (let i = 0; i < 20 && !frames.some(f => f.finalize && f.messageId === originalCard); i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, ['original']);
  const terminal = frames.find(f => f.finalize && f.messageId === originalCard);
  assert.match(terminal.text, /ORIGINAL_FINAL/); assert.doesNotMatch(terminal.text, /codex-im-gateway-actions|\/stop/);
  if (nextTurn) assert.ok(frames.some(f => f.messageId !== originalCard && f.text.includes('NEW_PROGRESS') && !f.finalize));
  await hub.synchronize('binding'); assert.equal(actions.length, 1);
});
