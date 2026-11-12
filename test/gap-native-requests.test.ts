import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { ChannelUserInputController } from "../src/bridge/user-input-controller.js";
import { AppServerRequestMonitor } from "../src/server/app-server-request-monitor.js";
import type { NativeInteractionObserver, NativeUserInput } from "../src/codex/interactions.js";

const until = async (check: () => boolean) => { for (let n = 0; n < 300; n++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail("native fixture condition timed out"); };

for (const answered of [false, true]) test(`INT-02.6: full native question bootstrap retains pending widgets and excludes accepted replies (answered=${answered})`, async t => {
  const widget = { id: "widget", type: "agentMessage", questions: [{ title: "pending native question", options: null }] };
  const questionItemId = JSON.stringify(["request_user_input_async", "widget", 0]);
  const reply = { id: "accepted", type: "steeringUserMessage", status: "accepted", input: [{ type: "text",
    text: `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId, question: "pending native question", answer: "desktop answer" }])}\n</send_user_message_question_reply>` }] };
  // A real summary is a projection, not a complete list of turn items.
  const f = fixture(t, { summaryItems: answered ? [widget] : [], fullItems: answered ? [widget, reply] : [widget] });
  const offered: NativeUserInput[] = [];
  await f.runner.observeThreadInteractions("thread", { onApproval: async () => undefined,
    onUserInput(input) { offered.push(input); return new Promise(() => {}); } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(offered.length, answered ? 0 : 1);
  assert.ok(!f.calls().some(call => ["turn/start", "turn/steer"].includes(call.method)));
});

test("INT-02.6: a summary returned for a full interaction bootstrap cannot certify withdrawal", async t => {
  const f = fixture(t, { returnedView: "summary", items: [] });
  await assert.rejects(f.runner.observeThreadInteractions("thread", { onApproval: async () => undefined }), /full|snapshot/i);
});
function fixture(t: test.TestContext, initial: Record<string, unknown>, mode: "daemon-proxy" | "remote-daemon" = "daemon-proxy") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-request-gap-")), state = path.join(root, "state.json"), trace = path.join(root, "trace.jsonl");
  fs.writeFileSync(state, JSON.stringify(initial));
  const runner = new AppServerCodexRunner({ hostId: "remote-original", catalogSource: "native", requestTimeoutMs: 1000,
    transport: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/native-request-gap.mjs", import.meta.url)), state, trace], mode } });
  t.after(async () => { await runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { runner, set: (input: Record<string, unknown>) => fs.writeFileSync(state, JSON.stringify(input)),
    calls: () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [] };
}

for (const mode of ["daemon-proxy", "remote-daemon"] as const) for (const oversized of [false, true])
test(`NATIVE-02.9: another cold permission read cannot retire a pending question (${mode}, oversized=${oversized})`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-permission-budget-")), coldPath = path.join(dir, "cold.jsonl");
  fs.writeFileSync(coldPath, "source stays on native host\n");
  if (oversized) fs.truncateSync(coldPath, 129 * 1024 * 1024);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, { coldPath, failPermissionRead: true, allowAsyncSteer: true,
    items: [{ id: "widget", type: "agentMessage", questions: [{ title: "pending live question", options: null }] }] }, mode);
  const cards: unknown[] = [], notices: string[] = [], offered: NativeUserInput[] = [];
  const controller = new ChannelUserInputController(async (_sender, card) => { cards.push(card); return { messageId: "original" }; }, undefined,
    { sendNotice: async (_sender, text) => { notices.push(text); } });
  t.after(() => controller.close());
  await f.runner.observeThreadInteractions("thread", { onApproval: async () => undefined,
    onUserInput: input => { offered.push(input); return controller.request("room", input.request); },
    onUserInputResult: (input, result) => controller.reportResult("room", input.request, result) });
  await until(() => offered.length === 1);
  const controlPid = (f.runner as any).child.pid;
  await assert.rejects((f.runner as any).resumeThread({ threadId: "cold", excludeTurns: true }, 1000));
  await new Promise<void>(r => setImmediate(r));
  assert.equal((f.runner as any).child?.pid, controlPid, "bulk failure cannot replace the task control connection");
  assert.equal(f.runner.interactionSubscriptionReady("thread"), true);
  assert.equal(f.calls().filter(c => c.method === "fs/readFile").length, mode === "daemon-proxy" && oversized ? 0 : 1,
    "a same-named local remote path cannot veto native remote reading");
  assert.equal(cards.length, 1); assert.deepEqual(notices, []);
  assert.match(controller.answer("room", "Q1 explicit current answer"), /已记录/);
  await until(() => notices.some(text => text.includes("已确认")));
  assert.equal(f.calls().filter(c => c.method === "turn/steer").length, 1);
  assert.equal(f.calls().some(c => c.method === "turn/start"), false);
});

for (const method of ["turn/steer", "thread/resume", "thread/settings/update"])
test(`NATIVE-02.9: an isolated permission reader rejects ${method}`, async () => {
  const runner = new AppServerCodexRunner({ permissionReadOnly: true }) as any;
  assert.throws(() => runner.send({ id: 1, method, params: {} }), /Permission-read/);
  await runner.close();
});

test("NATIVE-02.9: a permission reader does not answer unsolicited approvals, questions or tools", async () => {
  const runner = new AppServerCodexRunner({ permissionReadOnly: true }) as any, writes: unknown[] = [];
  runner.send = (value: unknown) => writes.push(value);
  for (const method of ["item/commandExecution/requestApproval", "item/tool/requestUserInput", "item/tool/call", "mcpServer/elicitation/request"])
    runner.handleServerRequest({ id: 1, method, params: { threadId: "other", turnId: "other-turn", command: "never-run" } });
  assert.deepEqual(writes, []); await runner.close();
});

test("NATIVE-02.9: closing the owner releases an outstanding read-only client without a native decision", async t => {
  const f = fixture(t, { coldPath: "/virtual/owner.jsonl", stallPermissionRead: true });
  await (f.runner as any).ensureConnected();
  const controlPid = (f.runner as any).child.pid;
  const stopped = (f.runner as any).resumeThread({ threadId: "cold" }, 10000).then(() => false, () => true);
  await until(() => f.calls().some(c => c.method === "fs/readFile"));
  const readerPid = f.calls().find(c => c.method === "fs/readFile").fixturePid;
  assert.notEqual(readerPid, controlPid, "only the bulk read borrows the separate transport");
  await f.runner.close(); assert.equal(await stopped, true);
  assert.throws(() => process.kill(readerPid, 0), /ESRCH/);
  assert.ok(!f.calls().some(c => ["turn/start", "turn/steer", "thread/resume"].includes(c.method)));
});

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
