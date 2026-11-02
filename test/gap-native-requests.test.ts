import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { AppServerRequestMonitor } from "../src/server/app-server-request-monitor.js";
import type { NativeInteractionObserver, NativeUserInput } from "../src/codex/interactions.js";

const until = async (check: () => boolean) => { for (let n = 0; n < 300; n++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail("native fixture condition timed out"); };
function fixture(t: test.TestContext, initial: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-request-gap-")), state = path.join(root, "state.json"), trace = path.join(root, "trace.jsonl");
  fs.writeFileSync(state, JSON.stringify(initial));
  const runner = new AppServerCodexRunner({ hostId: "remote-original", catalogSource: "native", requestTimeoutMs: 1000,
    transport: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/native-request-gap.mjs", import.meta.url)), state, trace], mode: "daemon-proxy" } });
  t.after(async () => { await runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { runner, set: (input: Record<string, unknown>) => fs.writeFileSync(state, JSON.stringify(input)),
    calls: () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [] };
}

test("INT-02.1: native request supervision resubscribes a lost first approval replay on the same host/thread without executing or deciding", async t => {
  const f = fixture(t, { approval: true }), requests: unknown[] = [];
  const observer: NativeInteractionObserver = { onApproval: input => { requests.push(input); return new Promise(() => {}); } };
  const backend = { observeThreadInteractions: (id: string, host: string, current: NativeInteractionObserver) => {
    assert.equal(host, "remote-original"); return f.runner.observeThreadInteractions(id, current); },
    unobserveThreadInteractions: (id: string) => f.runner.unobserveThreadInteractions(id),
    interactionSubscriptionReady: (id: string) => f.runner.interactionSubscriptionReady(id) };
  const monitor = new AppServerRequestMonitor(() => backend as never, observer, 10); t.after(() => monitor.stop());
  monitor.setFollowedThreads([{ hostId: "remote-original", threadId: "thread" }]); monitor.start();
  await until(() => requests.length === 1);
  const request = requests[0] as any;
  assert.equal(request.hostId, "remote-original"); assert.equal(request.threadId ?? request.request.threadId, "thread");
  assert.equal(request.requestId, "approval-1");
  assert.equal(f.calls().filter(call => call.method === "thread/resume").length, 2);
  assert.ok(f.runner.interactionSubscriptionReady("thread"));
  assert.ok(!f.calls().some(call => !call.method || ["turn/start", "turn/steer", "thread/start"].includes(call.method)));
});

test("INT-02.2: validated complete native widget snapshots withdraw missing questions, while malformed snapshots and unrelated deltas retain pending work", async t => {
  const items = [{ id: "widget", type: "agentMessage", text: "choose", questions: [{ title: "missing-route", options: null }, { title: "awaiting-user", options: null }] }];
  const f = fixture(t, { items }), offered: NativeUserInput[] = [], results: Array<{ input: NativeUserInput; result: string }> = [];
  const observer: NativeInteractionObserver = { onApproval: async () => undefined,
    onUserInput(input) { offered.push(input); return input.request.questions[0].question === "missing-route" ? Promise.resolve(undefined) : new Promise(() => {}); },
    onUserInputResult(input, result) { results.push({ input, result }); } };
  await f.runner.observeThreadInteractions("thread", observer); await until(() => offered.length === 2 && !f.runner.interactionSubscriptionReady("thread"));
  f.set({ items, delta: true }); await f.runner.getRuntimeInfo("/tmp");
  assert.equal(results.length, 0, "an incremental unrelated item cannot clear the existing widget");
  f.set({ invalid: true });
  await assert.rejects(f.runner.observeThreadInteractions("thread", observer), /items|snapshot|array/i);
  assert.equal(results.length, 0, "a malformed snapshot cannot be treated as empty");
  f.set({ items: [] }); await f.runner.observeThreadInteractions("thread", observer);
  await until(() => results.length === 1);
  assert.equal(results[0].input.requestId, offered[1].requestId);
  assert.equal(results[0].result, "withdrawn");
  assert.ok(!f.calls().some(call => !call.method || ["turn/start", "turn/steer"].includes(call.method)));
});
