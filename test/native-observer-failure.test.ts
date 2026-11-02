import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const kind of ["progress", "approval", "mcp", "user-input"]) for (const failure of ["throw", "reject"]) {
  test(`${kind} observer ${failure} is contained without crashing, disconnecting or answering the native request`, async () => {
    const module = new URL("../src/codex/app-server-runner.ts", import.meta.url).href;
    const fixture = fileURLToPath(new URL("./fixtures/callback-notification-app-server.mjs", import.meta.url));
    const script = `
      import assert from 'node:assert/strict';
      import { AppServerCodexRunner } from ${JSON.stringify(module)};
      const runner = new AppServerCodexRunner({requestTimeoutMs:1000,transport:{command:process.execPath,args:[${JSON.stringify(fixture)},${JSON.stringify(kind)}],mode:'daemon-proxy'}});
      let calls = 0;
      const notify = () => { calls++; ${failure === "throw" ? "throw new Error('synthetic observer failure');" : "return Promise.reject(new Error('synthetic observer failure'));"} };
      try {
        await runner.observeThreadInteractions('thread', {onApproval:async()=>undefined,
          ${kind === "progress" ? "onProgress" : "onUnsupportedInteraction"}:notify});
        await runner.getRuntimeInfo('/tmp');
        for(let n=0;calls===0 && n<100;n++) await new Promise(r=>setTimeout(r,10));
        assert.equal(calls,1);
        await new Promise(r=>setTimeout(r,20));
        assert.equal(runner.interactionSubscriptionReady('thread'),true);
        assert.equal((await runner.getRuntimeInfo('/tmp')).model,'fixture');
        process.stdout.write('OBSERVER_FAILURE_CONTAINED');
      } finally { await runner.close(); }
    `;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
      { timeout: 10000, maxBuffer: 20000 });
    assert.equal(result.stdout, "OBSERVER_FAILURE_CONTAINED");
  });
}
