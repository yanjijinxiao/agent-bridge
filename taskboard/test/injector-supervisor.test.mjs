import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

// Execute the real supervisor with controlled process/health boundaries. Do not
// import the launcher entrypoint: that would discover or modify the user's App.
const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const start = source.indexOf("function createTaskboardSupervisor(");
const end = source.indexOf("\nfunction codexIsRunning()", start);
assert.ok(start >= 0 && end > start);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const children = [], ready = deferred();
  const supervisor = vm.runInNewContext(`${source.slice(start, end)}\ncreateTaskboardSupervisor({detached:false})`, {
    console: { error() {} }, Date,
    taskboardHealthUrl: "http://fixture.invalid/health", taskboardHealthTimeoutMs: 5000,
    taskboardOrigin: "http://fixture.invalid",
    async isReachable() { return false; }, async isPortListening() { return false; },
    async waitUntilReachable(_url, timeout) {
      if (timeout === 3000) throw Error("existing child still starting");
      await ready.promise;
    },
    startTaskboard() {
      const child = new EventEmitter(); child.exitCode = null; child.killed = false;
      child.kill = () => { child.killed = true; }; children.push(child); return child;
    }, ...overrides,
  });
  return { supervisor, children, ready };
}

test("concurrent recovery and frame-open requests start only one Taskboard process", async () => {
  const port = deferred(), f = fixture({ isPortListening: () => port.promise });
  const first = f.supervisor.ensure(), second = f.supervisor.ensure({ force: true });
  port.resolve(false); await tick(); await tick(); f.ready.resolve();
  await Promise.all([first, second]);
  assert.equal(f.children.length, 1);
});

test("stopping during a health read cannot launch Taskboard after shutdown", async () => {
  const health = deferred(), f = fixture({ isReachable: () => health.promise });
  const result = f.supervisor.ensure().then(() => null, error => error);
  f.supervisor.stop(); health.resolve(false); f.ready.resolve();
  assert.match((await result)?.message ?? "", /stopp/i);
  assert.equal(f.children.length, 0);
  await assert.rejects(f.supervisor.ensure({ force: true }), /stopp/i);
});

test("a live but slow owned child does not cause a competing replacement", async () => {
  let attempts = 0;
  const f = fixture({ async waitUntilReachable() { attempts++; throw Error("health not ready"); } });
  await assert.rejects(f.supervisor.ensure({ force: true }), /health not ready/);
  await assert.rejects(f.supervisor.ensure({ force: true }), /health not ready/);
  assert.equal(attempts, 2);
  assert.equal(f.children.length, 1);
  f.children[0].exitCode = 1; f.children[0].emit("exit", 1);
  await assert.rejects(f.supervisor.ensure({ force: true }), /health not ready/);
  assert.equal(f.children.length, 2, "a confirmed exited child can be replaced");
});
