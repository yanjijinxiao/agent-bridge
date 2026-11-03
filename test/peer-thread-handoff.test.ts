import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { peerFixture } from './peer-fixture.js';
import { AppServerCodexRunner } from '../src/codex/app-server-runner.js';

for (const broken of [false, true]) test(`fresh native input waits for durable thread callback: ${broken ? 'failed journal' : 'normal control'}`, async t => {
  const f = await peerFixture(t, { device: true }); await f.bind();
  let nativeStarts = 0, acknowledged = false;
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 2000, transport: { command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url))], mode: 'remote-daemon' } });
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

