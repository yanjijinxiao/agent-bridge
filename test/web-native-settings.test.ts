import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
for (const field of ["model", "effort", "stream", "refresh"]) test(`Web ${field} changes do not replay unrelated stale execution settings`, async () => {
  const session = { accountId: "account", id: "chosen", streamReplies: true };
  const calls: any[] = [], state = { sessions: [session], savingRuntimeSessions: new Set(), sessionRuntimes: new Map() };
  const context = vm.createContext({ state, selectedSession: () => session, sessionKey: () => "account:chosen", isSessionSavingRuntime: () => false,
    els: { sessionModelInput: { value: field === "refresh" ? "" : "stale-model" }, sessionEffortInput: { value: "high" }, sessionStreamInput: { value: "off" }, sessionRuntimeToolbar: { dataset: {} } },
    async api(url: string, options: any) { calls.push([url, options]); return options ? { session } : { runtime: { model: "desktop-choice", effort: "low" } }; },
    renderChatPanel() {}, renderSessions() {}, toast() {}, async refreshData() {} });
  const start = source.indexOf("async function saveSessionRuntimeSettings(");
  vm.runInContext(source.slice(start, source.indexOf("\nfunction renderTypingIndicator(", start)), context);
  await vm.runInContext(`saveSessionRuntimeSettings("${field === "refresh" ? "model" : field}")`, context);
  if (field === "refresh") {
    assert.equal(calls.length, 1); assert.equal(calls[0][1], undefined);
    assert.equal(state.sessionRuntimes.get("account:chosen").model, "desktop-choice"); return;
  }
  const expected = field === "stream" ? { streamReplies: false } : field === "effort" ? { effort: "high" } : { model: "stale-model" };
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1].body)), expected);
  assert.equal(calls[1][0], "/api/sessions/account/chosen/runtime");
  assert.equal(state.sessionRuntimes.get("account:chosen").model, "desktop-choice");
});
