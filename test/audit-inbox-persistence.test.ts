import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { SessionControlJournal } from '../src/bridge/session-control.js';
import { NativeQueueCoordinator, type QueueOrigin } from '../src/bridge/native-queue.js';
import { APP_SERVER_BACKEND_CAPABILITIES, type CodexBridgeBackend } from '../src/codex/backend.js';

for (const mode of ['normal', 'failure']) test(`inbox real timer survives ${mode} cleanup and never resubmits accepted input`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-inbox-timer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'test/fixtures/inbox-timer-failure.mjs', root, mode],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)!), { writes: 1, rows: 0, phase: 'handled' });
});

test('a failed control choice claim leaves the live journal consistent with disk and permits explicit retry', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-control-disk-')), file = path.join(root, 'controls.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controls = new SessionControlJournal(file);
  const choice = controls.createChoice({ actorId: 'actor', conversationId: 'room', sessionId: 'session',
    hostId: 'local', threadId: 'thread', turnId: 'turn', prompt: 'work', items: [] });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === file) throw Error('synthetic disk failure');
    return rename(from, to);
  };
  try { assert.throws(() => controls.claimChoice(choice.id, 'actor', 'room', false), /synthetic disk failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).choices[choice.id].status, 'pending');
  assert.equal(controls.claimChoice(choice.id, 'actor', 'room', false).status, 'submitted');
  assert.throws(() => new SessionControlJournal(file).claimChoice(choice.id, 'actor', 'room', false), /已处理/);
});

test('a failed pre-submit journal write performs no native call and does not leave a phantom live claim', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-control-before-')), file = path.join(root, 'controls.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controls = new SessionControlJournal(file); let writes = 0;
  const action = async () => { writes++; return { status: 'accepted' as const, threadId: 'thread', turnId: 'turn' }; };
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === file) throw Error('synthetic disk failure');
    return rename(from, to);
  };
  try { await assert.rejects(controls.submit('scope', 'source', action), /synthetic disk failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(writes, 0);
  assert.equal((await controls.submit('scope', 'source', action)).turnId, 'turn');
  assert.equal(writes, 1);
});

test('an acceptance already renamed to disk survives a later directory fsync error without replay', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-control-after-')), file = path.join(root, 'controls.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controls = new SessionControlJournal(file), key = JSON.stringify(['local', 'thread']);
  let writes = 0, fail = false;
  const sync = fs.fsyncSync;
  fs.fsyncSync = fd => {
    if (fail && fs.fstatSync(fd).isDirectory()) { fail = false; throw Error('synthetic directory flush failure'); }
    return sync(fd);
  };
  const action = async () => { writes++; fail = true; return { status: 'accepted' as const, threadId: 'thread', turnId: 'turn' }; };
  try { await assert.rejects(controls.submit(key, 'source', action, 'local'), /synthetic directory flush failure/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(controls.acceptedPresentationInputs().length, 1);
  assert.equal((await controls.submit(key, 'source', action, 'local')).turnId, 'turn');
  assert.equal((await new SessionControlJournal(file).submit(key, 'source', action, 'local')).turnId, 'turn');
  assert.equal(writes, 1);
});

for (const boundary of ['before-submit', 'after-acceptance'] as const) test(`native queue journal handles ${boundary} disk failure without a phantom claim or replay`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-queue-disk-')), file = path.join(root, 'queue.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const queue = new NativeQueueCoordinator(file);
  const origin: QueueOrigin = { accountId: 'account', conversationId: 'room', actorId: 'actor', messageId: 'message',
    sessionId: 'session', hostId: 'local', backend: 'app-server', threadId: 'thread' };
  let writes = 0, flushFailure = false;
  const backend = {
    backendInfo: () => ({ id: 'app-server', capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
    async addQueuedSubmission(input: { clientUserMessageId: string }) {
      writes++; flushFailure = boundary === 'after-acceptance';
      return { id: 'native-queue-id', clientUserMessageId: input.clientUserMessageId, input: [] };
    }
  } as unknown as CodexBridgeBackend;
  const rename = fs.renameSync, sync = fs.fsyncSync;
  fs.renameSync = (from, to) => {
    if (boundary === 'before-submit' && String(to) === file) throw Error('synthetic pre-submit failure');
    return rename(from, to);
  };
  fs.fsyncSync = fd => {
    if (flushFailure && fs.fstatSync(fd).isDirectory()) { flushFailure = false; throw Error('synthetic acceptance flush failure'); }
    return sync(fd);
  };
  try { await assert.rejects(queue.enqueue(origin, 'work', backend), /synthetic/); }
  finally { fs.renameSync = rename; fs.fsyncSync = sync; }
  assert.equal(writes, boundary === 'before-submit' ? 0 : 1);
  assert.deepEqual(queue.list('account'), new NativeQueueCoordinator(file).list('account'));
  const receipt = await queue.enqueue(origin, 'work', backend);
  assert.equal(receipt.status, 'queued'); assert.equal(receipt.queuedSubmissionId, 'native-queue-id');
  assert.equal(writes, 1);
  assert.deepEqual(await new NativeQueueCoordinator(file).enqueue(origin, 'work', backend), JSON.parse(JSON.stringify(receipt)));
  assert.equal(writes, 1);
});

test('queue persistence recovery preserves another thread awaiting native acceptance', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-queue-concurrent-')), file = path.join(root, 'queue.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const queue = new NativeQueueCoordinator(file), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const origin: QueueOrigin = { accountId: 'account', conversationId: 'room', actorId: 'actor', messageId: 'one',
    sessionId: 'session', hostId: 'local', backend: 'app-server', threadId: 'one' };
  let writes = 0;
  const backend = {
    backendInfo: () => ({ id: 'app-server', capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
    async addQueuedSubmission(input: { clientUserMessageId: string }) {
      writes++; entered.resolve(); await finish.promise;
      return { id: 'accepted-one', clientUserMessageId: input.clientUserMessageId, input: [] };
    }
  } as unknown as CodexBridgeBackend;
  const pending = queue.enqueue(origin, 'work', backend); await entered.promise;
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to) === file) throw Error('synthetic disk failure'); return rename(from, to); };
  try { await assert.rejects(queue.enqueue({ ...origin, messageId: 'two', threadId: 'two' }, 'other', backend), /synthetic/); }
  finally { fs.renameSync = rename; finish.resolve(); }
  assert.equal((await pending).queuedSubmissionId, 'accepted-one'); assert.equal(writes, 1);
  const saved = new NativeQueueCoordinator(file).list('account');
  assert.equal(saved.length, 1); assert.equal(saved[0].status, 'queued'); assert.equal(saved[0].queuedSubmissionId, 'accepted-one');
});
