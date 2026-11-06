import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveLocalAppServerTransport } from "../src/codex/app-server-daemon.js";
import {
  APP_SERVER_BACKEND_CAPABILITIES,
  EXEC_BACKEND_CAPABILITIES
} from "../src/codex/backend.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import type { CodexRunnerInput, CodexThreadState } from "../src/codex/backend.js";

import { unifiedBackend } from './fixtures/unified-backend.js';

for (const operation of ['inspect','snapshot'] as const) test(`failed ${operation} reads remain errors and cannot choose another execution authority`,async t=>{
 const f=unifiedBackend(t);f.fail(new Error('native read timeout'));
 await assert.rejects(operation==='inspect'?f.gateway.inspectThread('thread'):f.gateway.readThreadSnapshot('thread'),/timeout/);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,operation==='inspect'?'inspectThread':'readThreadSnapshot');
});

test("message inspection reads metadata first and hydrates turns only for an active guard", async t => {
  const reads: Array<unknown> = [];
  let active = false;
  const app = { capabilities: APP_SERVER_BACKEND_CAPABILITIES,
    async inspectThread(_id: string, observation?: { includeTurns: false; timeoutMs: number }) {
      reads.push(observation);
      return { threadId: "thread", persistence: "active", runtimeStatus: active ? "active" : "idle", activeFlags: [],
        ...(active && !observation ? { activeTurnId: "turn" } : {}) };
    }, close() {}
  } as never;
  const router = new CodexBackendRouter({ backend: "app-server", appServerBackend: app,
    desktopRunner: { async inspectThread() { return undefined; }, close() {} } as never });
  t.after(() => router.close());
  assert.equal((await router.inspectThread("thread")).runtimeStatus, "idle");
  assert.deepEqual(reads, [{ includeTurns: false, timeoutMs: 5000 }]);
  active = true;
  assert.equal((await router.inspectThread("thread")).activeTurnId, "turn");
  assert.deepEqual(reads.slice(1), [{ includeTurns: false, timeoutMs: 5000 }, undefined]);
});

test("explicit membership metadata uses the exact host, shares only in-flight reads, and never hydrates history or discovers a writer", async t => {
  const reads: Array<{ host: string; observation: unknown }> = [];
  const gate = Promise.withResolvers<void>();
  const backend = (host: string) => ({ async inspectThread(_id: string, observation?: unknown) {
    reads.push({ host, observation }); if (observation) await gate.promise;
    return { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [], projectId: host, projectMembership: "assigned" };
  }, close() {} });
  const router = new CodexBackendRouter({ backend: "app-server", appServerBackend: backend("local-writer") as never,
    metadataConnectionFactory: host => ({ ...backend(host), listProjects: async () => ({ backend: "app-server", projects: [] }) }) as never,
    desktopRunner: { async inspectThread() { assert.fail("membership must not discover a Desktop writer"); }, close() {} } as never });
  (router as unknown as { remoteAppServers: Map<string, unknown> }).remoteAppServers.set("remote:test", backend("remote:test"));
  t.after(() => router.close());
  const observation = { includeTurns: false as const, timeoutMs: 5000 };
  const a = router.inspectThread("thread", "remote:test", observation), b = router.inspectThread("thread", "remote:test", observation);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(reads, [{ host: "remote:test", observation }]);
  gate.resolve(); assert.equal((await a).projectId, "remote:test"); assert.equal((await b).projectId, "remote:test");
  await router.inspectThread("thread", "remote:test", observation); assert.equal(reads.length, 2, "a later access requires a fresh observation");
  await router.inspectThread("thread", "local", observation); assert.equal(reads.at(-1)?.host, "local");
  await router.inspectThread("thread", "remote:test"); assert.deepEqual(reads.at(-1)?.observation, { includeTurns: false, timeoutMs: 5000 });
});

test("recovering project observations cannot close or write through the execution connection", async t => {
  let writerClosed = 0, observers = 0;
  const writer = { inspectThread() { assert.fail("metadata used the writer"); }, listProjects() { assert.fail("catalog used the writer"); }, close() { writerClosed++; } };
  const router = new CodexBackendRouter({ backend: "app-server", appServerBackend: writer as never,
    metadataConnectionFactory: host => {
      const generation = ++observers;
      return { async inspectThread(threadId) {
        if (generation === 1) throw Error("app-server connection disconnected");
        return { threadId, persistence: "active", runtimeStatus: "idle", activeFlags: [], projectId: host, projectMembership: "assigned" };
      }, listProjects: async () => ({ backend: "app-server", projects: [] }), close() {} } as never;
    } });
  t.after(() => router.close());
  assert.equal((await router.inspectThread("thread", "remote:test", { includeTurns: false, timeoutMs: 100 })).projectId, "remote:test");
  assert.deepEqual(await router.listProjects("remote:test", { timeoutMs: 100 }), { backend: "app-server", projects: [] });
  assert.equal(writerClosed, 0); assert.equal(observers, 2);
});

test("declares the protocol capabilities of the two Codex backends explicitly", () => {
  assert.equal(EXEC_BACKEND_CAPABILITIES.streaming, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.history, true);
  assert.equal(EXEC_BACKEND_CAPABILITIES.historyPaging, true);
  assert.equal(EXEC_BACKEND_CAPABILITIES.turnSteering, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.liveFollow, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.structuredOutput, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.projectCatalog, true);
  assert.equal(EXEC_BACKEND_CAPABILITIES.projects, false);
  assert.equal(EXEC_BACKEND_CAPABILITIES.threadNaming, false);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.streaming, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.history, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.historyPaging, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.turnSteering, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.liveFollow, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.approvals, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.collaborationModes, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.projectCatalog, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.projects, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.threadNaming, true);
  assert.equal(APP_SERVER_BACKEND_CAPABILITIES.developerInstructions, true);
});

test("thread-scoped input keeps App Server's guarded writer and never falls back on failure", async t => {
  let turnId = "current", fail = false, writes = 0, desktopWrites = 0;
  const router = new CodexBackendRouter({ backend: "app-server", appServerBackend: {
    async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: turnId ? "active" : "idle",
      activeTurnId: turnId || undefined, activeFlags: [] }; },
    async steer(input: import("../src/codex/backend.js").CodexSteerInput) {
      writes++; assert.equal(input.expectedTurnId, turnId);
      if (fail) throw new Error("active writer changed");
      return { status: "accepted", threadId: input.threadId, turnId };
    }, close() {}
  } as never, desktopRunner: {
    async submitThreadMessage() { desktopWrites++; }, async inspectThread() { return undefined; }, close() {}
  } as never });
  t.after(() => router.close());
  const input = { threadId: "thread", prompt: "message", cwd: "/tmp", clientUserMessageId: "id" };
  assert.equal((await router.submitThreadMessage(input)).turnId, "current");
  fail = true;
  await assert.rejects(router.submitThreadMessage(input), /active writer changed/);
  turnId = "";
  await assert.rejects(router.submitThreadMessage(input), /没有可确认的活动轮次/);
  assert.equal(writes, 2); assert.equal(desktopWrites, 0);
});

test("auto app-server transport uses stdio when the managed daemon is unavailable", () => {
  const transport = resolveLocalAppServerTransport({
    mode: "auto",
    codexHome: path.join(path.sep, "missing-codex-home"),
    existsSync: () => false
  });

  assert.equal(transport, undefined);
});

test("stdio app-server transport always starts a private app-server", () => {
  const transport = resolveLocalAppServerTransport({
    mode: "stdio",
    existsSync: () => true
  });

  assert.equal(transport, undefined);
});

test("daemon app-server transport exposes a proxy and fails preflight clearly", async () => {
  const codexHome = path.join(path.sep, "missing-codex-home");
  const transport = resolveLocalAppServerTransport({
    mode: "daemon",
    codexHome,
    existsSync: () => false
  });

  assert.equal(transport?.mode, "daemon-proxy");
  assert.equal(transport?.command, process.execPath);
  assert.equal(transport?.args.at(-1), path.join(codexHome, "app-server-control", "app-server-control.sock"));
  await assert.rejects(
    transport?.prepare?.(),
    /找不到可用的启动命令/
  );
});

test("daemon app-server transport connects to the selected Codex home's control socket", () => {
  const codexHome = path.join(path.sep, "test-codex-home");
  const transport = resolveLocalAppServerTransport({
    mode: "daemon",
    codexHome,
    platform: "darwin",
    existsSync: () => true
  });

  assert.equal(
    transport?.command,
    process.execPath
  );
  assert.equal(transport?.label, "managed-daemon");
});


test('snapshot followers share only concurrent work and never cache an obsolete native turn',async t=>{
 const f=unifiedBackend(t),gate=Promise.withResolvers<void>();let reads=0;
 f.app.readThreadSnapshot=async()=>{reads++;await gate.promise;return {state:{...f.state},turns:[]};};
 const a=f.gateway.readThreadSnapshot('thread'),b=f.gateway.readThreadSnapshot('thread');
 await new Promise(r=>setImmediate(r));assert.equal(reads,1);gate.resolve();await Promise.all([a,b]);
 f.state.runtimeStatus='active';f.state.activeTurnId='next';
 assert.equal((await f.gateway.readThreadSnapshot('thread')).state.activeTurnId,'next');assert.equal(reads,2);
});

test('catalog failures never select a CLI rollout or alternate backend',async t=>{
 const f=unifiedBackend(t);f.fail(Error('native catalog unavailable'));
 await assert.rejects(f.gateway.listProjects(),/unavailable/);
 f.fail();await f.gateway.run({cwd:'/tmp',threadId:'thread',prompt:'continue'});
 assert.deepEqual(f.calls.map(c=>c.method),['listProjects','run']);
});
