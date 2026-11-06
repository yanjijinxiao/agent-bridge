import assert from "node:assert/strict";
import test from "node:test";
import { Lexer } from "marked";
import { DingTalkHttpsAICardClient, DingTalkSdkAICardClient } from "../src/channels/dingtalk.js";
import { ChannelTurnPresentation } from "../src/channels/turn-presentation.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { withIDEEntry } from "../src/ide/completion.js";

for (const mode of ["https", "sdk"] as const) test(`DEL-09.5: ${mode} long phases stay complete while every task stream frame fits 1 KiB`, async t => {
  const cards = new Map<string, Record<string, string>>();
  const writes: Array<{ kind: string; body: any }> = [];
  const record = (kind: string, body: any) => {
    writes.push({ kind, body });
    const card = cards.get(body.outTrackId) ?? {};
    cards.set(body.outTrackId, card);
    if (body.cardData) Object.assign(card, body.cardData.cardParamMap);
    if (kind === "stream") {
      assert.ok(Buffer.byteLength(body.content) <= 1024, "measure UTF-8 after DingTalk Markdown conversion");
      assert.equal(body.isFull, true);
      assert.doesNotMatch(body.content, /阶段成果/);
      card[body.key] = body.content;
    }
  };
  const transport = mode === "https" ? new DingTalkHttpsAICardClient(async (url, init) => {
    const kind = String(url).endsWith("/streaming") ? "stream" : String(url).endsWith("/deliver") ? "deliver" : init?.method === "POST" ? "create" : "state";
    record(kind, JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ success: true, result: kind === "create" ? "instance" : kind === "deliver" ? [{ success: true }] : true }), { status: 200 });
  }, [0], async () => {}) : new DingTalkSdkAICardClient({
    async createCardWithOptions(body) { record("create", body); return { statusCode: 200, body: { success: true, result: "instance" } }; },
    async deliverCardWithOptions(body) { record("deliver", body); return { statusCode: 200, body: { success: true, result: [{ success: true }] } }; },
    async updateCardWithOptions(body) { record("state", body); return { statusCode: 200, body: { success: true, result: true } }; },
    async streamingUpdateWithOptions(body) { record("stream", body); return { statusCode: 200, body: { success: true, result: true } }; }
  } as never, [0], async () => {});
  const base = { accessToken: "fixture", contentKey: "msgContent", error: false };
  const client = createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, progress: "available", turnStatusHeader: "available",
    progressFooter: "available", resumableProgress: true, resultPageBytes: 6000 }, {
    async sendText() { throw Error("no fallback or duplicate message"); },
    async startTextStream(input) {
      await transport.create({ ...base, ...input, outTrackId: input.streamId!, cardTemplateId: "template", robotCode: "fixture", target: { type: "group", conversationId: "room" } });
      await transport.update({ ...base, ...input, outTrackId: input.streamId!, finalize: false });
      return { messageId: input.streamId! };
    },
    async updateTextStream(input) { await transport.update({ ...base, ...input, outTrackId: input.messageId, finalize: input.finalize ?? false }); }
  });
  const options = { save() {}, decorateProgress: (text: string) => withIDEEntry(text, "https://example.test/workspace/project", { atEnd: true }) };
  let stream = new ChannelTurnPresentation(client, "room", options);
  t.after(() => stream.suspend());
  const view = (card: Record<string, string>) => JSON.parse(card.sys_full_json_obj).order.map((key: string) => card[key]).join("\n\n");
  for (let i = 0; i < 24; i++) {
    await stream.progress(`阶段成果${i}：已核对 🧪 ${"中文结果与接口边界验证。".repeat(12)}`);
    await stream.flush();
    assert.match(view(cards.get(stream.checkpoint().messageId!)!), new RegExp(`阶段成果${i}：`));
    for (let j = 0; j < 3; j++) await stream.progress(`🤔 当前检查 ${i}-${j} ${"🔎核对".repeat(40)}`);
    await stream.flush();
    const card = cards.get(stream.checkpoint().messageId!)!;
    assert.deepEqual(Lexer.lex(card.msgContent).filter(token => token.type === "code").map(token => token.text), ["/stop"]);
    assert.equal(view(card).split("[打开项目 Web IDE]").length - 1, 1);
  }
  for (let i = 0; i < 100 && stream.checkpoint().segments?.previous.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(stream.checkpoint().segments?.previous.length ?? 0, 0);
  const activeId = stream.checkpoint().messageId!;
  const allVisible = [...cards.values()].map(view).join("\n");
  for (let i = 0; i < 24; i++) assert.match(allVisible, new RegExp(`阶段成果${i}：`), "rotation preserves all phase outcomes");
  for (const [id, card] of cards) if (id !== activeId) {
    assert.equal(card.flowStatus, "3"); assert.match(view(card), /阶段小结/); assert.doesNotMatch(view(card), /\/stop/);
  }
  assert.ok(cards.size > 1 && cards.size < 12, "rotate by the complete card budget, never per tool or small stream frame");
  const restore = stream.checkpoint(), count = cards.size;
  await stream.suspend(); stream = new ChannelTurnPresentation(client, "room", { ...options, restore });
  await stream.synchronize();
  assert.equal(cards.size, count); assert.equal(stream.checkpoint().messageId, activeId);
  await stream.finalize("已完成本任务。\n\n```text\n精确交付值\n```");
  assert.equal(cards.get(activeId)!.flowStatus, "3");
  assert.match(view(cards.get(activeId)!), /精确交付值/); assert.doesNotMatch(view(cards.get(activeId)!), /\/stop/);
});

for (const mode of ["https", "sdk"] as const) test(`DEL-09.5: ${mode} rejected snapshot is retried on the same card after transport reconstruction`, async () => {
  let reject = false;
  const frames: any[] = [], states: any[] = [];
  const state = (body: any) => {
    states.push(body);
    return { statusCode: 200, body: reject ? { success: false, result: false } : { success: true, result: true } };
  };
  const make = () => mode === "https" ? new DingTalkHttpsAICardClient(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/streaming")) { frames.push(body); return new Response(JSON.stringify({ success: true, result: true })); }
    return new Response(JSON.stringify(state(body).body));
  }, [0], async () => {}) : new DingTalkSdkAICardClient({
    async updateCardWithOptions(body) { return state(body); },
    async streamingUpdateWithOptions(body) { frames.push(body); return { statusCode: 200, body: { success: true, result: true } }; }
  } as never, [0], async () => {});
  const input = { accessToken: "fixture", contentKey: "msgContent", outTrackId: "original-card", error: false, finalize: false,
    activity: "running" as const, text: "ignored combined presentation", progressLayout: {
      status: "进行中 · 1 分钟", body: "进行中 · 1 分钟\n\n阶段成果一", footer: "```text\n/stop\n```" } };
  let transport = make(); await transport.update(input);
  reject = true;
  input.progressLayout.body += "\n\n阶段成果二";
  const count = frames.length;
  await assert.rejects(transport.update(input));
  assert.equal(frames.length, count, "failed snapshot cannot be acknowledged by a successful status-only stream");
  reject = false; transport = make(); await transport.update(input);
  assert.match(states.at(-1).cardData.cardParamMap.staticMsgContent, /阶段成果一.*阶段成果二/s);
  assert.equal(frames.length, 2, "initial and reconstructed transports each initialize the footer; body stays static");
  assert.ok([...states, ...frames].every(frame => frame.outTrackId === "original-card"));
  const beforeFinal = states.length;
  await transport.update({ ...input, text: "阶段已结束", finalize: true });
  assert.equal(states.length, beforeFinal + 1, "closing never re-enters input mode or clears the last readable snapshot first");
  assert.equal(states.at(-1).cardData.cardParamMap.flowStatus, "3");
  assert.doesNotMatch(states.at(-1).cardData.cardParamMap.staticMsgContent, /\/stop/);
});
