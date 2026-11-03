import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The fixture owns a real native core, temporary home and local fake model.
import { sharedNativeCore } from "./fixtures/shared-native-core.mjs";

for (const mode of ["stdio", "daemon"] as const) {
  test(`native empty session survives metadata reads until its first input (${mode})`, {
    skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30_000
  }, async t => {
    const core = await sharedNativeCore(t);
    const runner = core.runner(mode === "stdio" ? {
      transport: undefined, codexBin: process.env.CODEX_NATIVE_QUEUE_TEST_BIN
    } : {});
    const created = await runner.createThread({ cwd: core.root, projectBinding: "none", title: "Empty session" });
    assert.equal(core.calls.length, 0, "creation must not submit placeholder input");
    const state = await runner.inspectThread(created.threadId);
    assert.equal(state.persistence, "active", "idle transport retirement must not discard the native empty session");
    assert.equal((await runner.readThreadSnapshot(created.threadId)).turns.length, 0);
    const result = await runner.run({ threadId: created.threadId, cwd: core.root, prompt: "first input", clientUserMessageId: "empty-first" });
    assert.equal(result.threadId, created.threadId);
    assert.equal(core.calls.length, 1, "first input executes exactly once in the created thread");
    assert.equal(result.text, "DONE_1");
  });
}
