import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {AppServerCodexRunner} from "../src/codex/app-server-runner.js";

for (const timestamp of [1e40, 1e308, 1780000000, 1780000000000]) {
  test(`native metadata and history ignore unrepresentable dates without dropping the thread (${timestamp})`, async t => {
    const runner = new AppServerCodexRunner({requestTimeoutMs:1000,transport:{mode:"remote-daemon",command:process.execPath,
      args:[fileURLToPath(new URL("./fixtures/snapshot-completion.mjs",import.meta.url)),"completed",String(timestamp)]}});
    t.after(() => runner.close());
    const state = await runner.inspectThread("thread");
    const snapshot = await runner.readThreadSnapshot("thread");
    assert.equal(state.threadId,"thread"); assert.equal(snapshot.turns[0].id,"turn");
    const expected = timestamp > 1e30 ? undefined : new Date(1780000000000).toISOString();
    assert.equal(state.updatedAt,expected); assert.equal(snapshot.turns[0].startedAt,expected);
  });
}
