import { readOutboundMedia } from "./outbound-media-file.js";
import path from "node:path";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { ChannelMediaInput } from "./types.js";
import { ChannelCapabilityError } from "./errors.js";
import { feishuMessageReceipt, feishuUploadKey, feishuRecipientType } from "./feishu-result.js";

export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;

export type FeishuMediaApi = {
  readonly image: Pick<Lark.Client["im"]["v1"]["image"], "create">;
  readonly file?: Pick<Lark.Client["im"]["v1"]["file"], "create">;
  readonly message: Pick<Lark.Client["im"]["v1"]["message"], "create">;
};

/** Upload is a resource receipt. Only message.create's message_id confirms
 * delivery. There is no retry or fallback send after an uncertain write. */
export class FeishuMediaSender {
  constructor(private readonly api: FeishuMediaApi) {}

  get filesAvailable(): boolean { return typeof this.api.file?.create === "function"; }

  async send(input: ChannelMediaInput): Promise<{ messageId: string }> {
    let key: string, msgType: "image" | "file" | "media";
    if (input.kind === "image") {
      const image = await readOutboundMedia(input.path, FEISHU_IMAGE_MAX_BYTES, "飞书");
      key = feishuUploadKey(await this.api.image.create({ data: { image_type: "message", image } }), "image");
      msgType = "image";
    } else if (input.kind === "file" || input.kind === "video") {
      if (!this.filesAvailable) throw new ChannelCapabilityError("feishu", `outbound.${input.kind}`, "not-implemented");
      if (input.kind === "video" && path.extname(input.path).toLowerCase() !== ".mp4") {
        throw new Error("飞书视频消息需要 MP4 文件；其他格式请作为文件发送。");
      }
      const file = await readOutboundMedia(input.path, FEISHU_FILE_MAX_BYTES, "飞书");
      key = feishuUploadKey(await this.api.file!.create({ data: {
        file_type: input.kind === "video" ? "mp4" : "stream",
        file_name: path.basename(input.path), file
      } }), "file");
      msgType = input.kind === "video" ? "media" : "file";
    } else {
      throw new ChannelCapabilityError("feishu", `outbound.${input.kind}`, "not-implemented");
    }
    const result = await this.api.message.create({
      params: { receive_id_type: feishuRecipientType(input.toUserId) },
      data: { receive_id: input.toUserId, msg_type: msgType,
        content: JSON.stringify(msgType === "image" ? { image_key: key } : { file_key: key }) }
    });
    return feishuMessageReceipt(result, `send${input.kind[0]!.toUpperCase()}${input.kind.slice(1)}`);
  }
}

