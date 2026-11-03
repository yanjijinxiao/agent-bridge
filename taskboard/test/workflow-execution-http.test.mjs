import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTaskboardServer } from "../server/app.mjs";
import { fakeNativeCore } from "./helpers/native-backend.mjs";

test("HTTP saved workflow runs a native planning node and exposes durable per-node output after restart", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-http-"));
  const statePath = path.join(directory, "codex.json");
  await writeFile(statePath, JSON.stringify({ "local-projects": { local: { rootPaths: [directory] } } }));
  const core = fakeNativeCore({ onRun: () => "A concrete plan" });
  let app, origin;
  async function open() {
    app = createTaskboardServer({ dataDirectory: directory, nativeBackend: core.client(), codexStatePath: statePath });
    const address = await app.listen({ host: "127.0.0.1", port: 0 }); origin = `http://127.0.0.1:${address.port}`;
  }
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  await open();
  async function request(route, method = "GET", body) {
    const response = await fetch(origin + route, { method, headers: { "content-type": "application/json", origin }, body: body && JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  }
  const task = await request("/api/tasks", "POST", { projectId: "local", title: "Run through API", status: "todo" });
  assert.equal(task.status, 201);
  const nodes = [
    { id: "trigger", data: { kind: "issue-trigger" } },
    { id: "plan", data: { kind: "basic-planning" } },
    { id: "write", data: { kind: "issue-update", addComment: true } },
  ].map(node => ({ ...node, type: "workflow", position: { x: 0, y: 0 } }));
  const workspace = { version: 1, tabs: [{ id: "flow", name: "API flow" }], activeWorkflowId: "flow",
    snapshots: { flow: { nodes, flow: { version: 2, root: { items: nodes.map(n => ({ type: "step", nodeId: n.id })) } }, selectedNodeId: null } } };
  assert.equal((await request("/api/projects/local/workflow-workspace", "PUT", { version: 0, workspace })).status, 200);
  const input = { clientRequestId: randomUUID(), workflowId: "flow", version: 1, input: { issueId: task.task.id } };
  const accepted = await request("/api/local/workflow-runs/local", "POST", input); assert.equal(accepted.status, 202);
  let run;
  for (let tries = 0; tries < 100; tries++) {
    run = (await request(`/api/local/workflow-runs/local/${input.clientRequestId}`)).run;
    if (run.status !== "running") break;
    await delay(50);
  }
  assert.equal(run.status, "completed", run.error); assert.equal(run.steps.plan.output.text, "A concrete plan");
  assert.equal((await request(`/api/tasks/${task.task.id}/comments`)).comments[0].body, "A concrete plan");
  const count = core.calls.length; assert.equal(count, 1);
  await app.close(); await open();
  assert.equal((await request("/api/local/workflow-runs/local", "POST", input)).run.id, input.clientRequestId);
  assert.equal((await request("/api/local/workflow-runs/local")).runs[0].status, "completed");
  assert.equal(core.calls.length, count);
  assert.equal((await request(`/api/tasks/${task.task.id}/comments`)).comments.length, 1);
});
