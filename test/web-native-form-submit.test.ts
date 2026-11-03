import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

// requestSubmit() without a button and implicit keyboard submission may expose
// a null SubmitEvent.submitter. Exercise the actual form handlers, including
// their outgoing payload, rather than asserting an implementation spelling.
function fixture(knowledge = false) {
  const fields = new Map<string, any>();
  const field = (id: string) => {
    if (!fields.has(id)) fields.set(id, { value: "", checked: false, hidden: false,
      dataset: {}, disabled: false, textContent: "", setAttribute() {}, focus() {}, select() {} });
    return fields.get(id);
  };
  const label = { textContent: "保存" };
  const button = { disabled: false, querySelector: () => label };
  const dialog = () => ({ open: true, close() { this.open = false; }, querySelector: () => button,
    querySelectorAll: () => [button] });
  const context = vm.createContext({ document: { addEventListener() {}, querySelector: field, querySelectorAll: () => [] },
    window: {}, channelModeSettings: { serialize: () => ({}) } });
  vm.runInContext(fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8"), context);
  const state = vm.runInContext("state", context), els = vm.runInContext("els", context);
  state.accounts = [{ accountId: "one", channel: "wecom" }];
  state.config = {};
  for (const name of ["removeAccountDialog", "accountDialog", "channelDialog", "projectNotificationDialog", "taskboardActionDialog"])
    els[name] = dialog();
  const requests: Array<{ url: string; options: any }> = [], notices: string[] = [];
  context.api = async (url: string, options: any) => {
    requests.push({ url, options });
    return { config: {}, codexRuntime: {}, knowledgeBase: { id: "saved", accountId: "one" } };
  };
  for (const name of ["refreshData", "refreshTaskboardIssues", "loadTaskboardIssueDetail", "renderAll", "drawIcons"])
    context[name] = async () => {};
  context.toast = (message: string) => notices.push(message);
  if (knowledge) {
    vm.runInContext(fs.readFileSync(new URL("../src/web/knowledge-bases.js", import.meta.url), "utf8"), context);
    fields.set("#knowledgeBaseDialog", dialog());
  }
  return { context, state, field, button, requests, notices, controls: () => [...fields.values()] };
}

const scenarios = [
  { name: "remove account", handler: "removeAccount", form: "removeAccountForm", setup(f: ReturnType<typeof fixture>) {
    f.field("#removingAccountId").value = "one";
  }, url: "/api/accounts/one", method: "DELETE" },
  { name: "account settings", handler: "saveAccountSettings", form: "accountForm", setup(f: ReturnType<typeof fixture>) {
    f.field("#editingRemarkAccountId").value = "one";
  }, url: "/api/accounts/one", method: "PATCH" },
  { name: "add channel", handler: "saveChannel", form: "channelForm", setup(f: ReturnType<typeof fixture>) {
    f.field("#channelTypeInput").value = "wecom";
    f.field("#wecomBotIdInput").value = "bot-one";
    f.field("#wecomSecretInput").value = "synthetic-test-only";
  }, url: "/api/accounts", method: "POST" },
  { name: "project notifications", handler: "saveProjectNotifications", form: "projectNotificationForm", setup(f: ReturnType<typeof fixture>) {
    f.field("#notificationProjectAccountId").value = "one";
    f.field("#notificationProjectId").value = "project-one";
  }, url: "/api/projects/one/project-one/notifications", method: "PUT" },
  { name: "task action", handler: "submitTaskboardAction", form: "taskboardActionForm", setup(f: ReturnType<typeof fixture>) {
    f.field("#taskboardActionIdentifier").value = "TASK-1";
    f.field("#taskboardActionStatus").value = "blocked";
    f.field("#taskboardActionVersion").value = "7";
    f.field("#taskboardActionComment").value = "waiting for fixture dependency";
  }, url: "/api/taskboard/issues/TASK-1/move", method: "POST" },
  { name: "task comment", handler: "submitTaskboardComment", form: "taskboardCommentForm", setup(f: ReturnType<typeof fixture>) {
    f.state.selectedTaskboardIssue = "TASK-1";
    f.field("#taskboardCommentInput").value = "fixture evidence";
  }, url: "/api/taskboard/issues/TASK-1/comments", method: "POST" },
  { name: "global settings", handler: "saveSettings", form: "settingsForm", setup(f: ReturnType<typeof fixture>) {
    f.field("#defaultCwdInput").value = "/fixture";
    f.field("#bindingIdleDaysInput").value = "15";
  }, url: "/api/config", method: "PUT" },
  { name: "knowledge base", handler: "saveKnowledgeBase", form: "knowledgeBaseForm", knowledge: true, setup(f: ReturnType<typeof fixture>) {
    f.field("#knowledgeBaseAccountInput").value = "one";
    f.field("#knowledgeBaseNameInput").value = "fixture wiki";
    f.field("#knowledgeBaseRootInput").value = "/fixture/wiki";
  }, url: "/api/knowledge-bases", method: "POST" }
];

for (const scenario of scenarios) for (const explicit of [false, true]) {
  test(`${scenario.name} submits its exact payload with ${explicit ? "a clicked submit button" : "a null native submitter"}`, async () => {
    const f = fixture(scenario.knowledge); scenario.setup(f);
    const form = { id: scenario.form, querySelector: () => f.button, querySelectorAll: () => f.controls() };
    await f.context[scenario.handler]({ preventDefault() {}, target: form, currentTarget: form,
      submitter: explicit ? f.button : null });
    assert.equal(f.requests.length, 1, f.notices.join("; "));
    assert.equal(f.requests[0].url, scenario.url);
    assert.equal(f.requests[0].options.method, scenario.method);
    if (scenario.name === "task action") assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].options.body)),
      { status: "blocked", version: 7, comment: "waiting for fixture dependency" });
    if (scenario.name === "task comment") assert.equal(f.requests[0].options.body.body, "fixture evidence");
    if (scenario.name === "add channel") assert.equal(f.requests[0].options.body.botId, "bot-one");
    if (scenario.name === "knowledge base") assert.equal(f.requests[0].options.body.rootPath, "/fixture/wiki");
    assert.equal(f.button.disabled, false);
  });
}
