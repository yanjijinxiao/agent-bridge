import { z } from "zod";

const replySchema = z.object({ webhookUrl: z.string().max(4096), expiresAt: z.number().finite().positive(),
  conversationId: z.string().min(1).max(1000), conversationType: z.enum(["1", "2"]),
  actorId: z.string().min(1).max(1000), staffId: z.string().min(1).max(1000).optional(),
  robotCode: z.string().min(1).max(200), messageId: z.string().min(1).max(1000) }).strict();
const envelope = z.object({ kind: z.literal("dingtalk-reply-v1"), clientId: z.string().min(1).max(200), reply: replySchema }).strict();

function validWebhook(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "oapi.dingtalk.com" && !url.port && !url.username && !url.password
      && !url.hash && url.pathname === "/robot/sendBySession" && Boolean(url.searchParams.get("session")?.trim());
  } catch { return false; }
}

/** An opaque delivery credential in the existing private contextToken store.
 * Never put this in public card routing, model input, logs or knowledge. */
export function dingTalkReplyContext(clientId: string, reply: unknown, now: number): string | undefined {
  const parsed = envelope.safeParse({ kind: "dingtalk-reply-v1", clientId, reply });
  if (!parsed.success || parsed.data.reply.expiresAt <= now || !validWebhook(parsed.data.reply.webhookUrl)) return;
  const token = JSON.stringify(parsed.data);
  return token.length <= 8192 ? token : undefined;
}

export function readDingTalkReplyContext(token: string | undefined, clientId: string, recipientId: string, now: number) {
  if (!token || token.length > 8192) return;
  try {
    const parsed = envelope.safeParse(JSON.parse(token));
    if (!parsed.success || parsed.data.clientId !== clientId || parsed.data.reply.conversationId !== recipientId
      || parsed.data.reply.expiresAt <= now || !validWebhook(parsed.data.reply.webhookUrl)) return;
    return parsed.data.reply;
  } catch { return; }
}
