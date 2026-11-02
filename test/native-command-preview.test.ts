import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

const secret = "SYNTHETIC_PRIVATE_VALUE";
for (const [label, command] of [
  ["quoted environment assignment", `OPENAI_API_KEY='${secret} with spaces' node worker.js`],
  ["JSON string field", `curl -d '{"api_key":"${secret}"}' https://example.invalid`],
  ["separate argv credential", ["tool", "--token", secret]],
  ["URL user info", `curl https://user:${secret}@example.invalid/data`],
  ["bearer authorization", `curl -H 'Authorization: Bearer ${secret}' https://example.invalid`],
  ["ordinary command", "node --version"],
] as const) {
  test(`public native progress hides credentials in ${label}`, { timeout: 5000 }, async t => {
    const runner = new AppServerCodexRunner({ requestTimeoutMs: 1000, transport: { command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/callback-notification-app-server.mjs", import.meta.url)), "command-preview", JSON.stringify(command)], mode: "daemon-proxy" } });
    t.after(() => runner.close());
    const progress = Promise.withResolvers<string>();
    await runner.observeThreadInteractions("thread", { onApproval: async () => undefined, onProgress: (_scope, text) => { progress.resolve(text); } });
    await runner.getRuntimeInfo("/tmp");
    const text = await progress.promise;
    assert.match(text, /正在执行命令/);
    assert.ok(!text.includes(secret), "the protocol command must not publish credential bytes into IM progress");
    if (label === "ordinary command") assert.match(text, /node --version/);
  });
}
