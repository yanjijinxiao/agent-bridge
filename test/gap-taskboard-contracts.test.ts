import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { TaskboardClient } from "../src/taskboard/client.js";
import { TaskboardWorkbench } from "../src/taskboard/workbench.js";
import { createTaskboardServer } from "../taskboard/server/index.mjs";
import { fakeNativeCore } from "../taskboard/test/helpers/native-backend.mjs";

test("TB-01.1: the real Taskboard workbench never maps a same-path remote project or writes through its issue", async () => {
  const stamp = new Date().toISOString(), writes: any[] = [];
  const issue = { id: "task", identifier: "P-1", projectId: "tb", threadId: "thread", title: "Task", description: "", status: "todo", priority: "none", labels: [], version: 1, createdAt: stamp, updatedAt: stamp };
  const client = new TaskboardClient({ baseUrl: "http://127.0.0.1:47823", fetch: async (input, init) => {
    const url = new URL(input);
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return Response.json({ comment: { id: "c", taskId: "task", body: "note", threadId: "thread", createdAt: stamp, updatedAt: stamp } }); }
    if (url.pathname === "/api/projects") return Response.json({ projects: [{ id: "tb", name: "Local", workspacePath: "/same/path", issueCount: 1, createdAt: stamp, updatedAt: stamp }] });
    if (url.pathname === "/api/tasks") return Response.json({ tasks: [issue] });
    if (url.pathname.endsWith("/comments")) return Response.json({ comments: [] });
    return Response.json({ task: issue });
  } });
  let projects = [{ accountId: "account", projectId: "remote", projectName: "Remote", workspace: "/same/path", hostId: "ssh:remote", sourceProjectId: "native-remote" }];
  const workbench = new TaskboardWorkbench({ client: () => client, projects: () => projects });
  assert.deepEqual(await workbench.listIssues(), []);
  await assert.rejects(workbench.commentIssue("P-1", "note"), /not found in a managed workspace/); assert.deepEqual(writes, []);
  projects = [...projects, { accountId: "account", projectId: "local", projectName: "Local", workspace: "/same/path", hostId: "local", sourceProjectId: "native-local" }];
  assert.deepEqual((await workbench.listIssues())[0].managedProjects.map(project => project.projectId), ["local"]);
  await workbench.commentIssue("P-1", "note"); assert.equal(writes.length, 1); assert.equal(writes[0].threadId, "thread");
});

const result = await build({ entryPoints: ["taskboard/web/src/components/workflowCatalog.ts"], bundle: true, platform: "node", format: "esm", write: false, loader: { ".svg": "text", ".png": "dataurl" } });
const catalog = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
const kinds = ["issue-trigger", "rss-trigger", "pull-request-submitted-trigger", "repository-issue-submitted-trigger", "git-status-trigger", "condition", "skill", "mcp", "nano-banana", "jimeng-image", "midjourney-image", "seedance-video", "kling-video", "custom-api", "git", "feishu-docs", "feishu-message", "twitter-post", "opencli", "claude-design", "cloudflare-deploy", "vercel-deploy", "custom-integration", "custom-code", "write-tests", "run-tests", "basic-planning", "claude-code-planning", "custom-planning", "issue-create", "issue-update", "codex-review", "claude-code-review"];

test("TB-10.3: every palette kind has an explicit configuration boundary, and failed Skill/MCP discovery cannot invent ready options", async t => {
  assert.deepEqual(catalog.PALETTE_ITEMS.map((item: any) => item.data.kind), kinds);
  const dynamic = { skills: [{ id: "native-skill", label: "Skill", path: "/fixture/SKILL.md" }], mcpServers: [{ id: "native-mcp", label: "MCP", transport: "native" }] };
  const emptyDefaults = new Set(["rss-trigger", "skill", "mcp", "twitter-post", "custom-code", "issue-create", "nano-banana", "jimeng-image", "midjourney-image", "seedance-video", "kling-video", "feishu-docs", "feishu-message", "custom-api", "git", "opencli", "cloudflare-deploy", "custom-integration", "custom-planning"]);
  for (const kind of kinds) await t.test(kind, () => {
    const data = catalog.paletteData(kind);
    assert.equal(catalog.workflowNodeConfigured(data, { skills: [], mcpServers: [] }, false), !emptyDefaults.has(kind), `${kind}: editor configuration only, not execution admission`);
    assert.ok(data.title && data.description && data.outputLabel);
  });
  for (const [kind, field, selected] of [["skill", "selectedSkill", "native-skill"], ["mcp", "selectedMcpServer", "native-mcp"]]) {
    const data = { ...catalog.paletteData(kind), [field]: selected, additionalInstructions: "fixture operation" };
    assert.equal(catalog.workflowNodeConfigured(data, dynamic, false), true);
    for (const caps of [null, { skills: [], mcpServers: [] }, dynamic]) assert.equal(catalog.workflowNodeConfigured(data, caps, true), false);
    assert.match(catalog.capabilityNodeMeta(data, null, true), /无法读取/);
    assert.equal(catalog.selectedCapabilityValue([], selected), "");
  }
  for (const [kind, field, valid] of [["rss-trigger", "rssFeedUrl", "https://fixture.invalid/rss"], ["twitter-post", "twitterPostContent", "fixture post"], ["custom-code", "codeContent", "fixture code"], ["issue-create", "createIssueTitle", "fixture issue"]]) {
    assert.equal(catalog.workflowNodeConfigured({ ...catalog.paletteData(kind), [field]: "  " }, dynamic, false), false);
    assert.equal(catalog.workflowNodeConfigured({ ...catalog.paletteData(kind), [field]: valid, providerProfile: "configured-fixture" }, dynamic, false), true);
  }
  assert.equal(catalog.workflowNodeConfigured({ ...catalog.paletteData("run-tests"), testScope: "custom", testCommand: "" }, dynamic, false), false);
  assert.equal(catalog.workflowNodeConfigured({ ...catalog.paletteData("feishu-message"), feishuRecipientType: "user", feishuUserId: "" }, dynamic, false), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-workflow-catalog-")); let calls = 0;
  const native = { ...fakeNativeCore().client(), async listSkills() { calls++; throw Error("fixture catalog unavailable"); }, async listMcpServers() { calls++; return []; } };
  const app = createTaskboardServer({ dataDirectory: root, nativeBackend: native });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`http://127.0.0.1:${address.port}/api/workflow-capabilities`);
  assert.equal(response.status, 500); const body = await response.json() as any;
  assert.equal(body.skills, undefined); assert.equal(body.mcpServers, undefined); assert.equal(calls, 2);
});
