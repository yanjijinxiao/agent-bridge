import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { build } from "../taskboard/node_modules/vite/dist/node/index.js";
import { createTaskboardServer } from "../taskboard/server/app.mjs";
import { fakeNativeCore } from "../taskboard/test/helpers/native-backend.mjs";
import { isolatedBrowser, eventually } from "./helpers/gap-browser.js";

test("production WorkflowBoard runs the saved flow through HTTP and opens its exact AI conversation", {
  skip: !process.env.CODEX_CHROME_TEST_BIN, timeout: 90000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-browser-"));
  const output = path.join(root, "web"), codexStatePath = path.join(root, "device.json");
  fs.writeFileSync(codexStatePath, JSON.stringify({ "local-projects": { local: { rootPaths: [root] } } }));
  await build({ configFile: path.resolve("taskboard/web/vite.config.ts"), logLevel: "silent", build: { outDir: output, emptyOutDir: true } });
  const core = fakeNativeCore({ onRun: () => "Browser execution result" });
  const app = createTaskboardServer({ dataDirectory: root, staticDirectory: output, codexStatePath, nativeBackend: core.client() });
  const actor = { type: "user", id: "test", name: "Test", avatarUrl: null };
  const issue = app.database.createTask({ projectId: "local", title: "Browser issue", description: "UI input", status: "todo", priority: "none", labels: [], actor, assignee: actor, dueDate: null, workflowId: null });
  const nodes = [
    { id: "trigger", data: { kind: "issue-trigger", title: "议题触发", tone: "issue", icon: "issue" } },
    { id: "plan", data: { kind: "basic-planning", title: "生成计划", tone: "planning", icon: "sparkle" } },
    { id: "write", data: { kind: "issue-update", title: "写回结果", addComment: true, changeStatus: true, targetStatus: "done", tone: "result", icon: "check" } },
  ].map(n => ({ ...n, type: "workflow", position: { x: 0, y: 0 } }));
  app.database.saveWorkflowWorkspace("local", 0, { version: 1, tabs: [{ id: "flow", name: "UI workflow" }], activeWorkflowId: "flow",
    snapshots: { flow: { nodes, flow: { version: 2, root: { items: nodes.map(n => ({ type: "step", nodeId: n.id })) } }, selectedNodeId: null } } });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await isolatedBrowser(t, root);
  await browser.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const pageErrors: unknown[] = [];
  browser.onEvent((method, params) => { if (method === "Runtime.exceptionThrown" || method === "Runtime.consoleAPICalled" && params.type === "error") pageErrors.push(params); });
  t.after(async () => { await browser.close(); await app.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem('taskboard.lastProjectId','local')" });
  await browser.call("Page.navigate", { url: `http://127.0.0.1:${address.port}/?project=local` });
  const click = (text: string) => browser.evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`);
  await eventually(() => click("节点模式"), "node mode entry missing");
  try { await eventually(() => browser.evaluate("document.querySelector('.workflow-toolbar-status')?.textContent.includes('已自动保存') && document.querySelector('#workflow-tab-flow')?.disabled === false"), "saved workflow did not hydrate"); }
  catch (error) { t.diagnostic(JSON.stringify(pageErrors)); t.diagnostic(await browser.evaluate("document.body.innerText")); throw error; }
  await eventually(() => click("运行与记录"), "run panel missing");
  await eventually(() => browser.evaluate("Boolean(document.querySelector('.workflow-run-panel input[aria-label=触发议题]'))"), "issue input missing");
  await browser.evaluate("document.querySelector('.workflow-run-panel input[aria-label=触发议题]').focus()");
  await browser.call("Input.insertText", { text: issue.identifier });
  await eventually(() => click("运行已保存的流程"), "saved flow not runnable");
  try { await eventually(() => browser.evaluate("document.querySelector('.workflow-run-panel')?.innerText.includes('Browser execution result')"), "node output missing"); }
  catch (error) { t.diagnostic(await browser.evaluate("document.querySelector('.workflow-run-panel')?.innerText")); t.diagnostic(JSON.stringify(app.workflowExecution.store.list("local"))); throw error; }
  assert.equal(app.database.getTask(issue.id).status, "done");
  assert.equal(app.database.listComments(issue.id).length, 1);
  const run = app.workflowExecution.store.list("local")[0]; assert.equal(run.status, "completed");
  await eventually(() => click("查看对话与审批"), "native conversation action missing");
  await eventually(() => browser.evaluate("Boolean(document.querySelector('.ai-chat-messages')?.innerText.includes('Browser execution result'))"), "exact native thread not opened");
  assert.equal(core.calls.length, 1);
  if (process.env.CODEX_WORKFLOW_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.CODEX_WORKFLOW_SCREENSHOT_DIR, { recursive: true });
    const screenshot = await browser.call("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(path.join(process.env.CODEX_WORKFLOW_SCREENSHOT_DIR, "workflow-run.png"), Buffer.from(screenshot.data, "base64"));
  }
});
