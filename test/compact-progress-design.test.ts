import assert from "node:assert/strict";
import test from "node:test";
import { Lexer } from "marked";
import { renderTurnProgressLayout, renderTurnProgressCard } from "../src/channels/turn-progress-card.js";

import { sessionHeadingContext, withTurnStatus } from "../src/channels/turn-status.js";
import { completedCardForMentions } from "../src/channels/completion-mentions.js";

const facts = { activity: "running" as const, elapsed: "30 秒", current: "**正在梳理 JsonObject 接口边界**\n**我正梳理 JsonObject 与属性校验边界**",
  recent: [], tools: {completed: 0, failed: 0}, answerPreview: "" };

test("a short running card keeps compact prose and a separate exact stop command copy box", () => {
  const view = renderTurnProgressLayout(facts);
  assert.match(view.body, /^\*\*进行中\*\* ⏳ · 30 秒/);
  assert.match(view.body, /正在梳理 JsonObject 接口边界/);
  assert.match(view.body, /我正梳理 JsonObject 与属性校验边界/);
  assert.doesNotMatch(view.body, /当前进展|公开摘要|任务仍在执行|\*\*正在|\*\*我正/);
  assert.deepEqual(Lexer.lex(view.footer).filter(token => token.type === "code").map(token => ({ lang: token.lang, text: token.text })), [{ lang: "text", text: "/stop" }]);
  assert.match(view.footer, /复制不会发送/);
  assert.doesNotMatch(view.body, /\/stop|```/);
  assert.ok(view.body.split(/\n+/).length <= 4);
});

test("formatting-only differences do not repeat the same public summary or remove its literal code", () => {
  const current = "正在检查 `checkIndexProperties`，保留 **literal** 值";
  const view = renderTurnProgressLayout({...facts, current, thought: current.replace("正在检查", "**正在检查**")});
  assert.equal((view.body.match(/checkIndexProperties/g) ?? []).length, 1);
  assert.match(view.body, /`checkIndexProperties`/);
  assert.equal(view.body.split("literal").length - 1, 1);
});

test("waiting and recovery retain explicit state while preview code cannot create an extra copy widget", () => {
  for (const activity of ["waiting-input", "waiting-approval", "recovering"] as const) {
    const view = renderTurnProgressCard({...facts, activity, notice: "等待原生状态确认", answerPreview: "```ts\nconst x = 1;"});
    assert.match(view, /等待原生状态确认/);
    assert.deepEqual(Lexer.lex(view).filter(token => token.type === "code").map(token => ({ lang: token.lang, text: token.text })), [{ lang: "text", text: "/stop" }]);
    assert.equal((view.match(/\/stop/g) ?? []).length, 1);
    assert.equal(Lexer.lex(view).at(-1)?.type, "paragraph");
  }
});

test("unconfirmed historical progress never offers a stop command for the chat's current task", () => {
  const input = { ...facts, activity: "unconfirmed" as const };
  const layout = renderTurnProgressLayout(input);
  assert.equal(layout.footer, "");
  assert.match(layout.body, /执行状态待确认/);
  assert.doesNotMatch(renderTurnProgressCard(input), /\/stop|停止任务（|复制不会发送/);
});


test("context changes only the first line of running, completed and combined mention cards", () => {
  const name = sessionHeadingContext({title:"默认会话", threadId:"native-12345678", createdByFirstContact:true}, "研发机");
  assert.equal(name, "默认会话 12345678 · 研发机");
  const baseline = renderTurnProgressLayout(facts), labeled = renderTurnProgressLayout({...facts, headingContext:name});
  assert.deepEqual(labeled, {...baseline, body:baseline.body.replace(baseline.status!, baseline.status + " · " + name), status:baseline.status + " · " + name});
  const body = "* 项目符号\n\n```text\n/answer Q1 好\n```\n\n[打开项目 Web IDE](https://example.invalid/ide)";
  assert.equal(withTurnStatus(body,"completed", name), withTurnStatus(body,"completed").replace("**已完成**","**已完成** · " + name));
  const snapshot = { finished:true, resultPresentation:"card", messageId:"m", progressEntries:[], statusHeader:true,
    terminal:{text:body}, terminalPages:[{messageId:"m",delivered:true}] };
  const old = completedCardForMentions(snapshot as never)!, current = completedCardForMentions({...snapshot,headingContext:name} as never)!;
  for (const key of ["text","summary"] as const) assert.equal(current[key], old[key].replace("**已完成**","**已完成** · " + name));
  const unsafe = sessionHeadingContext({title:"a_b\n[跳转](url)"}, "机".repeat(40));
  assert.equal(Lexer.lex(unsafe)[0].type,"paragraph");
  assert.doesNotMatch(unsafe,/\n/); assert.ok(unsafe.endsWith("…"));
});
