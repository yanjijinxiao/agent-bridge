import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
function fixture() {
  const fields = new Map<string, any>();
  const field = (selector: string) => { if (!fields.has(selector)) fields.set(selector, { value: "", checked: false, disabled: false, innerHTML: "", type: selector.endsWith("RepliesInput") || selector.endsWith("EnabledInput") ? "checkbox" : "text" }); return fields.get(selector); };
  const form = { querySelectorAll() { return [...fields.entries()].filter(([s]) => s.endsWith("Input")).map(([, v]) => v); }, querySelector() { return button; } };
  const button = { disabled: false };
  const context = vm.createContext({ document: { addEventListener() {}, querySelector: field }, window: {}, AbortSignal });
  vm.runInContext(source, context); const state = vm.runInContext("state", context);
  state.config = { defaultCwd: "/saved", allowedWorkspaces: ["/saved"], model: "a", effort: "low", bindingIdleDays: 15 };
  state.codexModels = [{ model: "a", supportedEfforts: [{ effort: "low" }] }, { model: "b", supportedEfforts: [{ effort: "high" }] }];
  context.renderTaskboardStatus = () => {}; context.renderAll = () => context.renderSettings(); context.refreshTaskboardIssues = async () => {};
  const notices: string[] = []; context.toast = (text: string) => notices.push(text);
  context.renderSettings();
  const pending = Promise.withResolvers<any>(), calls: any[] = [];
  context.api = async (_url: string, options: unknown) => { calls.push(options); return pending.promise; };
  const save = () => context.saveSettings({ preventDefault() {}, target: form, submitter: null });
  const confirm = () => pending.resolve({ config: { ...state.config, defaultCwd: "/confirmed" }, codexModels: state.codexModels });
  return { field, state, pending, calls, save, confirm, button, notices };
}

test("a settings acknowledgement preserves later text, checkbox and model/effort edits", async () => {
  const h = fixture(); const save = h.save();
  h.field("#defaultCwdInput").value = "/new-draft"; h.field("#streamRepliesInput").checked = true;
  h.field("#modelInput").value = "b"; h.field("#effortInput").value = "high";
  h.confirm(); await save;
  assert.equal(h.state.config.defaultCwd, "/confirmed");
  assert.equal(h.field("#defaultCwdInput").value, "/new-draft");
  assert.equal(h.field("#streamRepliesInput").checked, true);
  assert.equal(h.field("#modelInput").value, "b"); assert.equal(h.field("#effortInput").value, "high");
  assert.equal(h.calls[0].body.defaultCwd, "/saved"); assert.equal(h.calls[0].body.model, "a");
  assert.match(h.notices.at(-1)!, /未保存/);
});
test("a second settings submit cannot race the pending write", async () => {
  const h = fixture(); const first = h.save(); const second = h.save();
  h.confirm(); await Promise.all([first, second]); assert.equal(h.calls.length, 1); assert.equal(h.button.disabled, false);
});
test("unchanged settings accept the confirmed values and failure retains the draft for explicit retry", async () => {
  const h = fixture(); const save = h.save(); h.confirm(); await save;
  assert.equal(h.field("#defaultCwdInput").value, "/confirmed");
  const failed = fixture(); const attempt = failed.save(); failed.field("#defaultCwdInput").value = "/retain";
  failed.pending.reject(new Error("unknown acknowledgement")); await attempt;
  assert.equal(failed.field("#defaultCwdInput").value, "/retain"); assert.equal(failed.calls.length, 1);
  assert.equal(failed.button.disabled, false);
});
