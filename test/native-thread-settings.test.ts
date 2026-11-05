import assert from "node:assert/strict";
import test from "node:test";
import { sharedNativeCore, until } from "./fixtures/shared-native-core.mjs";

test("native settings survive client replacement and desktop edits govern ordinary continuation", {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 60_000
}, async t => {
  const f = await sharedNativeCore(t), desktop = await f.rpc("settings_owner"), bridge = f.runner();
  const created = await desktop.request("thread/start", { cwd: f.root, ephemeral: false });
  const id = created.thread.id;
  await desktop.request("thread/name/set", { threadId: id, name: "Settings regression" });
  await bridge.updateThreadSettings(id, { model: "mock-model-im", effort: "high" });
  assert.equal(f.calls.length, 0, "settings must not start a placeholder turn");
  assert.equal((await desktop.request("thread/read", { threadId: id, includeTurns: false })).thread.model, "mock-model-im");
  await desktop.request("thread/settings/update", { threadId: id, model: "mock-model-desktop", effort: "low" });
  await until(() => desktop.events.some(e => e.method === "thread/settings/updated" && e.params.threadSettings.model === "mock-model-desktop"));
  assert.equal((await bridge.getRuntimeInfo(f.root, id)).model, "mock-model-desktop", "a previous read must not pin the model");
  assert.equal((await bridge.getRuntimeInfo(f.root, id)).effort, "low");
  await bridge.close();
  const replacement = f.runner();
  assert.equal((await replacement.getRuntimeInfo(f.root, id)).model, "mock-model-desktop");
  const plan = await replacement.updateThreadSettings(id, { collaborationMode: "plan" });
  assert.equal(plan.collaborationMode, "plan");
  await until(() => desktop.events.some(e => e.method === "thread/settings/updated" && e.params.threadSettings.collaborationMode.mode === "plan"));
  const snapshot = desktop.events.filter(e => e.method === "thread/settings/updated").at(-1).params.threadSettings;
  assert.equal(snapshot.collaborationMode.mode, "plan");
  assert.equal(snapshot.model, "mock-model-desktop");
  assert.equal(snapshot.effort, "low");
  const normal = await replacement.updateThreadSettings(id, { collaborationMode: "toggle" });
  assert.equal(normal.collaborationMode, "default");
  await replacement.run({ threadId: id, cwd: f.root, prompt: "Continue with native settings" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].model, "mock-model-desktop");
  assert.equal(f.calls[0].reasoning?.effort, "low");
  const settings = await desktop.request("thread/resume", { threadId: id, excludeTurns: true });
  assert.deepEqual(settings.sandbox, created.sandbox, "model controls must not change execution permissions");
  assert.equal(settings.approvalPolicy, created.approvalPolicy);
  assert.equal(settings.approvalsReviewer, created.approvalsReviewer);
});

test("settings changed during a running turn affect only the next turn and do not interrupt it", {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 60_000
}, async t => {
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const f = await sharedNativeCore(t, async (_body, n) => {
    if (n === 1) await release.promise;
    return { type: "message", id: `busy_${n}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: `DONE_${n}`, annotations: [] }] };
  });
  const owner = f.runner(), control = f.runner();
  const created = await owner.createThread({ cwd: f.root, title: "Busy native settings" });
  const active = owner.run({ threadId: created.threadId, cwd: f.root, prompt: "First turn" });
  await until(() => f.calls.length === 1);
  const changed = control.updateThreadSettings(created.threadId, { model: "next-model", effort: "low" });
  // Let the native owner finish at its natural boundary; the control must not
  // stop it, create another turn or replay the first input.
  const timer = setTimeout(() => release.resolve(), 200); t.after(() => clearTimeout(timer));
  assert.match((await active).text, /DONE_1/);
  assert.equal((await changed).model, "next-model");
  assert.equal(f.calls[0].model, "mock-model");
  await owner.run({ threadId: created.threadId, cwd: f.root, prompt: "Second turn" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].model, "next-model");
  assert.equal(f.calls[1].reasoning?.effort, "low");
});
