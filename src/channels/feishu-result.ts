import { ChannelDeliveryError } from "./errors.js";

/** Feishu's SDK can resolve HTTP 200 with a nonzero business code. */
export function assertFeishuSuccess(result: unknown, operation: string): void {
  if (!result || typeof result !== "object") throw new ChannelDeliveryError("feishu", operation);
  const code = (result as { code?: unknown }).code;
  if (code !== 0) throw new ChannelDeliveryError("feishu", operation, code === undefined ? undefined : String(code));
}

export function feishuMessageReceipt(result: unknown, operation: string): { messageId: string } {
  assertFeishuSuccess(result, operation);
  const id = (result as { data?: { message_id?: unknown } }).data?.message_id;
  if (typeof id !== "string" || !id.trim()) throw new ChannelDeliveryError("feishu", operation);
  return { messageId: id };
}

/** The installed SDK decodes uploads to a flat key; raw API responses keep
 * code/data. A nonzero business code always wins over any apparent key. */
export function feishuUploadKey(result: unknown, kind: "image" | "file"): string {
  const operation = kind === "image" ? "uploadImage" : "uploadFile";
  if (!result || typeof result !== "object") throw new ChannelDeliveryError("feishu", operation);
  const value = result as { code?: unknown; data?: Record<string, unknown> } & Record<string, unknown>;
  if (value.code !== undefined) assertFeishuSuccess(value, operation);
  const key = value.code === undefined ? value[`${kind}_key`] : value.data?.[`${kind}_key`];
  if (typeof key !== "string" || !key.trim()) throw new ChannelDeliveryError("feishu", operation);
  return key;
}

export function feishuRecipientType(recipientId: string): "chat_id" | "open_id" | "user_id" {
  if (recipientId.startsWith("oc_")) return "chat_id";
  if (recipientId.startsWith("ou_")) return "open_id";
  return "user_id";
}
