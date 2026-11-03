// Audit counterexamples at 3d5bff7: expected failures, outside the default test glob.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ThreadEventHub, type ThreadSubscription } from '../../../../src/server/thread-event-hub.js';

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
  await hub.synchronize('binding');
  assert.ok(writes.some(text=>text.includes('CURRENT_REVIEW_PROGRESS')),
    'read-only progress from an active owner must not be discarded by unrelated input receipt recovery');
});
