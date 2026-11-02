import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

for (const mode of ['normal', 'closed-input']) {
  test(`quota probe ${mode} completes without terminating its host process`, { skip: process.platform === 'win32' }, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'taskboard-quota-pipe-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    // An injected adapter rejects like a broken pipe. The quota helper itself
    // has no CLI transport or child process to crash its caller.
    const module = new URL('../scripts/codex-rate-limits.mjs', import.meta.url).href;
    const script = `import {readCodexQuotaStatus} from ${JSON.stringify(module)};
const result=await readCodexQuotaStatus('fixture-model', {async getAccountRateLimits(){
if(process.env.QUOTA_FIXTURE_MODE==='closed-input')throw Object.assign(new Error('isolated broken pipe'),{code:'EPIPE'});
return {primary:{usedPercent:0}};}});
process.stdout.write(JSON.stringify({state:result.state,checked:Number.isFinite(result.checkedAt)}));`;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, QUOTA_FIXTURE_MODE: mode },
      timeout: 7000, maxBuffer: 10000,
    }).catch(error => { throw new Error(`Quota host terminated: ${error.stderr}`, { cause: error }); });
    assert.deepEqual(JSON.parse(result.stdout), { state: mode === 'normal' ? 'available' : 'unknown', checked: true });
  });
}
