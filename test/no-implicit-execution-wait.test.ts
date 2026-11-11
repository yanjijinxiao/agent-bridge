import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { APP_SERVER_BACKEND_CAPABILITIES, CodexRunAdmissionError } from "../src/codex/backend.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("a second start cannot turn an accepted native task into an implicit full-turn Gateway queue or restart latch", async t => {
  const release = Promise.withResolvers<void>(), accepted = Promise.withResolvers<void>();
  let calls = 0;
  const runner = new CodexAppServerGateway({ appServerBackend: { id: "app-server", executionLifetime: "independent",
    capabilities: APP_SERVER_BACKEND_CAPABILITIES, hasInFlightWork: () => true, hasRestartBlockingWork: () => false,
    async run(input: any) {
      calls++;
      if (calls > 1) throw new Error("native thread already active; this input was not submitted");
      await input.onTurnStarted({ threadId: "thread", turnId: "turn" }); accepted.resolve(); await release.promise;
      return { threadId: "thread", turnId: "turn", text: "done", raw: "" };
    }, close() {}
  } as never });
  let second: Promise<unknown> | undefined;
  const first = runner.run({ prompt: "first", cwd: "/tmp", queueKey: "session" });
  t.after(async () => { release.resolve(); await Promise.allSettled([first, second]); await runner.close(); });
  await accepted.promise;
  second = runner.run({ prompt: "second", cwd: "/tmp", threadId: "thread", queueKey: "session" }).catch(error => error);
  await tick();
  assert.equal(runner.hasRestartBlockingWork(), false, "an independent execution wait must not become a second unaccepted start lease");
  const outcome = await Promise.race([second, new Promise(resolve => setTimeout(() => resolve("waiting-for-task"), 100))]);
  assert.notEqual(outcome, "waiting-for-task", "busy start must return to the source's steer/explicit-queue policy rather than waiting for task completion");
});

test("an already active native thread is reported before start instead of waiting for its task to end", async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 1000, transport: { command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url))], mode: "daemon-proxy" } });
  t.after(() => runner.close());
  const progress: string[] = [];
  await runner.inspectThread("warmup"); // Process startup is outside the bounded busy check.
  const pending = runner.run({ cwd: "/tmp", threadId: "thread-external-busy", prompt: "must not wait as a local queue",
    onProgress: text => { progress.push(text); } }).catch(error => error);
  const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("waiting-for-task"), 150))]);
  assert.notEqual(result, "waiting-for-task", "active native execution is not a Gateway handoff");
  assert.ok(result instanceof Error, "no new turn is submitted by the busy-start primitive");
  assert.ok(progress.every(text => !text.includes("已排队")), "only explicit native queue operations may announce queueing");
});

for (const lost of [false, true]) test(`a native start race returns promptly and preserves the exact ${lost ? "unknown" : "not-submitted"} boundary`, async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 150, transport: { command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/busy-start-app-server.mjs", import.meta.url)), ...(lost ? ["--lost-receipt"] : [])], mode: "daemon-proxy" } });
  t.after(() => runner.close());
  const progress: string[] = [];
  await assert.rejects(runner.run({ cwd: "/tmp", threadId: "thread", prompt: "once", onProgress: text => { progress.push(text); } }), error => {
    assert.ok(lost ? error instanceof CodexCommunicationError && error.submission === "unconfirmed" : error instanceof CodexRunAdmissionError);
    return true;
  });
  assert.deepEqual(progress, []);
});

test("a rejected second start cannot remove the original turn's approval and question handlers", async () => {
  const wire = new AppServerCodexRunner() as any;
  wire.ensureConnected = async () => {}; wire.recyclePrivateTransportIfIdle = async () => {};
  wire.inspectThread = async () => ({ threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] });
  wire.request = async (method: string) => {
    if (method === "thread/resume" || method === "thread/read") return { thread: { id: "thread", status: { type: "idle" } } };
    if (method === "turn/start") throw Error("thread already has an active turn");
    return {};
  };
  const original = async () => {}, candidate = async () => {};
  const maps = ["approvalHandlersByThread", "approvalResults", "dynamicToolHandlersByThread", "userInputHandlersByThread", "userInputResultHandlersByThread"];
  for (const name of maps) wire[name].set("thread", original);
  await assert.rejects(wire.run({ threadId: "thread", cwd: "/tmp", prompt: "race",
    onApproval: candidate, onApprovalResult: candidate, onDynamicToolCall: candidate, onUserInput: candidate, onUserInputResult: candidate }), CodexRunAdmissionError);
  for (const name of maps) assert.equal(wire[name].get("thread"), original, name);
});
