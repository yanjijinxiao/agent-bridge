import assert from "node:assert/strict";
import test from "node:test";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";

for (const kind of ["text", "unsupported", "card", "menu"] as const)
  test(`Feishu ${kind} admission failure reaches the SDK rejection boundary before dispatch`, async t => {
    let dispatcher: any; let dispatched = 0, reported = 0;
    const adapter = new FeishuChannelAdapter({ channel: "feishu", accountId: "isolated", appId: "synthetic", appSecret: "synthetic" } as never, {
      apiClient: { im: { v1: { message: {} } } } as never,
      wsClient: { async start(input) { dispatcher = input.eventDispatcher; }, close() {} }
    });
    const stop = new AbortController();
    const monitor = adapter.monitor({ signal: stop.signal, claimMessage() { throw Error("disk full"); },
      async onMessage() { dispatched++; }, async onMessageError() { reported++; } });
    t.after(async () => { stop.abort(); await monitor; });
    await new Promise(resolve => setImmediate(resolve));
    const handler = kind === "card" ? "card.action.trigger" : kind === "menu" ? "application.bot.menu_v6" : "im.message.receive_v1";
    const event = kind === "card" ? { token: "isolated-callback", context: { open_message_id: "original-card", open_chat_id: "oc_room" },
      operator: { open_id: "ou_actor" }, action: { tag: "button", value: { version: 1, command: "sessions", arg: "" } } }
      : kind === "menu" ? { event_key: "codex.workbench", operator: { operator_id: { open_id: "ou_actor" } }, event_id: "isolated-menu" }
        : { sender: { sender_id: { open_id: "ou_actor" } }, message: { message_id: "source", chat_id: "oc_room", chat_type: "group",
          message_type: kind === "text" ? "text" : "other", content: JSON.stringify({ text: "original body" }) } };
    await assert.rejects(dispatcher.handles.get(handler)(event), /receipt unavailable/);
    assert.equal(dispatched, 0); assert.equal(reported, 1);
  });
