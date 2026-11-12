import assert from "node:assert/strict";
import test from "node:test";
import { NativeAsyncQuestions } from "../src/codex/native-async-questions.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import type { NativeInteractionObserver, NativeUserInput } from "../src/codex/interactions.js";
import type { CodexSteerInput, CodexSteerResult, CodexUserInputAnswer } from "../src/codex/backend.js";

const settle = async () => { for (let n = 0; n < 4; n++) await new Promise<void>(r => setImmediate(r)); };
const widget = (questions = ["first", "second"]) => ({ type: "agentMessage", id: "widget", questions: questions.map(title => ({ title, options: null })) });
const accepted = (text: string, id = "native-answer") => ({ type: "steeringUserMessage", id, status: "accepted", input: [{ type: "text", text }] });

test("INT-02.6: a transport disconnect suspends an unanswered async widget; only its reobserved source can accept an answer", async () => {
  const f = fixture(); f.native.observe("thread", "turn", [widget(["first"])], f.observer); await settle();
  const old = f.requests[0].request.questions[0];
  f.native.disconnect(); await settle();
  assert.deepEqual(f.results.map(r => r.result), ["suspended"], "transport loss cannot prove native withdrawal");
  f.answers[0].resolve({ [old.id]: { answers: ["late old observer"] } }); await settle();
  assert.equal(f.writes.length, 0);
  f.native.observe("thread", "turn", [widget(["first"])], f.observer, true); await settle();
  assert.equal(f.requests.length, 2);
  const fresh = f.requests[1].request.questions[0];
  f.answers[1].resolve({ [fresh.id]: { answers: ["explicit current answer"] } }); await settle();
  assert.equal(f.writes.length, 1);
  f.native.observe("thread", "turn", [accepted(f.writes[0].prompt)], f.observer); await settle();
  f.acknowledgements[0].resolve({ status: "accepted", threadId: "thread", turnId: "turn" }); await settle();
  assert.deepEqual(f.results.map(r => r.result), ["suspended", "confirmed"]);
});

test("INT-02.6: omitted question fields in an item delta do not erase the widget; a complete removal still withdraws it", async () => {
  const f = fixture(); f.native.observe("thread", "turn", [widget(["first"])], f.observer); await settle();
  f.native.observe("thread", "turn", [{ type: "agentMessage", id: "widget", text: "updated public text" }], f.observer); await settle();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.results, []);
  f.native.observe("thread", "turn", [], f.observer, true); await settle();
  assert.deepEqual(f.results.map(r => r.result), ["withdrawn"]); assert.equal(f.writes.length, 0);
});
function fixture() {
  const requests: NativeUserInput[] = [], answers: Array<ReturnType<typeof Promise.withResolvers<CodexUserInputAnswer | undefined>>> = [];
  const results: Array<{ request: NativeUserInput; result: string }> = [], writes: CodexSteerInput[] = [];
  const acknowledgements: Array<ReturnType<typeof Promise.withResolvers<CodexSteerResult>>> = [];
  let current = true;
  const observer: NativeInteractionObserver = { onApproval: async () => undefined,
    onUserInput(request) { requests.push(request); const answer = Promise.withResolvers<CodexUserInputAnswer | undefined>(); answers.push(answer); return answer.promise; },
    onUserInputResult(request, result) { results.push({ request, result }); } };
  const native = new NativeAsyncQuestions("remote", () => current, input => {
    writes.push(input); const ack = Promise.withResolvers<CodexSteerResult>(); acknowledgements.push(ack); return ack.promise;
  }, () => {});
  return { native, observer, requests, answers, results, writes, acknowledgements, revoke() { current = false; } };
}

test("sibling native widgets are independently answerable and require exact accepted answer evidence", async () => {
  const f = fixture(); f.native.observe("thread", "turn", [widget()], f.observer); await settle();
  assert.equal(f.requests.length, 2); assert.notEqual(f.requests[0].requestId, f.requests[1].requestId);
  const question = f.requests[0].request.questions[0];
  f.answers[0].resolve({ [question.id]: { answers: ["first answer"] } }); await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].expectedTurnId, "turn"); assert.equal(f.results.length, 0);
  const rows = JSON.parse(f.writes[0].prompt.split("\n")[1]);
  assert.deepEqual(rows, [{ questionItemId: question.id, question: "first", answer: "first answer" }]);
  f.acknowledgements[0].resolve({ status: "accepted", threadId: "thread", turnId: "turn" }); await settle();
  assert.equal(f.results.length, 0, "an RPC receipt does not invent an answered widget");
  f.native.observe("thread", "turn", [accepted(f.writes[0].prompt)], f.observer); await settle();
  assert.deepEqual(f.results.map(r => r.result), ["confirmed"]);
  assert.equal(f.requests.length, 2, "confirming one sibling does not recreate the other");
  const second = f.requests[1].request.questions[0];
  f.answers[1].resolve({ [second.id]: { answers: ["second answer"] } }); await settle();
  f.native.observe("thread", "turn", [accepted(f.writes[1].prompt, "second-native-answer")], f.observer); await settle();
  assert.equal(f.results.filter(r => r.result === "confirmed").length, 2);
  f.acknowledgements[1].resolve({ status: "accepted", threadId: "thread", turnId: "turn" });
  f.native.observe("thread", "turn", [widget()], f.observer); await settle();
  assert.equal(f.requests.length, 2); assert.equal(f.writes.length, 2);
});

test("a lost async reply acknowledgement cannot reoffer or replay the same input; native evidence repairs it", async () => {
  const f = fixture(); f.native.observe("thread", "turn", [widget(["first"])], f.observer); await settle();
  const q = f.requests[0].request.questions[0]; f.answers[0].resolve({ [q.id]: { answers: ["answer"] } }); await settle();
  f.acknowledgements[0].reject(new Error("lost native receipt")); await settle();
  f.native.observe("thread", "turn", [widget(["first"])], f.observer); await settle();
  assert.equal(f.requests.length, 1); assert.equal(f.writes.length, 1); assert.deepEqual(f.results.map(r => r.result), ["failed"]);
  f.native.observe("thread", "turn", [accepted(f.writes[0].prompt)], f.observer); await settle();
  assert.deepEqual(f.results.map(r => r.result), ["failed", "confirmed"]);
});

test("an answer accepted on the peer withdraws an unsubmitted prompt instead of sending a late answer", async () => {
  const f = fixture(); f.native.observe("thread", "turn", [widget(["first"])], f.observer); await settle();
  const q = f.requests[0].request.questions[0], text = `<send_user_message_question_reply>\n${JSON.stringify([
    { questionItemId: q.id, question: "first", answer: "peer answer" }])}\n</send_user_message_question_reply>`;
  f.native.observe("thread", "turn", [accepted(text)], f.observer); await settle();
  f.answers[0].resolve({ [q.id]: { answers: ["late answer"] } }); await settle();
  assert.deepEqual(f.results.map(r => r.result), ["withdrawn"]); assert.equal(f.writes.length, 0);
});

test("changing or revoking the source prevents an old widget answer from writing", async () => {
  const f = fixture(); f.native.observe("thread", "turn", [widget(["first"])], f.observer); await settle();
  const q = f.requests[0].request.questions[0];
  f.native.observe("thread", "turn", [widget(["changed question"])], f.observer); await settle();
  f.answers[0].resolve({ [q.id]: { answers: ["obsolete answer"] } }); await settle();
  assert.equal(f.writes.length, 0); assert.equal(f.requests.length, 2);
  f.revoke(); const changed = f.requests[1].request.questions[0];
  f.answers[1].resolve({ [changed.id]: { answers: ["revoked answer"] } }); await settle();
  assert.equal(f.writes.length, 0); assert.deepEqual(f.results.map(r => r.result), ["withdrawn", "withdrawn"]);
});

test("native turn end invalidates an awaiting widget and never writes after disconnect", async () => {
  const f = fixture(); f.native.observe("thread", "turn", [widget(["first"])], f.observer); await settle();
  f.native.end("thread", "turn"); f.native.disconnect();
  const q = f.requests[0].request.questions[0]; f.answers[0].resolve({ [q.id]: { answers: ["too late"] } }); await settle();
  assert.equal(f.writes.length, 0); assert.deepEqual(f.results.map(r => r.result), ["withdrawn"]);
});

test('removing a native widget invalidates its pending reply before any native input',async()=>{
 const f=fixture();f.native.observe('thread','turn',[widget(['first'])],f.observer);await settle();
 f.native.observe('thread','turn',[widget([])],f.observer);await settle();
 const q=f.requests[0].request.questions[0];f.answers[0].resolve({[q.id]:{answers:['late']}});await settle();
 assert.equal(f.writes.length,0);assert.deepEqual(f.results.map(r=>r.result),['withdrawn']);
});

for (const change of ["none", "observer", "widget", "edited", "peer", "turn", "disconnect"] as const) {
  test(`native async answer rechecks its original source after connection preparation: ${change}`, async t => {
    const connected = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const runner = new AppServerCodexRunner() as any;
    runner.ensureConnected = async () => { entered.resolve(); await connected.promise; };
    let writes = 0, current = true, question: NativeUserInput | undefined;
    runner.request = async (method: string, params: any) => {
      assert.equal(method, "turn/steer"); assert.equal(params.threadId, "thread"); assert.equal(params.expectedTurnId, "turn");
      writes++; return { turnId: "turn" };
    };
    const answer = Promise.withResolvers<CodexUserInputAnswer | undefined>();
    const results: string[] = [];
    const observer: NativeInteractionObserver = { onApproval: async () => undefined,
      onUserInput(input) {
        if (question) return new Promise<CodexUserInputAnswer | undefined>(() => {});
        question = input; return answer.promise;
      },
      onUserInputResult(_input, result) { results.push(result); } };
    const native = new NativeAsyncQuestions("local", () => current, input => runner.steer(input), () => {});
    t.after(() => { connected.resolve(); native.disconnect(); runner.close(); });
    native.observe("thread", "turn", [widget(["first"])], observer); await settle(); assert.ok(question);
    answer.resolve({ [question.request.questions[0].id]: { answers: ["old answer"] } });
    await entered.promise;
    if (change === "observer") current = false;
    if (change === "widget") native.observe("thread", "turn", [widget([])], observer);
    if (change === "edited") native.observe("thread", "turn", [widget(["changed question"])], observer);
    if (change === "peer") {
      const q = question.request.questions[0];
      native.observe("thread", "turn", [accepted(`<send_user_message_question_reply>\n${JSON.stringify([
        { questionItemId: q.id, question: q.question, answer: "peer answer" }])}\n</send_user_message_question_reply>`)], observer);
    }
    if (change === "turn") native.end("thread", "turn");
    if (change === "disconnect") native.disconnect();
    connected.resolve(); await settle();
    assert.equal(writes, change === "none" ? 1 : 0);
    assert.equal(results.includes("confirmed"), false, "an RPC receipt alone never certifies an answered widget");
  });
}

test("withdrawing a widget before the notification microtask never invokes its old question callback", async () => {
  const f = fixture();
  f.native.observe("thread", "turn", [widget(["first"])], f.observer);
  f.native.end("thread", "turn");
  await settle();
  assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0);
});
