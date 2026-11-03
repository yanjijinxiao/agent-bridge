import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexTurnExecutionError } from "../src/codex/backend.js";

for (const malformed of [{}, { status: null }, { status: "" }, { status: "inProgress" }, { status: "futureTerminal" }, { status: {} }]) {
  test(`an invalid completion never settles the accepted turn: ${JSON.stringify(malformed)}`, async t => {
    const runner = new AppServerCodexRunner({ requestTimeoutMs: 1000, transport: { mode: "remote-daemon",
      command: process.execPath, args: [fileURLToPath(new URL("./fixtures/malformed-completion.mjs", import.meta.url)), JSON.stringify(malformed)] } });
    t.after(() => runner.close());
    const progress: string[] = []; let accepted = 0;
    await assert.rejects(runner.run({ cwd: "/tmp", prompt: "one input", onTurnStarted() { accepted++; },
      onProgress(text) { progress.push(text); } }), error => error instanceof CodexTurnExecutionError && /authoritative failure/.test(error.message));
    assert.equal(accepted, 1);
    assert.equal(progress.filter(text => text.includes("结束状态尚未确认")).length, 1);
  });
}
