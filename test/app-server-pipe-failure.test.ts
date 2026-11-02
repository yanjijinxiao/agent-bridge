import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("a closed relay input rejects the operation without crashing Gateway on an unhandled EPIPE", async () => {
  const module = new URL("../src/codex/app-server-runner.ts", import.meta.url).href;
  const fixture = fileURLToPath(new URL("./fixtures/closed-input-app-server.mjs", import.meta.url));
  const script = `
    import assert from 'node:assert/strict';
    import { AppServerCodexRunner } from ${JSON.stringify(module)};
    const runner = new AppServerCodexRunner({requestTimeoutMs:1000,transport:{command:process.execPath,args:[${JSON.stringify(fixture)}],mode:'daemon-proxy'}});
    try {
      await runner.getRuntimeInfo('/tmp');
      await new Promise(r=>setTimeout(r,100));
      await assert.rejects(runner.getAccountRateLimits(), /EPIPE|closed|disconnect/i);
      assert.equal(runner.hasRestartBlockingWork(), false);
      process.stdout.write('RECOVERABLE_PIPE_FAILURE');
    } finally { await runner.close(); }
  `;
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
    { timeout: 10000, maxBuffer: 10000 });
  assert.equal(result.stdout, "RECOVERABLE_PIPE_FAILURE");
});
