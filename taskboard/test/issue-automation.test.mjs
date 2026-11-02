import assert from "node:assert/strict";
import { access, appendFile, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { fakeNativeCore } from "./helpers/native-backend.mjs";
import { automationNativeFixture } from "./helpers/automation-native.mjs";
import { createCloudConfigStore } from "../server/cloud-config.mjs";
import { createIssueAutomation } from "../server/issue-automation.mjs";
import { createTaskboardServer } from "../server/index.mjs";
import { firstNonLoopbackAddress as firstLanAddress, fetchFromNonLoopback } from "./helpers/non-loopback-client.mjs";

function policy(directory, overrides = {}) {
  return {
    taskboardProjectId: "local",
    codexProjectId: "local",
    projectName: "Local",
    workspacePath: directory,
    skillPath: path.join(directory, "skills", "manage-taskboard", "SKILL.md"),
    enabledByUser: true,
    quotaAware: false,
    model: "gpt-5.5",
    reasoningEffort: "high",
    ...overrides,
  };
}

async function writeFakeCodex(directory, markerPath) {
  let workspacePath = path.join(directory, "workspace");
  try { await access(workspacePath); } catch { workspacePath = directory; }
  await writeFile(path.join(directory, "device.json"), JSON.stringify({ "local-projects": { local: { rootPaths: [workspacePath] } } }));
  return fakeNativeCore({ model: "gpt-5.5", async onRun() { await appendFile(markerPath, "started\n"); return "Done"; } }).client();
}

async function waitForRunCount(filename, count, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const runs = (await readFile(filename, "utf8")).trim().split("\n").filter(Boolean);
      if (runs.length >= count) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function waitForFile(filename, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filename);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return false;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}



test("new issues coalesce around one drain worker and a later issue starts again", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-event-automation-"));
  const policyPath = path.join(directory, "policies.json");
  await writeFile(policyPath, JSON.stringify({ project: policy(directory, {
    taskboardProjectId: "project",
    codexProjectId: "codex-project",
    projectName: "Project",
  }) }));

  const waits = [];
  const fixture = await automationNativeFixture(directory, { onRun() {
    const deferred = Promise.withResolvers(); waits.push(deferred); return deferred.promise;
  } });
  const spawned = fixture.core.calls;
  const automation = createIssueAutomation({
    automationPoliciesPath: policyPath,
    ...fixture.options,
    logger: { info() {}, error() {} },
  });

  try {
    assert.deepEqual(await automation.trigger({ projectId: "project" }), { started: true });
    assert.equal(await waitFor(() => spawned.length === 1), true);
    assert.match(spawned[0].prompt, /循环处理 todo 队列/);
    assert.match(spawned[0].prompt, /todo 队列为空时才结束/);
    assert.deepEqual(spawned[0].nativeSettings.runtimeWorkspaceRoots, [await import("node:fs/promises").then(fs => fs.realpath(directory))]);

    assert.deepEqual(await automation.trigger({ projectId: "project" }), {
      started: false,
      reason: "already-running",
    });
    assert.equal(spawned.length, 1);
    waits[0].resolve("Done");
    assert.equal(await waitFor(() => spawned.length === 2), true);
    assert.equal(spawned.length, 2);
    waits[1].resolve("Done");
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(await automation.trigger({ projectId: "project" }), { started: true });
    assert.equal(await waitFor(() => spawned.length === 3), true);
    waits[2].resolve("Done");
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await automation.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabled policies do not start Codex", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-event-disabled-"));
  const policyPath = path.join(directory, "policies.json");
  await writeFile(policyPath, JSON.stringify({ project: policy(directory, {
    taskboardProjectId: "project",
    enabledByUser: false,
  }) }));
  let spawnCount = 0;
  const fixture = await automationNativeFixture(directory, { onRun() { spawnCount++; return "Done"; } });
  const automation = createIssueAutomation({
    automationPoliciesPath: policyPath,
    ...fixture.options,
    logger: { info() {}, error() {} },

  });

  try {
    assert.deepEqual(await automation.trigger({ projectId: "project" }), {
      started: false,
      reason: "disabled",
    });
    assert.equal(spawnCount, 0);
  } finally {
    await automation.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("close does not wait for a stalled quota check or allow a late spawn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-event-close-"));
  const policyPath = path.join(directory, "policies.json");
  await writeFile(policyPath, JSON.stringify({ project: policy(directory, {
    taskboardProjectId: "project",
    quotaAware: true,
  }) }));
  const quotaStarted = Promise.withResolvers();
  const quotaResult = Promise.withResolvers();
  let spawnCount = 0;
  const fixture = await automationNativeFixture(directory, { onRun() { spawnCount++; return "Done"; } });
  const automation = createIssueAutomation({
    automationPoliciesPath: policyPath,
    ...fixture.options,
    logger: { info() {}, error() {} },
    readQuota() {
      quotaStarted.resolve();
      return quotaResult.promise;
    },

  });

  try {
    const triggerResult = automation.trigger({ projectId: "project" });
    await quotaStarted.promise;
    await automation.close();
    assert.equal(spawnCount, 0);
    quotaResult.resolve({ state: "available" });
    assert.deepEqual(await triggerResult, { started: false, reason: "closing" });
    assert.equal(spawnCount, 0);
  } finally {
    quotaResult.resolve({ state: "available" });
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("loopback POST /api/tasks reaches the event worker without a scheduler tick", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-event-server-"));
  const workspacePath = path.join(directory, "workspace");
  const markerPath = path.join(directory, "codex-started");
  const policyPath = path.join(directory, "policies.json");
  await mkdir(workspacePath);
  const executable = await writeFakeCodex(directory, markerPath);
  await writeFile(policyPath, JSON.stringify({ local: policy(workspacePath) }));
  const app = createTaskboardServer({
    dataDirectory: path.join(directory, "data"),
    automationPoliciesPath: policyPath,
    nativeBackend: executable,
    codexStatePath: path.join(directory, "device.json"),
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Immediate event", status: "todo" }),
    });
    assert.equal(response.status, 201);
    assert.equal(await waitForFile(markerPath), true, "Codex should start from task.created");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("moving a newly created backlog issue into todo retriggers the event worker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-event-ready-"));
  const workspacePath = path.join(directory, "workspace");
  const markerPath = path.join(directory, "codex-runs");
  const policyPath = path.join(directory, "policies.json");
  await mkdir(workspacePath);
  const executable = await writeFakeCodex(directory, markerPath);
  await writeFile(policyPath, JSON.stringify({ local: policy(workspacePath) }));
  const app = createTaskboardServer({
    dataDirectory: path.join(directory, "data"),
    automationPoliciesPath: policyPath,
    nativeBackend: executable,
    codexStatePath: path.join(directory, "device.json"),
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const createdResponse = await fetch(`http://127.0.0.1:${address.port}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Backlog then ready", status: "backlog" }),
    });
    assert.equal(createdResponse.status, 201);
    const { task } = await createdResponse.json();
    assert.equal(await waitForRunCount(markerPath, 1), true, "Creation should trigger once");

    const moveResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/tasks/${encodeURIComponent(task.id)}/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: task.version, status: "todo" }),
      },
    );
    assert.equal(moveResponse.status, 200);
    assert.equal(await waitForRunCount(markerPath, 2), true, "Entering todo should trigger again");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cloud-proxied creation and entering todo both trigger the local event worker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-event-cloud-"));
  const workspacePath = path.join(directory, "workspace");
  const markerPath = path.join(directory, "cloud-codex-started");
  const policyPath = path.join(directory, "policies.json");
  const configPath = path.join(directory, "cloud.json");
  await mkdir(workspacePath);
  const executable = await writeFakeCodex(directory, markerPath);
  await writeFile(policyPath, JSON.stringify({ cloud: policy(workspacePath, {
    taskboardProjectId: "cloud",
    codexProjectId: "cloud",
    projectName: "Cloud",
  }) }));
  const cloudConfig = createCloudConfigStore({ configPath });
  await cloudConfig.configure({
    remoteUrl: "https://tasks.example.test",
    actorName: "Local User",
    sharedKey: "test-shared-key",
  });
  await cloudConfig.setProjectWorkspace("cloud", workspacePath);
  let remoteStatus = "backlog";
  let remoteVersion = 1;
  const app = createTaskboardServer({
    dataDirectory: path.join(directory, "data"),
    cloudConfigPath: configPath,
    automationPoliciesPath: policyPath,
    nativeBackend: executable,
    codexStatePath: path.join(directory, "device.json"),
    remoteFetch: async (input, init) => {
      const url = new URL(input);
      if (init.method === "GET" && url.pathname === "/api/projects/cloud") return Response.json({ project: { id: "cloud", name: "Cloud" } });
      if (init.method === "GET" && url.pathname === "/api/projects") return Response.json({ projects: [{ id: "cloud", name: "Cloud" }] });
      if (init.method === "GET") {
        return new Response(JSON.stringify({
          task: {
            id: "remote-task",
            projectId: "cloud",
            status: remoteStatus,
            version: remoteVersion,
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const taskCreated = init.method === "POST" && url.pathname === "/api/tasks";
      if (url.pathname.endsWith("/move")) remoteStatus = "todo";
      remoteVersion += taskCreated ? 0 : 1;
      return new Response(JSON.stringify({
        task: {
          id: "remote-task",
          projectId: "cloud",
          status: remoteStatus,
          version: remoteVersion,
        },
      }), {
        status: taskCreated ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "cloud", title: "Remote event", status: "todo" }),
    });
    assert.equal(response.status, 201);
    assert.equal(await waitForRunCount(markerPath, 1), true, "Cloud creation should trigger local Codex");

    const moveResponse = await fetch(`http://127.0.0.1:${address.port}/api/tasks/remote-task/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, status: "todo" }),
    });
    assert.equal(moveResponse.status, 200);
    assert.equal(
      await waitForRunCount(markerPath, 2),
      true,
      "Cloud task entering todo should trigger local Codex again",
    );

    const patchResponse = await fetch(`http://127.0.0.1:${address.port}/api/tasks/remote-task`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2, title: "Still ready" }),
    });
    assert.equal(patchResponse.status, 200);
    const repeatedMoveResponse = await fetch(`http://127.0.0.1:${address.port}/api/tasks/remote-task/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 3, status: "todo" }),
    });
    assert.equal(repeatedMoveResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const runs = (await readFile(markerPath, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(runs.length, 2, "Already-todo cloud mutations must not trigger another run");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("LAN task creation persists the issue but cannot launch the local Codex worker", async (t) => {
  const lanAddress = firstLanAddress();
  if (!lanAddress) {
    t.skip("No non-loopback IPv4 interface is available");
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-event-lan-"));
  const markerPath = path.join(directory, "lan-codex-started");
  const policyPath = path.join(directory, "policies.json");
  const executable = await writeFakeCodex(directory, markerPath);
  await writeFile(policyPath, JSON.stringify({ local: policy(directory) }));
  const app = createTaskboardServer({
    dataDirectory: path.join(directory, "data"),
    automationPoliciesPath: policyPath,
    nativeBackend: executable,
    codexStatePath: path.join(directory, "device.json"),
  });
  const address = await app.listen({ host: "0.0.0.0", port: 0 });

  try {
    const response = await fetchFromNonLoopback(`http://127.0.0.1:${address.port}/api/tasks`, lanAddress, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "LAN event", status: "todo" }),
    });
    assert.equal(response.status, 201);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(access(markerPath), { code: "ENOENT" });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
