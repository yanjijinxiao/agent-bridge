import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

for (const latest of ["completed", "failed", "interrupted", "inProgress"]) {
  test(`unknown native runtime remains unknown when historical tail is ${latest}`, async t => {
    const runner = new AppServerCodexRunner({ requestTimeoutMs: 1000, catalogSource: "native", transport: {
      command: process.execPath, args: [fileURLToPath(new URL("./fixtures/runtime-state-app-server.mjs", import.meta.url)), "future-native-state", latest], mode: "daemon-proxy"
    } }); t.after(() => runner.close());
    const state = await runner.inspectThread("thread");
    assert.equal(state.runtimeStatus, "unknown", "historical turn status cannot certify the live runtime owner");
    assert.equal(state.latestTurnStatus, latest, "the actual history fact is retained separately");
  });
}
