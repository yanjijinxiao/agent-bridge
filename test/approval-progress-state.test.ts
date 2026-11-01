import assert from "node:assert/strict";
import test from "node:test";
import { Lexer } from "marked";
import { ChannelTurnTextStream } from "../src/channels/progress.js";
import { renderTurnProgressCard } from "../src/channels/turn-progress-card.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";

const facts = { activity: "waiting-approval" as const, elapsed: "30 秒", current: "最近进展",
  recent: [], tools: { completed: 0, failed: 0 }, answerPreview: "" };
const commands = (text: string) => Lexer.lex(text).filter(token => token.type === "code").map(token => token.text);

test("a native waitingOnApproval flag does not invent an actionable human approval", () => {
  const text = renderTurnProgressCard(facts);
  assert.match(text, /等待权限审批结果，任务尚未完成/);
  assert.doesNotMatch(text, /等待你的审批|等待你的操作|\/approve|\/reject/);
  assert.deepEqual(commands(text), ["/stop"]);
  assert.match(renderTurnProgressCard({ ...facts, activity: "waiting-input" }), /等待你的回答/);
});

for (const compact of [true, false]) test(`restored ${compact ? "compact" : "legacy"} approval progress retains its card and exact controls`, async t => {
  const frames: Array<{ text: string; messageId: string; activity?: string }> = [];
  const client = createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, progress: "available",
    turnStatusHeader: "available", resumableProgress: true }, {
    async sendText() { throw Error("must not send a duplicate notice"); },
    async startTextStream() { throw Error("must retain the original card"); },
    async updateTextStream(input) { frames.push(input); }
  });
  const stream = new ChannelTurnTextStream(client, "chat", { save() {}, restore: {
    streamId: "stream", messageId: "card", startedAt: Date.now(), progressEntries: ["最近进展"],
    thought: "", answerPreview: "", finished: false, activity: "waiting-approval",
    ...(compact ? { statusHeader: true } : { resultPageBytes: 1024 })
  } });
  t.after(() => stream.suspend());
  await stream.synchronize();
  assert.equal(frames.at(-1)?.messageId, "card");
  assert.equal(frames.at(-1)?.activity, "waiting-approval");
  assert.match(frames.at(-1)!.text, /等待(?:权限审批|审批)结果/);
  assert.doesNotMatch(frames.at(-1)!.text, /等待你的审批|等待你的操作|\/approve|\/reject/);
  assert.deepEqual(commands(frames.at(-1)!.text), ["/stop"]);
  await stream.setActivity("waiting-input"); await stream.flush();
  assert.match(frames.at(-1)!.text, /等待你的回答|等待你的操作/);
  await stream.setActivity("running"); await stream.flush();
  assert.equal(frames.at(-1)?.activity, "running");
  assert.doesNotMatch(frames.at(-1)!.text, /等待.*审批|等待你的操作/);
  assert.deepEqual(commands(frames.at(-1)!.text), ["/stop"]);
});
