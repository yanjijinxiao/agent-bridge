import assert from "node:assert/strict";
import test from "node:test";
import { dingTalkMentionCard, dingTalkCardAtParameters } from "../src/channels/dingtalk-mentions.js";
import { DingTalkChannelAdapter, normalizeDingTalkCardContent } from "../src/channels/dingtalk.js";
import { withIDEEntry } from "../src/ide/completion.js";

test("DEL-07.3: combined UTF8 answer, native mentions and IDE footer respect the exact final normalized capacity", async () => {
  let writes = 0;
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", savedAt: "", enabled: true }, {
    cardClient: { async create() { writes++; }, async update() { writes++; } },
    streamClient: { async getAccessToken() { writes++; return "fake"; } } as never
  });
  for (const count of [1, 50]) {
    const mentions = Array.from({ length: count }, (_, i) => ({ userId: `user${i}`, name: `成员🙂${i}` }));
    const anchor = mentions.map(m => `<a atId=${m.userId}>${m.name}</a>`).join(" ") + "\n\n";
    const suffix = withIDEEntry("中文🙂", "https://ide.example.test/workspace/project");
    const overhead = Buffer.byteLength(normalizeDingTalkCardContent(anchor + suffix));
    for (const limit of [5999, 6000, 6001]) {
      const text = "x".repeat(limit - overhead) + suffix;
      const actual = normalizeDingTalkCardContent(anchor + text);
      assert.equal(Buffer.byteLength(actual), limit); assert.ok(actual.includes("中文🙂"));
      assert.equal(actual.split("[打开项目 Web IDE]").length - 1, 1);
      const completedCard = { messageId: "source", text, summary: "已检查" };
      assert.equal(adapter.client.canCombineCompletionMentionCard({ completedCard, mentions }), limit <= 6000);
      if (limit > 6000) await assert.rejects(adapter.client.sendMentionNotification({ toUserId: "group", text, completedCard, mentions }));
    }
  }
  assert.equal(writes, 0, "an oversized combination never starts a provider mutation");
});

test("native card @ preserves first participation order, escapes labels, and never trusts answer anchors", () => {
  const body = '正文 [链接](https://example.test)\n\n<a atId=outsider>other</a> <A ATID="123">fake</A>';
  const card = dingTalkMentionCard(body, [{ userId: "456", name: ' A<&"\nB ' }, { userId: "123", name: "第二人" },
    { userId: "456", name: "duplicate" }]);
  assert.equal(card.text, '<a atId=456>A&lt;&amp;&quot; B</a> <a atId=123>第二人</a>\n\n正文 [链接](https://example.test)\n\n'
    + '&lt;a atId=outsider&gt;other&lt;/a&gt; &lt;A ATID=&quot;123&quot;&gt;fake&lt;/A&gt;');
  assert.deepEqual(card.atUserIds, { "456": 'A<&" B', "123": "第二人" });
  const normalized = normalizeDingTalkCardContent(card.text);
  assert.equal(normalizeDingTalkCardContent(normalized), normalized);
  assert.equal((normalized.match(/<a atId=/g) ?? []).length, 2);
  assert.match(normalized, /\[链接\]\(https:\/\/example.test\)/);
  assert.deepEqual(dingTalkCardAtParameters({ type: "group" }, card.atUserIds), { cardAtUserIds: ["123", "456"], userIdType: 1 });
  assert.deepEqual(dingTalkCardAtParameters({ type: "user" }), {});
});

test("native card @ has bounded labels and rejects fake identities instead of guessing IDs", () => {
  const card = dingTalkMentionCard("body", [{ userId: "alice", name: "😀".repeat(100) }, { userId: "bob", name: " \n " }]);
  assert.equal(Array.from(card.atUserIds.alice).length, 80);
  assert.equal(card.atUserIds.bob, "参与者");
  for (const userId of ["@ALL", "all", "", "bad id", 'id>evil', 'id"', "名字"]) {
    assert.throws(() => dingTalkMentionCard("body", [{ userId }]), /Invalid DingTalk/);
  }
});

test("combined-card preflight counts normalized native markup, not just the original result bytes", async () => {
  let writes = 0;
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "test", clientId: "fake", clientSecret: "fake",
    cardTemplateId: "template", savedAt: "", enabled: true }, {
    cardClient: { async create() { writes++; }, async update() { writes++; } },
    streamClient: { async getAccessToken() { writes++; return "fake"; } } as never
  });
  const mentions = [{ userId: "alice", name: "Alice" }];
  const completedCard = { messageId: "original", text: "x".repeat(5990), summary: "summary" };
  assert.equal(adapter.client.canCombineCompletionMentionCard({ completedCard, mentions }), false);
  assert.equal(adapter.client.canCombineCompletionMentionCard({ completedCard: { ...completedCard, text: "short" }, mentions }), true);
  // Line breaks expand to <br> in this template and must also fit the budget.
  assert.equal(adapter.client.canCombineCompletionMentionCard({ completedCard: { ...completedCard, text: "x\n".repeat(1400) }, mentions }), false);
  await assert.rejects(adapter.client.sendMentionNotification({ toUserId: "group", text: completedCard.text, completedCard, mentions }), /Invalid completed card/);
  assert.equal(writes, 0, "budget selection is pure and happens before any transport write");
});
