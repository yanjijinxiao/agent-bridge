import assert from "node:assert/strict";
import test from "node:test";
import { sharedNativeCore } from "./fixtures/shared-native-core.mjs";

for (const mode of ["new", "empty-same-client", "empty-other-client", "continued-other-client"] as const) test(`native model receives bridge instructions on ${mode} thread`, {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30000
}, async t => {
  const core = await sharedNativeCore(t), runner = core.runner();
  const creator = mode.endsWith("other-client") ? core.runner() : runner;
  const thread = mode === "new" ? undefined : mode.startsWith("continued")
    ? await creator.run({ cwd: core.root, prompt: "seed", developerInstructions: "Original rule retained by native" })
    : await creator.createThread({ cwd: core.root, projectBinding: "none", title: "Instructions regression" });
  if (creator !== runner) await creator.close();
  const rule = "BRIDGE-INSTRUCTION-REGRESSION: file replies must use the send array.";
  await runner.run({ cwd: core.root, threadId: thread?.threadId, prompt: "reply done", developerInstructions: rule });
  assert.equal(core.calls.length, mode.startsWith("continued") ? 2 : 1);
  assert.ok(JSON.stringify(core.calls.at(-1)).includes(rule), "the actual model request must contain the bridge rule, not only the RPC fixture");
  if (mode.startsWith("continued")) assert.ok(JSON.stringify(core.calls.at(-1)).includes("Original rule retained by native"));
  const nextRule = "BRIDGE-INSTRUCTION-UPDATED: use the new file schema.";
  await runner.run({ cwd: core.root, threadId: thread?.threadId ?? (await runner.listThreads())[0].threadId,
    prompt: "second input", developerInstructions: nextRule });
  assert.ok(JSON.stringify(core.calls.at(-1)).includes(nextRule), "a retained subscription also receives updated application context");
});
