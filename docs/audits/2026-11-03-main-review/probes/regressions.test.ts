// Audit counterexamples at 3d5bff7: expected failures, outside the default test glob.
import test from 'node:test';
import assert from 'node:assert/strict';
import { peerFixture } from '../../../../test/peer-fixture.js';
import { APP_SERVER_BACKEND_CAPABILITIES, EXEC_BACKEND_CAPABILITIES } from '../../../../src/codex/backend.js';
import { setup } from './account-fixture.js';
import { fileURLToPath } from 'node:url';
import { AppServerCodexRunner } from '../../../../src/codex/app-server-runner.js';

for (const broken of [false, true]) test(`fresh native input waits for durable thread callback: ${broken ? 'failed journal' : 'normal control'}`, async t => {
  const f = await peerFixture(t, { device: true }); await f.bind();
  let nativeStarts = 0, acknowledged = false;
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 2000, transport: { command: process.execPath,
    args: [fileURLToPath(new URL('../../../../test/fixtures/fake-codex-app-server.mjs', import.meta.url))], mode: 'remote-daemon' } });
  t.after(() => runner.close());
  const request = (runner as any).request.bind(runner);
  (runner as any).request = async (method: string, ...args: unknown[]) => {
    if (method === 'turn/start') nativeStarts++;
    return request(method, ...args);
  };
  f.run = input => runner.run(input);
  let failed = false;
  try { await f.as(() => f.facade.run(f.input({ threadId: undefined, cwd: f.root,
    onThreadCreated: () => { if (broken) throw Error('synthetic durable receipt write failure'); acknowledged = true; }
  }))); } catch { failed = true; }
  assert.equal(acknowledged, !broken);
  assert.equal(nativeStarts, broken ? 0 : 1, 'do not start an input whose new thread identity was not persisted by Gateway');
  assert.equal(failed, broken);
});

for (const backend of ['app-server', 'exec'] as const) test(`peer independent interactions must survive local backend ${backend}`, async t => {
  const f = setup(t, { config: { codexBackend: backend, streamReplies: false } });
  const host = 'peer:laptop:work';
  Object.assign(f.runner, {
    backendInfo: (id?: string) => id === host || backend === 'app-server'
      ? { id: 'app-server', capabilities: APP_SERVER_BACKEND_CAPABILITIES }
      : { id: 'exec', capabilities: EXEC_BACKEND_CAPABILITIES },
    async readThreadSnapshot(threadId: string) { return { state: { threadId, persistence: 'active', runtimeStatus: 'idle', activeFlags: [] }, turns: [] }; }
  });
  await f.manager.startAccount('account-one', false);
  const bridge = f.bridges.get('account-one')!;
  const session = bridge.stateStore.createSession('peer-chat', '/device-workspace', 'remote', undefined, 'session', undefined, { standalone: true, hostId: host });
  bridge.stateStore.setSessionThread(session.id, 'peer-thread');
  (f.manager as any).refreshNativeRequestSubscriptions();
  assert.equal((await bridge.sessionFollow!.synchronize(bridge.stateStore.getSession(session.id)!)).status, 'synced');
  assert.ok(f.currentlyFollowed.has(JSON.stringify([host, 'peer-thread'])), 'a capable peer must have an independent approval observer');
});

for (const status of ['starting', 'error'] as const) test(`receive transport ${status} must not detach running task card`, async t => {
  const f = setup(t);
  Object.assign(f.runner, { async readThreadSnapshot(threadId: string) {
    return { state: { threadId, persistence: 'active', runtimeStatus: 'active', activeFlags: [], activeTurnId: 'turn' }, turns: [{ id: 'turn', status: 'inProgress', messages: [] }] };
  } });
  await f.manager.startAccount('account-one', false);
  const bridge = f.bridges.get('account-one')!, store = bridge.stateStore;
  const session = store.createSession('chat', f.root, 'active'); store.setSessionThread(session.id, 'thread');
  const hub = (f.manager as any).threadEvents;
  await hub.started('local', 'thread', 'turn', new Date().toISOString());
  await hub.activity('local', 'thread', 'turn', '正在审查代码');
  assert.ok(f.streamStarts.length > 0, 'control creates a real managed progress stream');
  // Exact assignment made by AccountManager.onStatus; monitor/client stay live.
  (f.manager as any).entries.get('account-one').status = status;
  await hub.refresh();
  assert.equal(store.getBoundSession('chat')?.id, session.id);
  assert.equal(f.streamUpdates.filter(row => row.text.includes('已停止跟随此会话')).length, 0, 'receive connection health is not unsubscribe intent');
});
