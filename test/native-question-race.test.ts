import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sharedNativeCore, message, tool, until } from "./fixtures/shared-native-core.mjs";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { ChannelUserInputController } from "../src/bridge/user-input-controller.js";

for (const winner of ["im", "ui"] as const) test(`INT-04.2: real native question accepts one ${winner} answer and retires the other surface`, {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30000,
}, async t => {
  const core = await sharedNativeCore(t, (_body: any, n: number) => n === 2 ? tool("request_user_input", {
    questions: [{ id: "direction", header: "Direction", question: "Choose isolated test direction",
      options: [{ label: "Left", description: "First option" }, { label: "Right", description: "Second option" }] }],
  }, n) : message(`DONE_${n}`, n));
  const peer = await core.rpc("question_race_owner");
  const { thread } = await peer.request("thread/start", { cwd: core.root });
  await peer.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "initialize", text_elements: [] }] });
  await until(() => peer.events.some(e => e.method === "turn/completed"));
  const runner = core.runner(), writes: any[] = [], send = (runner as any).send.bind(runner);
  (runner as any).send = (value: any) => { if (!value.method) writes.push(value); return send(value); };
  const backend = new CodexAppServerGateway({ appServerBackend: runner });
  const ui = Promise.withResolvers<any>(), uiObserved = Promise.withResolvers<any>(), results: string[] = [];
  const journal = path.join(core.root, "im-question.json");
  const im = new ChannelUserInputController(async () => ({ messageId: "question" }), undefined, {
    filePath: journal, sendNotice: async () => {},
  });
  t.after(async () => { ui.resolve(undefined); im.close(); await backend.close(); });
  await backend.observeThreadInteractions(thread.id, "local", {
    onApproval: async () => undefined,
    onUserInput: envelope => { uiObserved.resolve(envelope); return ui.promise; },
    onUserInputResult: (_envelope, result) => { results.push(`ui:${result}`); },
  }, "taskboard");
  await backend.observeThreadInteractions(thread.id, "local", {
    onApproval: async () => undefined,
    onUserInput: envelope => im.request("room", envelope.request),
    onUserInputResult: async (envelope, result) => { results.push(`im:${result}`); await im.reportResult("room", envelope.request, result); },
  });
  const accepted = await peer.request("turn/start", { threadId: thread.id, clientUserMessageId: "one-question-turn",
    input: [{ type: "text", text: "ask isolated question", text_elements: [] }],
    collaborationMode: { mode: "plan", settings: { model: "mock-model", reasoning_effort: "medium", developer_instructions: null } },
  });
  await until(() => fs.existsSync(journal) && peer.requests.some(e => e.method === "item/tool/requestUserInput"));
  const envelope = await uiObserved.promise;
  assert.equal(envelope.request.turnId, accepted.turn.id);
  if (winner === "im") {
    assert.match(im.answer("room", "Q1 Left"), /已记录/); await until(() => writes.length === 1);
    ui.resolve({ direction: { answers: ["Right"] } });
  } else {
    ui.resolve({ direction: { answers: ["Right"] } }); await until(() => writes.length === 1);
    im.answer("room", "Q1 Left");
  }
  await until(() => results.includes(`${winner}:confirmed`));
  await until(() => peer.events.some(e => e.method === "turn/completed" && e.params?.turn?.id === accepted.turn.id));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].result, { answers: { direction: { answers: [winner === "im" ? "Left" : "Right"] } } });
  assert.ok(results.includes(`${winner === "im" ? "ui" : "im"}:withdrawn`));
  assert.equal(JSON.parse(fs.readFileSync(journal, "utf8")).records[0].status, winner === "im" ? "confirmed" : "withdrawn");
  assert.equal((await runner.getHistory(thread.id)).filter(row => row.clientUserMessageId === "one-question-turn").length, 1);
  assert.equal(core.calls.length, 3);
});
