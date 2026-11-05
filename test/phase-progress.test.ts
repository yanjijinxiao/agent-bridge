import assert from "node:assert/strict";
import test from "node:test";
import { ChannelTurnPresentation } from "../src/channels/turn-presentation.js";
import type { ChannelStreamCheckpoint } from "../src/channels/progress.js";
import type { ChannelTextClient } from "../src/channels/types.js";
import { ChannelProgressError } from "../src/channels/errors.js";
import { dingTalkProgressContent, normalizeDingTalkCardContent } from "../src/channels/dingtalk-markdown.js";
import { TEXT_CAPABILITIES } from "../src/channels/client.js";
import { splitPhaseCommentary } from "../src/channels/phase-progress.js";
import { markdownPreview } from "../src/channels/markdown-preview.js";

function fixture(t: test.TestContext) {
  const starts: any[] = [], frames: any[] = [], saves: ChannelStreamCheckpoint[] = [];
  let failCreate = false, failSummary = false;
  const client: ChannelTextClient = { resumableTextStream: true, capabilities: { ...TEXT_CAPABILITIES,
    progress: "available", progressFooter: "available", turnStatusHeader: "available", resultPageBytes: 6000 },
    async sendText() { throw Error("no text fallback"); },
    async startTextStream(input) { starts.push(input); if (failCreate) throw new ChannelProgressError(false);
      return { messageId: input.streamId! }; },
    async updateTextStream(input) { if (failSummary && input.finalize) throw new ChannelProgressError(false, input.messageId);
      frames.push(input); }
  };
  const options = { save: (value: ChannelStreamCheckpoint) => saves.push(structuredClone(value)),
    decorateProgress: (text: string) => `${text}\n\n[打开项目 Web IDE](https://example.test/workspace/project)` };
  let stream = new ChannelTurnPresentation(client, "room", options);
  t.after(() => stream.suspend());
  return { starts, frames, saves, get stream() { return stream; },
    failCreate(value: boolean) { failCreate = value; }, failSummary(value: boolean) { failSummary = value; },
    async restart() { const restore = stream.checkpoint(); await stream.suspend();
      stream = new ChannelTurnPresentation(client, "room", { ...options, restore }); } };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("commentary persists while live tool and thought activity stays bounded, then becomes a phase summary", async t => {
  const f = fixture(t);
  await f.stream.progress("第一阶段：定位根因");
  for (let i = 0; i < 40; i++) {
    await f.stream.progress(`🤔 正在检查公开摘要 ${i}`);
    await f.stream.progress(`🔌 正在调用工具：reader/${i}`);
    await f.stream.progress(`✅ 工具调用完成：reader/${i}`);
  }
  await f.stream.flush();
  assert.equal(f.starts.length, 1);
  const live = f.frames.at(-1).text;
  assert.match(live, /第一阶段：定位根因/); assert.doesNotMatch(live, /reader\/0\b|摘要 0\b/);
  assert.ok(f.stream.checkpoint().phaseProgress!.live.length <= 3);
  await f.stream.progress("第二阶段：补充复现"); await f.stream.flush();
  const second = f.frames.at(-1);
  assert.match(second.text, /第一阶段：定位根因[\s\S]*工具完成 40 次[\s\S]*第二阶段：补充复现/);
  assert.doesNotMatch(second.text, /reader\/|正在检查公开摘要/);
  assert.equal(second.text.split("第二阶段：补充复现").length - 1, 1);
  assert.match(second.progressLayout.footer, /```text\n\/stop\n```/);
  assert.match(second.progressLayout.footer, /https:\/\/example.test\/workspace\/project/);
  assert.doesNotMatch(second.progressLayout.body, /\/stop/);
  await f.restart(); await f.stream.synchronize();
  assert.match(f.frames.at(-1).text, /第一阶段：定位根因[\s\S]*第二阶段：补充复现/);
  assert.equal(f.starts.length, 1);
});

test("more than four commentary phases remain visible with no duplicate commentary in the live window", async t => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) await f.stream.progress(`阶段 ${i} 的已核实结果`);
  await f.stream.flush();
  for (let i = 0; i < 12; i++) assert.equal(f.frames.at(-1).text.split(`阶段 ${i} 的已核实结果`).length - 1, 1);
  assert.equal(f.starts.length, 1);
});

test("long Chinese commentary rotates durably, preserves all phases and IDE, and removes old stop controls", async t => {
  const f = fixture(t);
  const phases = Array.from({length: 9}, (_, i) => `阶段${i}：${"成果验证🙂".repeat(95)}`);
  for (const phase of phases) { await f.stream.progress(phase); await f.stream.flush(); }
  await settle();
  assert.ok(f.starts.length > 1);
  const finals = f.frames.filter(frame => frame.finalize);
  const currentId = f.stream.checkpoint().messageId;
  const currentFrame = f.frames.filter(frame => frame.messageId === currentId).at(-1)
    ?? f.starts.find(frame => frame.streamId === currentId);
  const content = finals.map(frame => frame.text).join("\n") + currentFrame.text;
  for (const phase of phases) assert.ok(content.includes(phase), `lost ${phase.slice(0, 6)}`);
  for (const frame of finals) {
    assert.match(frame.text, /阶段小结/); assert.match(frame.text, /打开项目 Web IDE/);
    assert.doesNotMatch(frame.text, /\/stop|^\*\*已完成\*\*/);
  }
  for (const frame of [...f.starts, ...f.frames]) {
    const rendered = frame.progressLayout ? dingTalkProgressContent(frame.progressLayout.body)
      + normalizeDingTalkCardContent(frame.progressLayout.footer) : normalizeDingTalkCardContent(frame.text);
    assert.ok(Buffer.byteLength(rendered) <= 6000, `oversize ${Buffer.byteLength(rendered)}`);
  }
  const id = f.stream.checkpoint().streamId, count = f.starts.length;
  assert.ok(f.saves.some(saved => saved.streamId === id && !saved.creationAttempted && saved.segments?.previous.length));
  await f.restart(); await f.stream.synchronize(); assert.equal(f.starts.length, count);
  await f.stream.finalize("最终结果"); assert.equal(f.frames.at(-1).messageId, id);
});

for (const text of ["核验🙂中文".repeat(1400), "A".repeat(15000)]) test(`one oversized commentary preserves every source character (${text[0]})`, async t => {
  const f = fixture(t);
  await f.stream.progress(text); await f.stream.flush(); await settle();
  assert.ok(f.starts.length > 1);
  const saved = new Map<string, ChannelStreamCheckpoint>();
  for (const checkpoint of f.saves) {
    for (const previous of checkpoint.segments?.previous ?? []) saved.set(previous.checkpoint.streamId!, previous.checkpoint);
    saved.set(checkpoint.streamId!, checkpoint);
  }
  // Source slices can split between words but cannot lose any code point.
  assert.equal([...saved.values()].flatMap(checkpoint => checkpoint.phaseProgress?.phases.map(phase => phase.text) ?? []).join(""), text);
  for (const frame of [...f.starts, ...f.frames]) assert.ok(Buffer.byteLength(frame.text) <= 6000);
});

test("phase summaries preserve failed tool evidence without declaring the task failed or successful", async t => {
  const f = fixture(t);
  await f.stream.progress("分析第一阶段"); await f.stream.progress("❌ 文件检查失败，退出码 2");
  await f.stream.progress("已经定位原因，继续修复"); await f.stream.flush();
  assert.match(f.frames.at(-1).text, /工具异常 1 次（非任务终态）/);
  assert.match(f.frames.at(-1).text, /^\*\*进行中\*\*/);
  assert.equal(f.stream.checkpoint().terminal, undefined);
});

test("escaping-heavy commentary budgets rendered bytes and preserves exact source slices", () => {
  for (const source of ["<>&_\\".repeat(4000), "[链接](https://example.test/" + "a".repeat(12000) + ")"]) {
    const chunks = splitPhaseCommentary(source, 2000);
    assert.equal(chunks.join(""), source);
    for (const chunk of chunks) assert.ok(Buffer.byteLength(markdownPreview(chunk, Number.MAX_SAFE_INTEGER, { emphasis: false })) <= 2000);
  }
});

test("a failed old summary does not block the new card and restart retries only its original handle", async t => {
  const f = fixture(t); f.failSummary(true);
  await f.stream.progress("第一阶段" + "已核验".repeat(220));
  const old = f.stream.checkpoint().messageId;
  await f.stream.progress("第二阶段" + "已核验".repeat(220)); await f.stream.flush(); await settle();
  const current = f.stream.checkpoint().messageId;
  assert.notEqual(current, old); assert.equal(f.starts.length, 2);
  assert.ok(f.stream.checkpoint().segments?.previous.length);
  await f.restart(); f.failSummary(false); await f.stream.synchronize(); await settle();
  assert.ok(f.frames.some(frame => frame.messageId === old && frame.finalize));
  assert.equal(f.starts.length, 2); assert.equal(f.stream.checkpoint().messageId, current);
});

test("a lost continuation create receipt never authorizes further replacement cards", async t => {
  const f = fixture(t);
  await f.stream.progress("第一阶段" + "已核验".repeat(220)); f.failCreate(true);
  await f.stream.progress("第二阶段" + "已核验".repeat(220));
  const checkpoint = f.stream.checkpoint(); assert.equal(checkpoint.messageId, undefined);
  assert.equal(checkpoint.creationAttempted, true);
  await f.restart(); f.failCreate(false);
  await f.stream.progress("第三阶段" + "已核验".repeat(220));
  assert.equal(f.starts.length, 2); assert.equal(f.stream.checkpoint().streamId, checkpoint.streamId);
});
