import assert from "node:assert/strict";
import test from "node:test";
import { NativeAsyncQuestions } from "../src/codex/native-async-questions.js";
import type { NativeInteractionObserver, NativeUserInput } from "../src/codex/interactions.js";
import type { CodexSteerInput, CodexSteerResult, CodexUserInputAnswer } from "../src/codex/backend.js";

const settle = async () => { for (let n = 0; n < 4; n++) await new Promise<void>(r => setImmediate(r)); };
const widget = (questions = ["first", "second"]) => ({ type: "agentMessage", id: "widget", questions: questions.map(title => ({ title, options: null })) });
const accepted = (text: string, id = "native-answer") => ({ type: "steeringUserMessage", id, status: "accepted", input: [{ type: "text", text }] });
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
