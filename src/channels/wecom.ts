import AiBot, { type BaseMessage, type WsFrame } from "@wecom/aibot-node-sdk";

import type { WeComAccount } from "../weixin/accounts.js";
import type { ChannelMessage } from "./message.js";
import type { ChannelAdapter, ChannelClient, ChannelMonitorOptions, ChannelTextClient } from "./types.js";
import { createChannelClient, TEXT_CAPABILITIES, NO_MEDIA } from "./client.js";
import { WeComMediaSender } from "./wecom-media.js";
import { wecomMessageReceipt } from "./wecom-result.js";
import { isDirectedMentionId } from "./mentions.js";
import { decodeWeComContent, decodeWeComQuote, resolveWeComAttachments } from "./wecom-inbound.js";

export class WeComChannelAdapter implements ChannelAdapter, ChannelTextClient {
  readonly client: ChannelClient;
  private readonly wsClient: InstanceType<typeof AiBot.WSClient>;
  private readonly mediaSender: WeComMediaSender;

  constructor(account: WeComAccount, private readonly options: { wsClient?: InstanceType<typeof AiBot.WSClient>;
    inboundDir?: string; maxInboundBytes?: number; fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.wsClient = options.wsClient ?? new AiBot.WSClient({ botId: account.botId, secret: account.secret });
    this.mediaSender = new WeComMediaSender(this.wsClient);
    const media = this.mediaSender.available ? "available" : "not-implemented";
    const inbound = options.inboundDir ? "available" : "not-configured";
    this.client = createChannelClient("wecom", { ...TEXT_CAPABILITIES, mentions: "not-implemented",
      inbound: { ...NO_MEDIA, image: inbound, file: inbound, video: inbound },
      outbound: { ...NO_MEDIA, image: media, file: media, video: media } }, this);
  }

  resolveAttachments(message: ChannelMessage): Promise<ChannelMessage["attachments"]> {
    return resolveWeComAttachments(message, this.options);
  }

  async sendText(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
    const response = await this.wsClient.sendMessage(input.toUserId, {
      msgtype: "markdown",
      markdown: { content: input.text }
    });
    return wecomMessageReceipt(response, "sendText");
  }

  async sendMedia(input: import("./types.js").ChannelMediaInput): Promise<{ messageId: string }> {
    return this.mediaSender.send(input);
  }

  async monitor(options: ChannelMonitorOptions): Promise<void> {
    if (options.signal?.aborted) return;
    options.onStatus?.({ state: "connecting" });
    const handle = (frame: WsFrame<BaseMessage>) => {
      const body = frame.body;
      if (!body) return;
      const message: ChannelMessage = { id: typeof body.msgid === "string" ? body.msgid : "",
        senderId: typeof body.from?.userid === "string" ? body.from.userid : "",
        replyTargetId: body.chattype === "single" ? body.from?.userid
          : typeof body.chatid === "string" ? body.chatid : body.from?.userid,
        ...(body.chattype === "group" ? { conversationKind: "group" as const,
          ...(typeof body.from?.userid === "string" && isDirectedMentionId(body.from.userid) ? { mention: { userId: body.from.userid } } : {}) }
          : body.chattype === "single" ? { conversationKind: "direct" as const } : {}),
        text: "", attachments: [], raw: { channel: "wecom", event: body } };
      // The SDK catches synchronous listener exceptions. Put decoding and
      // durable admission inside our own promise so failure reaches Gateway.
      void Promise.resolve().then(async () => {
        if (options.signal?.aborted) return;
        if (!message.id || !message.senderId
          || body.chattype === "group" && (typeof body.chatid !== "string" || !body.chatid.trim()))
          throw new Error("企业微信消息格式无效，未提交。");
        Object.assign(message, decodeWeComContent(body));
        message.references = decodeWeComQuote(body.quote);
        if (options.claimMessage && !options.claimMessage(message)) return;
        await options.onMessage(message);
      }).catch(async (error) => {
        try {
          await options.onMessageError?.(error, message);
        } catch (reportError) {
          console.error("[codex-im-gateway] failed to report WeCom message error");
        }
      });
    };
    const connected = () => options.onStatus?.({ state: "connected" });
    const reconnecting = () => options.onStatus?.({ state: "reconnecting" });
    const error = () => options.onStatus?.({ state: "reconnecting", detail: "WebSocket connection failed" });
    const events = ["message.text", "message.image", "message.mixed", "message.file", "message.video", "message.voice"] as const;
    for (const event of events) this.wsClient.on(event, handle);
    this.wsClient.on("authenticated", connected);
    this.wsClient.on("disconnected", reconnecting);
    this.wsClient.on("reconnecting", reconnecting);
    this.wsClient.on("error", error);
    try {
      this.wsClient.connect();
      await untilAborted(options.signal);
    } finally {
      for (const event of events) this.wsClient.off(event, handle);
      this.wsClient.off("authenticated", connected);
      this.wsClient.off("disconnected", reconnecting);
      this.wsClient.off("reconnecting", reconnecting);
      this.wsClient.off("error", error);
      this.wsClient.disconnect();
      options.onStatus?.({ state: "stopped" });
    }
  }
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}
