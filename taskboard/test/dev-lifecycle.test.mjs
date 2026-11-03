import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';

const script = new URL('../scripts/dev.mjs', import.meta.url);
const source = (await readFile(script, 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(script.href));
function start(spawnImpl) {
  const runtime = new EventEmitter();
  Object.assign(runtime, { execPath: process.execPath, platform: process.platform });
  const calls = [], children = [], errors = [];
  vm.runInNewContext(source, { process: runtime, createRequire, dirname, join,
    console: { error: (...args) => errors.push(args.join(' ')) },
    spawn(...args) {
      calls.push(args);
      const child = spawnImpl ? spawnImpl(...args) : new EventEmitter();
      if (!spawnImpl) Object.assign(child, { exitCode: null, signalCode: null, kills: [], kill(signal) { this.kills.push(signal); } });
      children.push(child); return child;
    },
  });
  return { runtime, calls, children, errors };
}
for (const [code, signal, expected] of [[0, null, 0], [2, null, 2], [null, 'SIGTERM', 1]]) {
  test(`either dev service ending (${code}/${signal}) stops its sibling`, () => {
    const f = start(); Object.assign(f.children[1], { exitCode: code, signalCode: signal });
    f.children[1].emit('exit', code, signal);
    assert.deepEqual(f.children[0].kills, ['SIGTERM']);
    assert.deepEqual(f.children[1].kills, []);
    assert.equal(f.runtime.exitCode, expected);
    f.runtime.emit('SIGINT'); assert.deepEqual(f.children[0].kills, ['SIGTERM']);
  });
}
test('failed spawn is handled, reports the cause and stops the other dev service', () => {
  const f = start(); f.children[1].emit('error', Error('spawn ENOENT'));
  assert.deepEqual(f.children[0].kills, ['SIGTERM']);
  assert.equal(f.runtime.exitCode, 1); assert.match(f.errors.join('\n'), /ENOENT/);
});
test('both development commands use the current Node, without an npm wrapper child', () => {
  const f = start();
  assert.deepEqual(f.calls.map(call => call[0]), [process.execPath, process.execPath]);
  assert.match(f.calls[1][1][0], /[\\/]vite[\\/]bin[\\/]vite\.js$/);
  f.runtime.emit('SIGTERM');
  assert.equal(f.runtime.exitCode, 0);
  assert.ok(f.children.every(child => child.kills.length === 1));
});
test('real temporary child exit closes the remaining process without leaving a half-running stack', async t => {
  let index = 0;
  const f = start(() => realSpawn(process.execPath, ['-e', index++ === 0 ? 'setInterval(()=>{},1000)' : 'process.exit(0)'], { stdio: 'ignore' }));
  t.after(() => f.children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }));
  const timeout = setTimeout(() => f.children.forEach(child => child.kill('SIGKILL')), 2000);
  try {
    await Promise.all(f.children.map(child => new Promise(resolve => child.on('exit', resolve))));
    assert.equal(f.children[0].signalCode, 'SIGTERM');
    assert.equal(f.runtime.exitCode, 0);
  } finally { clearTimeout(timeout); }
});
