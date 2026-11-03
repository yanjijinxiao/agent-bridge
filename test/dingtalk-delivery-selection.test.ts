import assert from "node:assert/strict";
import test from "node:test";
import type { DWClientDownStream } from "dingtalk-stream";
import { DingTalkChannelAdapter, DingTalkHttpsAICardClient } from "../src/channels/dingtalk.js";
import { createChoiceCard } from "../src/channels/action-card.js";

function fixture(t: test.TestContext, cardClient: NonNullable<ConstructorParameters<typeof DingTalkChannelAdapter>[1]>["cardClient"], conversationType = "2") {
  let listener!: (frame: DWClientDownStream) => void;
  const webhooks: string[] = [];
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "isolated", clientId: "robot",
    clientSecret: "synthetic", cardTemplateId: "template", enabled: true, savedAt: "" }, {
    cardClient, emotionClient: { async reply() {}, async recall() {} },
    streamClient: {
      registerCallbackListener(_topic, handle) { listener = handle; }, async connect() {}, disconnect() {}, off() {},
      async getAccessToken() { return "synthetic"; }, socketCallBackResponse() {}
    },
    async webhookSender(input) { webhooks.push(input.text); return { messageId: "unexpected-fallback" }; }
  });
  const stop = new AbortController();
  const monitor = adapter.monitor({ signal: stop.signal, async onMessage() {} });
  t.after(async () => { stop.abort(); await monitor; });
  listener({ headers: { messageId: "frame" }, data: JSON.stringify({ msgId: "source", senderStaffId: "actor",
    conversationId: "room", conversationType, sessionWebhook: "https://oapi.dingtalk.com/isolated",
    msgtype: "text", text: { content: "original body" } }) } as DWClientDownStream);
  return { adapter, webhooks };
}

for (const operation of ["text", "action"] as const) for (const failure of ["rejected", "unknown"] as const) {
  test(`static DingTalk ${operation} creation ${failure} does not change the selected transport`, async t => {
    const writes: string[] = [];
    const cardClient = new DingTalkHttpsAICardClient(async url => {
      writes.push(new URL(url).pathname);
      return failure === "rejected"
        ? new Response(JSON.stringify({ success: false, code: "InvalidTemplate" }), { status: 400 })
        : new Response("{}", { status: 200 });
    });
    const { adapter, webhooks } = fixture(t, cardClient);
    await assert.rejects(operation === "text" ? adapter.client.sendText({ toUserId: "room", text: "answer" })
      : adapter.client.sendActionCard({ toUserId: "room", card: createChoiceCard({ title: "Question", body: "Answer?",
        fallbackText: "Question: Answer?", choices: [] }) }));
    assert.deepEqual(writes, ["/v1.0/card/instances"]);
    assert.deepEqual(webhooks, []);
  });
}

for (const kind of ["unknown", ""] as const) {
  test(`DingTalk stream does not infer a private recipient from unconfirmed type ${JSON.stringify(kind)}`, async t => {
    let creates = 0;
    const { adapter } = fixture(t, { async create() { creates++; }, async update() {} }, kind);
    assert.equal(adapter.client.deliveryRouteStatus("room"), "unconfirmed");
    await assert.rejects(adapter.client.startTextStream({ toUserId: "room", text: "progress" }));
    assert.equal(creates, 0);
  });
}
