import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelUserInputController } from "../src/bridge/user-input-controller.js";
import { questionTypeLabel, questionWithdrawalText } from "../src/bridge/question-presentation.js";
import type { ChannelActionCard } from "../src/channels/action-card.js";
import type { CodexUserInputRequest, CodexUserInputResultReason } from "../src/codex/backend.js";
import { NativeInteractionFanout } from "../src/codex/interaction-fanout.js";
import type { NativeUserInput } from "../src/codex/interactions.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

const request: CodexUserInputRequest = { requestId: "request", threadId: "thread", turnId: "turn", itemId: "item",
  questions: [{ id: "question", header: "Question", question: "Choose a destination", options: [{ label: "A", description: "First" }] }], autoResolutionMs: null };
const tick = async () => { for (let n = 0; n < 3; n++) await new Promise<void>(resolve => setImmediate(resolve)); };
function fixture(t: test.TestContext, update = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "question-presentation-")), filePath = path.join(root, "journal.json");
  const cards: ChannelActionCard[] = [], notices: string[] = [], updates: ChannelActionCard[] = [], controllers: ChannelUserInputController[] = [];
  const create = () => {
    const controller = new ChannelUserInputController(async (_sender, card) => { cards.push(card); return { messageId: "card" }; }, undefined,
      { filePath, sendNotice: async (_sender, text) => { notices.push(text); },
        ...(update ? { updateCard: async (id: string, card: ChannelActionCard) => { assert.equal(id, "card"); updates.push(card); } } : {}) });
    controllers.push(controller); return controller;
  };
  t.after(() => { controllers.forEach(controller => controller.close()); fs.rmSync(root, { recursive: true, force: true }); });
  return { controller: create(), create, cards, notices, updates, filePath };
}

for (const kind of ["sync", "async", undefined] as const) for (const secret of [false, true])
test(`INT-02.presentation: ${kind ?? "native sync default"} type is visible with secret=${secret}`, async t => {
  const f = fixture(t), input = { ...request, kind, questions: request.questions.map(question => ({ ...question, isSecret: secret })) };
  const pending = f.controller.request("chat", input); await tick();
  const card = f.cards[0], label = questionTypeLabel(kind ?? "sync");
  assert.match(card.title, new RegExp(label)); assert.match(card.fallbackText, new RegExp(label));
  assert.match(card.body, kind === "async" ? /不阻塞执行/ : /等待回答后继续/);
  if (secret) {
    assert.deepEqual(card.actionGroups, []); assert.equal(card.form, undefined);
    assert.doesNotMatch(card.fallbackText, /Choose a destination|\/answer|First/);
  } else {
    assert.match(card.fallbackText, /\/answer Q1 回答内容/);
    assert.equal(card.form?.submit.value.questionId, "Q1");
    assert.ok(card.actionGroups.flat().some(choice => choice.value.command === "skip"));
  }
  await f.controller.reportResult("chat", input, "withdrawn", "turn-terminal"); await pending;
});

const causes: Array<[CodexUserInputResultReason, RegExp]> = [
  ["turn-terminal", /所属轮次已结束/], ["turn-replaced", /原轮次已被新轮次替代/],
  ["accepted-elsewhere", /已在其他入口回答并获 Codex 接收/],
  ["answer-selected-elsewhere", /其他入口提交.*接收状态仍待确认/],
  ["widget-removed", /原生界面已移除.*未确认/], ["widget-replaced", /原生问题已更新/],
  ["source-changed", /来源或内容已变化/], ["connection-lost", /连接已断开.*未确认/],
  ["observer-suspended", /连接已暂停或被替换.*未确认/], ["observer-replaced", /连接已暂停或被替换.*未确认/],
  ["request-resolved", /请求已结束.*未返回具体处理方式/], ["timeout", /设置的回答时限/],
  ["binding-changed", /聊天绑定已切换/]
];
for (const [reason, pattern] of causes)
test(`INT-02.presentation: ${reason} persists and agrees across card, late answer, skip and restart`, async t => {
  const f = fixture(t, true), input = { ...request, kind: "async" as const };
  const pending = f.controller.request("chat", input); await tick();
  await f.controller.reportResult("chat", input, "withdrawn", reason); await pending;
  assert.equal(f.updates.length, 1); assert.match(f.updates[0].title, /异步提问/);
  const text = f.updates[0].body;
  assert.match(text, pattern); assert.doesNotMatch(text, /已失效或已在/);
  await f.controller.reportResult("chat", input, "withdrawn");
  assert.equal(f.updates.length, 1, "old-peer duplicate does not erase known cause or repeat its notification");
  assert.equal(f.controller.answer("chat", "Q1 late"), `${text} 未提交这条回答或跳过。`);
  assert.equal(f.controller.skip("chat", "Q1"), `${text} 未提交这条回答或跳过。`);
  f.controller.close(); const restored = f.create();
  assert.equal(restored.skip("chat", "Q1"), `${text} 未提交这条回答或跳过。`);
  assert.equal(await restored.request("chat", input), undefined);
  assert.equal(f.cards.length, 1); assert.equal(f.updates.length, 1, "restart never republishes a closed question");
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0].resultReason, reason);
  assert.doesNotMatch(restored.answer("other-chat", "Q1 late"), pattern, "cause cannot leak across chats");
});

test("INT-02.presentation: unknown, legacy and injected reasons stay explicitly unknown", async t => {
  const f = fixture(t), pending = f.controller.request("chat", request); await tick();
  await f.controller.reportResult("chat", request, "withdrawn", "credential-secret-injection" as CodexUserInputResultReason); await pending;
  assert.match(f.notices[0], /同步提问/); assert.match(f.notices[0], /未记录具体原因/);
  assert.doesNotMatch(f.notices[0], /credential-secret-injection|已在 Codex 中处理/);
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0].resultReason, undefined);
  f.controller.close(); const journal = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
  delete journal.records[0].kind; journal.records[0].resultReason = "another-secret";
  fs.writeFileSync(f.filePath, JSON.stringify(journal)); const restored = f.create();
  assert.match(restored.skip("chat", "Q1"), /未记录具体原因/);
  assert.doesNotMatch(restored.skip("chat", "Q1"), /another-secret/);
  assert.match(questionTypeLabel(undefined), /类型未记录/);
  assert.match(questionWithdrawalText("Q1", undefined), /未记录具体原因/);
});

test("INT-02.presentation: legacy terminal notification does not guess its type or cause", async t => {
  const f = fixture(t, true), pending = f.controller.request("chat", request); await tick(); f.controller.close(); await pending;
  const journal = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
  delete journal.records[0].kind; fs.writeFileSync(f.filePath, JSON.stringify(journal));
  const restored = f.create(); await restored.reportResult("chat", request, "withdrawn");
  assert.equal(f.cards.length, 1); assert.equal(f.updates.length, 1);
  assert.match(f.updates[0].title, /提问类型未记录/); assert.match(f.updates[0].body, /未记录具体原因/);
  assert.match(restored.skip("chat", "Q1"), /未记录具体原因/);
});

test("INT-02.presentation: plain-text closure uses the same exact cause as later IM replies", async t => {
  const f = fixture(t), input = { ...request, kind: "async" as const };
  const pending = f.controller.request("chat", input); await tick();
  await f.controller.reportResult("chat", input, "withdrawn", "turn-terminal"); await pending;
  assert.deepEqual(f.notices, [`异步提问\n${questionWithdrawalText("Q1", "turn-terminal")}`]);
  assert.equal(f.controller.skip("chat", "Q1"), `${questionWithdrawalText("Q1", "turn-terminal")} 未提交这条回答或跳过。`);
});

test("INT-02.presentation: suspension retains pending; native confirmation supersedes a withdrawal", async t => {
  const f = fixture(t, true), input = { ...request, kind: "async" as const };
  const pending = f.controller.request("chat", input); await tick();
  await f.controller.reportResult("chat", input, "suspended", "connection-lost"); await pending; await tick();
  assert.equal(f.updates.length, 0); assert.match(f.controller.skip("chat", "Q1"), /仍待回答.*恢复/);
  const reattached = f.controller.request("chat", input); await tick();
  assert.equal(f.cards.length, 1); assert.match(f.controller.answer("chat", "Q1 yes"), /回执/); await reattached;
  await f.controller.reportResult("chat", input, "withdrawn", "turn-terminal");
  await f.controller.reportResult("chat", input, "confirmed", "accepted-answer");
  await f.controller.reportResult("chat", input, "failed", "connection-lost");
  assert.equal(f.updates.length, 2); assert.match(f.updates[1].body, /已确认接收/);
  assert.doesNotMatch(f.controller.skip("chat", "Q1"), /轮次已结束/);
  assert.equal(JSON.parse(fs.readFileSync(f.filePath, "utf8")).records[0].resultReason, "accepted-answer");
});

for (const outcome of ["confirmed", "failed"] as const)
test(`INT-02.presentation: fanout ${outcome} distinguishes selected and other answer surfaces`, async () => {
  const fanout = new NativeInteractionFanout(), answers = [Promise.withResolvers<any>(), Promise.withResolvers<any>()];
  const results: Array<[number, string, CodexUserInputResultReason | undefined]> = [];
  for (let n = 0; n < 2; n++) fanout.add(String(n), { onApproval: async () => undefined, onUserInput: () => answers[n].promise,
    onUserInputResult: (_input, result, reason) => { results.push([n, result, reason]); } });
  const input: NativeUserInput = { hostId: "local", method: "item/tool/requestUserInput", requestId: "request", request };
  const pending = fanout.observer.onUserInput!(input); await tick();
  answers[0].resolve({ question: { answers: ["yes"] } }); await pending;
  await fanout.observer.onUserInputResult!(input, outcome, outcome === "confirmed" ? "accepted-answer" : "answer-failed");
  assert.deepEqual(results, [[0, outcome, outcome === "confirmed" ? "accepted-answer" : "answer-failed"],
    [1, "withdrawn", outcome === "confirmed" ? "accepted-elsewhere" : "answer-selected-elsewhere"]]);
  answers[1].resolve(undefined); fanout.close();
});

for (const cause of ["resolved", "new-turn", "completed", "disconnect"] as const)
test(`INT-02.presentation: sync native wire ${cause} preserves typed request identity and reports its cause without an answer`, async t => {
  const runner = new AppServerCodexRunner(), native = runner as any;
  t.after(() => runner.close());
  let shown: NativeUserInput | undefined, writes = 0;
  const results: Array<{ result: string; reason?: string }> = [];
  native.send = () => { writes++; throw new Error("No native answer is authorized by this display test"); };
  native.interactionObservers.set("thread", { onApproval: async () => undefined,
    onUserInput(input: NativeUserInput) { shown = input; return new Promise(() => {}); },
    onUserInputResult(input: NativeUserInput, result: string, reason?: string) {
      assert.equal(input, shown); assert.equal(input.request.requestId, 42);
      assert.equal("resultReason" in input.request, false); results.push({ result, reason });
    } });
  const wire = (method: string, params: object, id?: number) => native.handleMessage(JSON.stringify({ jsonrpc: "2.0", method, params, ...(id === undefined ? {} : { id }) }));
  wire("item/tool/requestUserInput", request, 42); await tick(); assert.ok(shown);
  wire("serverRequest/resolved", { threadId: "thread", requestId: "42" }); await tick();
  assert.equal(results.length, 0, "string request ID cannot resolve the numeric request");
  if (cause === "resolved") wire("serverRequest/resolved", { threadId: "thread", requestId: 42 });
  else if (cause === "new-turn") wire("turn/started", { threadId: "thread", turn: { id: "new-turn" } });
  else if (cause === "completed") wire("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } });
  else native.failTransport(new Error("private transport error must not be displayed"), false);
  await tick();
  assert.deepEqual(results, [{ result: cause === "disconnect" ? "suspended" : "withdrawn",
    reason: { resolved: "request-resolved", "new-turn": "turn-replaced", completed: "turn-terminal", disconnect: "connection-lost" }[cause] }]);
  assert.equal(writes, 0);
});
