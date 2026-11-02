import { ChannelDeliveryError } from "./errors.js";

/** An upload's media_id is not a message acknowledgement. The websocket
 * command's successful, correlated req_id confirms platform acceptance. */
export function wecomMessageReceipt(result: unknown, operation: string): { messageId: string } {
  const value = result as { errcode?: unknown; headers?: { req_id?: unknown } } | null | undefined;
  const id = value?.headers?.req_id;
  if (value?.errcode !== 0 || typeof id !== "string" || !id.trim()) {
    throw new ChannelDeliveryError("wecom", operation, typeof value?.errcode === "number" ? value.errcode : undefined);
  }
  return { messageId: id };
}
