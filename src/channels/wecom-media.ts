import path from "node:path";
import type AiBot from "@wecom/aibot-node-sdk";
import { ChannelCapabilityError, ChannelDeliveryError } from "./errors.js";
import { readOutboundMedia } from "./outbound-media-file.js";
import { wecomMessageReceipt } from "./wecom-result.js";
import type { ChannelMediaInput } from "./types.js";

// The installed native SDK's upload protocol allows at most 100 × 512 KiB.
export const WECOM_MEDIA_MAX_BYTES = 100 * 512 * 1024;
type WeComMediaApi = Partial<Pick<InstanceType<typeof AiBot.WSClient>, "uploadMedia" | "sendMediaMessage">>;

export class WeComMediaSender {
  constructor(private readonly api: WeComMediaApi) {}
  get available(): boolean { return typeof this.api.uploadMedia === "function" && typeof this.api.sendMediaMessage === "function"; }

  async send(input: ChannelMediaInput): Promise<{ messageId: string }> {
    if (!this.available || !["image", "file", "video"].includes(input.kind)) {
      throw new ChannelCapabilityError("wecom", `outbound.${input.kind}`, "not-implemented");
    }
    const type = input.kind as "image" | "file" | "video";
    const bytes = await readOutboundMedia(input.path, WECOM_MEDIA_MAX_BYTES, "企业微信");
    const upload = await this.api.uploadMedia!(bytes, { type, filename: path.basename(input.path) });
    if ((upload as { errcode?: unknown } | undefined)?.errcode !== undefined
      && (upload as { errcode?: unknown }).errcode !== 0) {
      const code = (upload as { errcode?: unknown }).errcode;
      throw new ChannelDeliveryError("wecom", "uploadMedia", typeof code === "number" ? code : undefined);
    }
    if (!upload || upload.type !== type || typeof upload.media_id !== "string" || !upload.media_id.trim()) {
      throw new ChannelDeliveryError("wecom", "uploadMedia");
    }
    return wecomMessageReceipt(await this.api.sendMediaMessage!(input.toUserId, type, upload.media_id), `send${type}`);
  }
}
