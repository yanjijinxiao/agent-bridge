import { z } from "zod";
import type { ChannelMessage } from "./message.js";

/** Account state is already namespaced by robot. This prefix is reserved at
 * ingress; only the binding resolver may manufacture a member address. */
const prefix = "im-member:v1:";
export const firstContactSchema = z.object({
  onUnbound: z.enum(["manual", "create"]),
  groupScope: z.enum(["conversation", "member"]),
  connector: z.string().trim().min(1).max(512).optional()
}).strict().refine(p => p.onUnbound !== "create" || Boolean(p.connector), "自动创建需要指定 Connector");
export type FirstContactPolicy = z.infer<typeof firstContactSchema>;

export function memberBinding(conversation: string, actor: string): string {
  return prefix + JSON.stringify([conversation, actor]);
}

export function bindingMember(address: string): { chat: string; actor: string } | undefined {
  if (!address.startsWith(prefix)) return;
  const parts: unknown = JSON.parse(address.slice(prefix.length));
  if (!Array.isArray(parts) || parts.length !== 2 || !parts.every(x => typeof x === "string" && x.length > 0)
    || parts.some(x => x.startsWith(prefix))) throw Error("Invalid personal session address");
  return { chat: parts[0], actor: parts[1] };
}

export function bindingRecipient(address: string): string {
  return bindingMember(address)?.chat ?? address;
}

/** Called once at trusted provider ingress, before the source receipt. The
 * inbox persists this decision even if the account policy changes on restart. */
export function addressInbound(message: ChannelMessage, policy?: FirstContactPolicy): ChannelMessage {
  const chat = message.replyTargetId ?? message.senderId;
  if (chat.startsWith(prefix) || message.senderId.startsWith(prefix)) throw Error("Reserved channel identity");
  if (policy?.groupScope === "member" && !message.conversationKind) throw Error("无法确认此消息来自群聊还是私聊，未选择会话");
  if (policy?.groupScope === "member" && message.conversationKind === "group") {
    if (!message.replyTargetId || !message.senderId || message.senderId === chat) throw Error("群消息缺少可核验的发送人");
    return { ...message, replyTargetId: memberBinding(chat, message.senderId) };
  }
  return message;
}
