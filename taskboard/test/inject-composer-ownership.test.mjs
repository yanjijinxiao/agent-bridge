import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
const functions = source.slice(source.indexOf("  function projectRowById("), source.indexOf("  function buildAutomationHostPayload("));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness() {
  const workspace = deferred(), prefill = deferred();
  const navigation = [], messages = [], prefills = [];
  const originalFrame = { contentWindow: { postMessage(m) { messages.push(m); } } };
  const scope = vm.createContext({
    pendingThreadCreation: null, threadCreationSequence: 0, destroyed: false,
    frame: originalFrame, frameOrigin: "http://localhost:3030", hostContextSnapshot: {},
    normalizedLabel: value => String(value ?? "").trim().toLowerCase(),
    window: { electronBridge: { sendMessageFromView() { return workspace.promise; } }, location: { href: "https://codex.local/" }, setTimeout },
    closeTaskboard() {}, dispatchHostMessage(m) { navigation.push(m); },
    requestHostTaskComposerPrefill(m) { prefills.push(m); return prefill.promise; },
    postToFrame(m) { scope.frame.contentWindow.postMessage(m); },
  });
  vm.runInContext(functions + "\nwaitForPreparedComposer = async () => {};", scope);
  const run = () => scope.createThreadForTask({ taskId: "task", identifier: "TASK-1", workspacePath: "/tmp/workspace",
    instruction: "do task", skillName: "manage-taskboard", skillDisplayName: "Taskboard", skillPath: "/tmp/SKILL.md" });
  return { scope, run, workspace, prefill, navigation, messages, prefills };
}

for (const invalidation of ["destroy", "frame", "cancel"]) test(`retired task preparation cannot navigate after workspace await (${invalidation})`, async () => {
  const h = harness(); const done = h.run();
  if (invalidation === "destroy") h.scope.destroyed = true;
  if (invalidation === "frame") h.scope.frame = { contentWindow: { postMessage() { throw new Error("wrong frame"); } } };
  if (invalidation === "cancel") h.scope.pendingThreadCreation = null;
  h.workspace.resolve(); h.prefill.resolve(); await done;
  assert.equal(h.navigation.length, 0); assert.equal(h.prefills.length, 0);
});

test("a late preparation cannot report success or clear a newer operation", async () => {
  const h = harness(); const done = h.run(); h.workspace.resolve();
  const deadline = Date.now() + 2000;
  while (!h.prefills.length && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.prefills.length, 1, "prefill never reached");
  const newer = { id: "new-operation" }; h.scope.pendingThreadCreation = newer;
  h.prefill.resolve(); await done;
  assert.equal(h.scope.pendingThreadCreation, newer);
  assert.equal(h.messages.some(m => m.type === "taskboard:thread-prepared"), false);
});

test("the unchanged task preparation still opens one unsent composer", async () => {
  const h = harness(); const done = h.run(); h.workspace.resolve(); h.prefill.resolve(); await done;
  assert.equal(h.navigation.length, 1); assert.equal(h.prefills.length, 1);
  assert.equal(h.messages.at(-1).type, "taskboard:thread-prepared");
  assert.equal(h.scope.pendingThreadCreation, null);
});

// Exercise the actual close/click/route hooks as well as the async handler.
// DOM navigation remains a controlled boundary; no live Desktop is modified.
function lifecycleHarness() {
  const messages = [];
  const frame = { contentWindow: { postMessage(m) { messages.push(m); } } };
  const operation = { id: "operation", taskId: "task", frame, source: frame.contentWindow, origin: "http://localhost:3030" };
  const scope = vm.createContext({
    pendingThreadCreation: operation, frame, frameOrigin: operation.origin, destroyed: false,
    active: false, page: { hidden: true }, normalizeThreadId: value => value || "",
    isNativePageNavigation: () => true, lastNativeThreadId: "",
  });
  const helpers = source.slice(source.indexOf("  function isCurrentThreadCreation("), source.indexOf("  function prefillTaskComposerStep("));
  const close = source.slice(source.indexOf("  function closeTaskboard("), source.indexOf("  function openTaskboard("));
  const click = source.slice(source.indexOf("  function onDocumentClick("), source.indexOf("  function scheduleRefresh("));
  const route = source.slice(source.indexOf("  function onNativeRouteChange("), source.indexOf("\n  const api ="));
  vm.runInContext(helpers + close + click + route, scope);
  return { scope, operation, messages };
}

test("closing an already hidden panel still cancels its pending composer preparation", () => {
  const h = lifecycleHarness(); h.scope.closeTaskboard(false);
  assert.equal(h.scope.pendingThreadCreation, null); assert.equal(h.messages.length, 1);
});
test("the operation's own close and project click preserve it but the next navigation cancels it", () => {
  const h = lifecycleHarness(); h.scope.closeTaskboard(false, true);
  h.operation.nativeClick = true; h.scope.onDocumentClick({ target: {} });
  assert.equal(h.scope.pendingThreadCreation, h.operation);
  h.operation.nativeClick = false; h.scope.onDocumentClick({ target: {} });
  assert.equal(h.scope.pendingThreadCreation, null);
});
test("a requested home route can finish before claiming the composer; later route changes cancel", () => {
  const h = lifecycleHarness(); h.operation.navigating = true; h.scope.onNativeRouteChange();
  assert.equal(h.scope.pendingThreadCreation, h.operation);
  h.operation.navigating = false; h.scope.onNativeRouteChange();
  assert.equal(h.scope.pendingThreadCreation, null);
});
test("trusted user input cancels a pending own navigation", () => {
  const h = lifecycleHarness(); h.operation.navigating = true;
  h.scope.onUserComposerInteraction({ isTrusted: false }); assert.equal(h.scope.pendingThreadCreation, h.operation);
  h.scope.onUserComposerInteraction({ isTrusted: true }); assert.equal(h.scope.pendingThreadCreation, null);
});
