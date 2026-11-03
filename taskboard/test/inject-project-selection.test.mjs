import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
// Execute the production handler and its row resolvers. The DOM and desktop
// navigation are controlled boundaries; this is not a real Desktop UI test.
const functions = source.slice(source.indexOf("  function projectRowById("), source.indexOf("  function buildAutomationHostPayload("));
function harness(projects) {
  const selected = [], navigation = [], messages = [];
  const rows = projects.map(({ id, name }) => ({
    getAttribute(key) { return key.endsWith("project-id") ? id : key.endsWith("project-label") ? name : "false"; },
    querySelector() { return { click() { selected.push(id); } }; },
  }));
  const scope = vm.createContext({
    pendingThreadCreation: null, threadCreationSequence: 0, destroyed: false,
    frame: { contentWindow: {} }, frameOrigin: "http://localhost:3030",
    hostContextSnapshot: { projectId: "other" },
    document: { querySelectorAll() { return rows; } },
    normalizedLabel: value => String(value ?? "").trim().toLowerCase(),
    window: { electronBridge: { sendMessageFromView() {} }, setTimeout(fn) { fn(); } },
    closeTaskboard() {}, dispatchHostMessage(m) { navigation.push(m); },
    requestHostTaskComposerPrefill() {}, postToFrame(m) { messages.push(m); },
  });
  vm.runInContext(functions + "\nensureProjectRows = async () => {}; waitForPreparedComposer = async () => {};", scope);
  return { selected, navigation, messages, run: payload => scope.createThreadForTask({ taskId: "task", identifier: "TASK-1",
    instruction: "do task", skillName: "manage-taskboard", skillDisplayName: "Taskboard", skillPath: "/tmp/SKILL.md", ...payload }) };
}

test("an explicit project identity wins over a duplicate workspace label", async () => {
  const h = harness([{ id: "other", name: "Same" }, { id: "selected", name: "Same" }]);
  await h.run({ codexProjectId: "selected", workspaceLabel: "Same", projectName: "Same" });
  assert.deepEqual(h.selected, ["selected"]);
  assert.equal(h.navigation.length, 1);
  assert.equal(h.messages[0].type, "taskboard:thread-prepared");
});
test("a missing explicit project cannot silently select the snapshot or a matching label", async () => {
  const h = harness([{ id: "other", name: "Same" }]);
  await h.run({ codexProjectId: "missing", workspaceLabel: "Same", projectName: "Same" });
  assert.deepEqual(h.selected, []);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.messages[0].type, "taskboard:thread-create-error");
});
test("a unique legacy project label still opens its selected composer", async () => {
  const h = harness([{ id: "only", name: "Unique" }]);
  await h.run({ projectName: "Unique" });
  assert.deepEqual(h.selected, ["only"]);
  assert.equal(h.messages[0].type, "taskboard:thread-prepared");
});
test("a duplicate legacy label never picks the first project", async () => {
  const h = harness([{ id: "a", name: "Same" }, { id: "b", name: "Same" }]);
  await h.run({ workspaceLabel: "Same", projectName: "Same" });
  assert.deepEqual(h.selected, []);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.messages[0].type, "taskboard:thread-create-error");
});
