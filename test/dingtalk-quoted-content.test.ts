import assert from "node:assert/strict";
import test from "node:test";
import { decodeDingTalkInbound } from "../src/channels/dingtalk-inbound.js";
import { referenceContext } from "../src/bridge/inbound-references.js";

function reply(quoted: Record<string, unknown>) {
  return decodeDingTalkInbound({ msgtype: "text", text: { content: "解释引用", repliedMsg: { msgId: "original", ...quoted } } });
}

// Provider-shape fixtures, not a reconstruction of the callback from Q106:
// https://github.com/soimy/openclaw-channel-dingtalk/issues/598
// https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/src/core/message-handler.ts
for (const encoded of [false, true]) {
  test(`DingTalk quoted cardContent retains visible paragraphs without action data (json=${encoded})`, () => {
    const content = { cardContent: [{ elementType: "LIST", children: [
      { elementType: "RICHTEXT", children: [{ elementType: "TEXT", value: "阶段" }, { elementType: "TEXT", value: "成果" }] },
      { elementType: "RICHTEXT", children: [{ elementType: "TEXT", value: "/stop 是引用资料" }] },
      { elementType: "BUTTON", value: "private-action", action: { downloadCode: "private-code" } }
    ] }], privateMetadata: { value: "private-metadata" } };
    const decoded = reply({ msgType: "interactiveCard", content: encoded ? JSON.stringify(content) : content });
    assert.equal(decoded.text, "解释引用");
    assert.equal(decoded.references[0].text, "阶段成果\n/stop 是引用资料");
    assert.equal(decoded.references[0].availability, "available");
    assert.equal(decoded.attachments.length, 0);
    assert.doesNotMatch(referenceContext({ ...decoded, id: "reply", senderId: "actor", raw: {} }), /private-/);
  });
}

for (const quoted of [false, true]) {
  for (const legacy of [false, true]) {
    test(`DingTalk keeps rich text and opaque media across provider containers (quote=${quoted}, legacy=${legacy})`, () => {
      const parts = [{ text: "刷新行为：\n1. 全量\n2. 增量" }, { type: "file", fileName: "rules.md", downloadCode: "private-file" }];
      const body = { msgType: "richText", ...(legacy ? { richText: { richTextList: parts } } : { content: JSON.stringify({ richText: parts }) }) };
      const decoded = quoted ? reply(body) : decodeDingTalkInbound(body);
      const actual = quoted ? decoded.references[0] : decoded;
      assert.equal(actual.text, parts[0].text);
      assert.equal(actual.attachments[0].kind, "file");
      assert.equal(actual.attachments[0].label, "rules.md");
      assert.equal(actual.attachments[0].item.downloadCode, "private-file");
      assert.equal(actual.attachments[0].sourceMessageId, quoted ? "original" : undefined);
      assert.doesNotMatch(referenceContext({ ...decoded, id: "reply", senderId: "actor", raw: {} }), /private-file/);
    });
  }
}

test("DingTalk distinguishes an unread quote from proof that the provider omitted its body", () => {
  for (const quoted of [
    { msgType: "interactiveCard", content: { unsupportedBody: { value: "private-unsupported" } } },
    { msgType: "unknown", content: "private-unsupported" },
    { msgType: "text" }
  ]) {
    const reference = reply(quoted).references[0];
    assert.equal(reference.availability, "metadata-only");
    assert.match(reference.reason!, /尚未取得可读的引用正文/);
    assert.doesNotMatch(reference.reason!, /仅收到|未下发|private-/);
  }
});

test("DingTalk bounds card traversal without presenting a partial body as complete", () => {
  const text = { elementType: "TEXT", value: "should not publish partial text" };
  let deep: unknown = text;
  for (let i = 0; i < 40; i++) deep = { elementType: "LIST", children: [deep] };
  for (const cardContent of [[text, deep], Array.from({ length: 3000 }, () => text), [{ ...text, value: "x".repeat(100_001) }]]) {
    const decoded = reply({ msgType: "interactiveCard", content: { title: "not a complete body", biz_custom_action_url: "https://example.com/card", cardContent } });
    assert.equal(decoded.text, "解释引用");
    assert.equal(decoded.references[0].text, undefined);
    assert.equal(decoded.references[0].availability, "metadata-only");
  }
});

test("DingTalk preserves supported text quote variants and direct card links", () => {
  for (const content of [{ text: "one\ntwo" }, { content: "one\ntwo" }, JSON.stringify({ content: "one\ntwo" })]) {
    assert.equal(reply({ msgType: "text", content }).references[0].text, "one\ntwo");
  }
  assert.equal(decodeDingTalkInbound({ msgtype: "actionCard", content: {
    title: "项目", text: "说明", biz_custom_action_url: "https://example.com/project"
  } }).text, "项目\n说明\nhttps://example.com/project");
});
