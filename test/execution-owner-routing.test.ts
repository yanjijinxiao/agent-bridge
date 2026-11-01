import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexBackendRouter } from "../src/codex/runner.js";
import { APP_SERVER_BACKEND_CAPABILITIES, CodexOwnerUnavailableError } from "../src/codex/backend.js";
import type { CodexRunnerInput, CodexThreadState } from "../src/codex/backend.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { ForwardingInbox } from "../src/bridge/forwarding-inbox.js";

const state = (runtimeStatus: CodexThreadState["runtimeStatus"] = "idle"): CodexThreadState => ({
  threadId: "thread", persistence: "active", runtimeStatus, activeFlags: [], executionOwner: "desktop",
  ...(runtimeStatus === "active" ? { activeTurnId: "turn" } : {})
});

function fixture(t: test.TestContext, executionOwner: "desktop" | "headless") {
  const calls: string[] = [];
  let desktopState: CodexThreadState | undefined = state(), error: Error | undefined;
  const app = {
    id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES, executionLifetime: "independent",
    async inspectThread() { calls.push("native-read"); return { ...state(), executionOwner: undefined }; },
    async readThreadSnapshot() { calls.push("native-snapshot"); return { state: { ...state(), executionOwner: undefined }, turns: [] }; },
    async run(input: CodexRunnerInput) { calls.push("native-run"); if (error) throw error;
      await input.onTurnStarted?.({ threadId: input.threadId ?? "created", turnId: "turn" });
      return { threadId: input.threadId ?? "created", turnId: "turn", text: "native", raw: "" }; },
    async steer() { calls.push("native-steer"); return { status: "accepted", threadId: "thread", turnId: "turn" }; },
    async stop() { calls.push("native-stop"); return "interrupted"; },
    async setGoal() { calls.push("native-goal"); }, async clearGoal() { calls.push("native-goal"); },
    async archiveThread() { calls.push("native-lifecycle"); }, async unarchiveThread() { calls.push("native-lifecycle"); },
    async deleteThread() { calls.push("native-lifecycle"); },
    async addQueuedSubmission(input: { enqueueOnly?: boolean }) { calls.push(input.enqueueOnly ? "native-enqueue-only" : "native-enqueue-resume");
      return { id: "queued", clientUserMessageId: "input" }; },
    async listQueuedSubmissions() { return { data: [] }; }, async deleteQueuedSubmission() { return true; },
    async runQueuedSubmission() { calls.push("native-consume"); },
    async readNativeTurnLifecycle() { calls.push("native-lifecycle-read"); return { status: "completed", source: "native-event", text: "done" }; },
    close() {}
  };
  const desktop = {
    async refreshTaskList() { calls.push("desktop-refresh"); },
    async inspectThread() { calls.push("desktop-read"); return desktopState; },
    async readThreadSnapshot() { calls.push("desktop-snapshot"); return desktopState ? { state: desktopState, turns: [] } : undefined; },
    async run(input: CodexRunnerInput) { calls.push("desktop-run"); if (error) throw error;
      await input.onTurnStarted?.({ threadId: "thread", turnId: "turn" });
      return { threadId: "thread", turnId: "turn", text: input.prompt, raw: "" }; },
    async submitThreadMessage() { calls.push("desktop-message"); return { status: "accepted", threadId: "thread", turnId: "turn" }; },
    async steer() { calls.push("desktop-steer"); throw new Error("unsupported guarded steer"); },
    async stop(_id: string, expectedTurnId: string) { calls.push(`desktop-stop:${expectedTurnId}`); return "interrupted"; }, close() {}
  };
  const router = new CodexBackendRouter({ backend: "auto", executionOwner, appServerBackend: app as never,
    desktopRunner: desktop as never, execBackend: { async run() { calls.push("exec-run"); }, close() {} } as never });
  t.after(() => router.close());
  return { router, calls, unavailable() { desktopState = undefined; }, active() { desktopState = state("active"); },
    available() { desktopState = state(); },
    fail(value: Error) { error = value; } };
}

test("desktop deployment never reads private execution state or starts a second writer", async t => {
  const f = fixture(t, "desktop");
  assert.equal((await f.router.inspectThread("thread")).executionOwner, "desktop");
  assert.equal((await f.router.inspectThread("thread", "local", { includeTurns: false, purpose: "status", timeoutMs: 100 })).executionOwner, "desktop");
  assert.equal((await f.router.readThreadSnapshot("thread")).state.executionOwner, "desktop");
  assert.equal((await f.router.run({ threadId: "thread", cwd: "/tmp", prompt: "once" })).text, "once");
  assert.deepEqual(f.calls, ["desktop-read", "desktop-read", "desktop-snapshot", "desktop-run"]);
});

test("Desktop status keeps its own deadline and cannot replace a slow owner read with private runtime state", async t => {
  const pending = Promise.withResolvers<CodexThreadState>(); let reads = 0;
  const router = new CodexBackendRouter({ backend: "app-server", executionOwner: "desktop",
    appServerBackend: { close() {}, inspectThread() { assert.fail("foreign status read"); } } as never,
    desktopRunner: { close() {}, inspectThread() { reads++; return pending.promise; } } as never });
  t.after(() => router.close());
  await assert.rejects(router.inspectThread("thread", "local", { includeTurns: false, purpose: "status", timeoutMs: 10 }),
    { submission: "not-submitted", operation: "desktop/status", code: "timeout" });
  const next = router.inspectThread("thread"); pending.resolve(state("active"));
  assert.equal((await next).activeTurnId, "turn"); assert.equal(reads, 1);
});

test("negative Desktop discovery, disconnect and uncertain receipt never fall through to another executor", async t => {
  const f = fixture(t, "desktop");
  for (const error of [new CodexOwnerUnavailableError(), new CodexCommunicationError("preflight", "desktop/read"),
    new CodexCommunicationError("submission", "desktop/start")]) {
    f.fail(error);
    await assert.rejects(f.router.run({ threadId: "thread", cwd: "/tmp", prompt: "once" }), CodexCommunicationError);
  }
  assert.deepEqual(f.calls, ["desktop-run", "desktop-run", "desktop-run"]);
  f.unavailable();
  await assert.rejects(f.router.inspectThread("thread"), { submission: "not-submitted" });
  await assert.rejects(f.router.readThreadSnapshot("thread"), { submission: "not-submitted" });
  assert.equal(f.calls.some(x => x.startsWith("native") || x === "exec-run"), false);
});

test("unsupported Desktop creation, dynamic helpers and mutations cannot borrow a private server", async t => {
  const f = fixture(t, "desktop");
  await assert.rejects(f.router.run({ cwd: "/tmp", prompt: "create" }), /已有.*会话/);
  await assert.rejects(f.router.runEphemeral({ cwd: "/tmp", prompt: "classify" }), /临时分类/);
  await assert.rejects(f.router.setGoal("thread", { objective: "goal" }), /暂不支持/);
  await assert.rejects(f.router.clearGoal("thread"), /暂不支持/);
  await assert.rejects(f.router.archiveThread("thread"), /暂不支持/);
  await assert.rejects(f.router.unarchiveThread("thread"), /暂不支持/);
  await assert.rejects(f.router.deleteThread("thread"), /暂不支持/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.router.backendInfo().capabilities.dynamicTools, false);
  assert.equal(f.router.backendInfo().capabilities.turnSteering, false);
  assert.equal(f.router.backendInfo().capabilities.goals, false);
});

test("Desktop active messages and guarded stops stay on their original native turn", async t => {
  const f = fixture(t, "desktop"); f.active();
  assert.equal((await f.router.submitThreadMessage({ threadId: "thread", cwd: "/tmp", prompt: "more" })).turnId, "turn");
  assert.equal(await f.router.stop("thread"), "interrupted");
  await assert.rejects(f.router.steer({ threadId: "thread", prompt: "strict", expectedTurnId: "turn" }), /unsupported/);
  assert.deepEqual(f.calls, ["desktop-read", "desktop-message", "desktop-read", "desktop-stop:turn", "desktop-steer"]);
});

test("Desktop native queue stores input without resume and cannot be consumed by the private reader", async t => {
  const f = fixture(t, "desktop");
  await f.router.addQueuedSubmission({ threadId: "thread", clientUserMessageId: "input", cwd: "/tmp", prompt: "later" });
  await assert.rejects(f.router.runQueuedSubmission({ threadId: "thread", cwd: "/tmp" }), /等待实际持有者/);
  assert.deepEqual(f.calls, ["desktop-read", "native-enqueue-only", "desktop-read"]);
});

test("accepted results can be reconciled read-only after a Desktop window disappears", async t => {
  const f = fixture(t, "desktop"); f.unavailable();
  assert.equal((await f.router.readTurnLifecycle("thread", "accepted-turn")).text, "done");
  assert.deepEqual(f.calls, ["desktop-snapshot", "native-lifecycle-read"]);
  const result = await f.router.runQueuedSubmission({ threadId: "thread", cwd: "/tmp", acceptedTurnId: "accepted-turn", observeOnly: true });
  assert.equal(result.text, "done"); assert.equal(f.calls.includes("native-consume"), false);
});

test("persisted IM input waits for the fixed Desktop owner across restart and is submitted exactly once after recovery", async t => {
  const f = fixture(t, "desktop"); f.unavailable();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-fixed-owner-inbox-"));
  let now = 1000, inbox: ForwardingInbox, receipts: InboundReceiptJournal;
  const make = () => {
    receipts = new InboundReceiptJournal(path.join(root, "receipts.jsonl"), [], { onAccepted: r => inbox.accepted(r) });
    inbox = new ForwardingInbox({ filePath: path.join(root, "inbox.json"), receipts,
      target: () => ({ sessionId: "session", threadId: "thread", hostId: "local", workspace: root, mode: "session", roots: [] }),
      automatic: () => true, canDispatch: () => true, now: () => now, notice: async () => {},
      dispatch: message => receipts.handle(message, async () => {
        await f.router.inspectThread("thread");
        receipts.submitting({ sessionId: "session", hostId: "local", threadId: "thread" });
        await f.router.run({ cwd: root, threadId: "thread", prompt: message.text,
          clientUserMessageId: receipts.receipt(message.id)!.clientUserMessageId,
          onTurnStarted: e => { receipts.accepted(e.threadId, e.turnId); } });
      }) });
  };
  make(); t.after(() => { inbox.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const message = { id: "dingtalk-source", senderId: "actor", replyTargetId: "room", text: "continue original work", raw: {}, attachments: [] };
  await inbox.receive(message);
  assert.equal(receipts.receipt(message.id)?.phase, "received");
  const identity = receipts.receipt(message.id)!.clientUserMessageId;
  assert.equal(f.calls.includes("native-run"), false); assert.equal(f.calls.includes("desktop-run"), false);
  inbox.stop(); make(); now += 60_001; f.available();
  await inbox.receive(message);
  assert.equal(receipts.receipt(message.id)?.phase, "handled");
  assert.equal(receipts.receipt(message.id)?.clientUserMessageId, identity);
  inbox.stop(); make(); await inbox.receive(message);
  assert.equal(f.calls.filter(c => c === "desktop-run").length, 1);
  assert.equal(f.calls.some(c => c === "native-run" || c === "exec-run"), false);
});

test("headless deployment creates and continues native sessions with no Desktop or CLI exec fallback", async t => {
  const f = fixture(t, "headless");
  assert.equal((await f.router.run({ cwd: "/tmp", prompt: "new" })).threadId, "created");
  await f.router.run({ threadId: "thread", cwd: "/tmp", prompt: "continue" });
  await f.router.inspectThread("thread"); await f.router.readThreadSnapshot("thread"); await f.router.stop("thread");
  f.fail(new Error("thread-store conflict: thread already has an active writer"));
  await assert.rejects(f.router.run({ threadId: "thread", cwd: "/tmp", prompt: "again" }), /active writer/);
  assert.equal(f.calls.some(x => x.startsWith("desktop") || x === "exec-run"), false);
});

test("auto backend in an explicit headless deployment never silently switches to exec", async t => {
  const f = fixture(t, "headless"); f.fail(new Error("app-server unavailable"));
  await assert.rejects(f.router.run({ cwd: "/tmp", prompt: "new" }), /unavailable/);
  assert.deepEqual(f.calls, ["native-run"]);
});
