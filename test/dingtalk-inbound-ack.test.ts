import assert from "node:assert/strict";
import test from "node:test";
import type { DWClientDownStream } from "dingtalk-stream";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk.js";

for (const admission of ["saved", "duplicate", "disk-failure"] as const)
  test(`DingTalk source acknowledgement follows durable admission: ${admission}`, async t => {
    let listener!: (frame: DWClientDownStream) => void;
    const order: string[] = [], errors: unknown[] = [];
    const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "isolated", clientId: "robot",
      clientSecret: "synthetic", enabled: true, savedAt: "" }, {
      streamClient: {
        registerCallbackListener(_topic, handle) { listener = handle; }, async connect() {}, disconnect() {}, off() {},
        async getAccessToken() { return "synthetic"; }, socketCallBackResponse() { order.push("ack"); }
      }, emotionClient: { async reply() {}, async recall() {} }
    });
    const stop = new AbortController();
    const monitor = adapter.monitor({ signal: stop.signal,
      claimMessage() { order.push("claim"); if (admission === "disk-failure") throw Error("disk full"); return admission === "saved"; },
      async onMessage() { order.push("dispatch"); }, async onMessageError(error) { errors.push(error); }
    });
    t.after(async () => { stop.abort(); await monitor; });
    listener({ headers: { messageId: "frame" }, data: JSON.stringify({ msgId: "source", senderStaffId: "actor",
      conversationId: "room", conversationType: "2", sessionWebhook: "https://oapi.dingtalk.com/isolated",
      msgtype: "text", text: { content: "original body" } }) } as DWClientDownStream);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, admission === "saved" ? ["claim", "ack", "dispatch"]
      : admission === "duplicate" ? ["claim", "ack"] : ["claim"]);
    assert.equal(errors.length, admission === "disk-failure" ? 1 : 0);
  });
