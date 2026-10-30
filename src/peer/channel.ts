import { z } from "zod";
import { createChannelClient, TEXT_CAPABILITIES } from "../channels/client.js";
import type { ChannelAdapter, ChannelReceipt, ChannelTextInput } from "../channels/types.js";
import { PeerConnection } from "./rpc.js";

/** A remote interactive client can be a channel, on either end of the socket.
 * Its actor/chat identity comes from local configuration, never message JSON. */
export function createPeerChannelAdapter(connection: PeerConnection, identity: { nodeId: string; actorId: string; conversationId: string }): ChannelAdapter {
  const client = createChannelClient("generic", TEXT_CAPABILITIES, {
    sendText: input => connection.request<ChannelReceipt>("conversation.output", input)
  });
  return { client, monitor: options => new Promise<void>(resolve => {
    const remove = connection.handle("conversation.input", async value => {
      const input = z.object({ id: z.string().min(1).max(200), text: z.string().max(500_000) }).strict().parse(value);
      const message = { id: `peer:${identity.nodeId}:${input.id}`, senderId: identity.actorId, replyTargetId: identity.conversationId,
        conversationKind: "direct" as const, text: input.text, attachments: [], raw: {} };
      if (options.claimMessage && !options.claimMessage(message)) return { accepted: false };
      try { await options.onMessage(message); return { accepted: true }; }
      catch (error) { await options.onMessageError?.(error, message); throw error; }
    });
    let detachClose = () => {};
    const close = () => { remove(); detachClose(); options.signal?.removeEventListener("abort", close); resolve(); };
    detachClose = connection.onClose(close);
    if (options.signal?.aborted || !connection.open) close();
    else options.signal?.addEventListener("abort", close, { once: true });
  }) };
}

export function attachPeerConversation(connection: PeerConnection, conversationId: string,
  output: (message: ChannelTextInput) => Promise<ChannelReceipt>) {
  const detach = connection.handle("conversation.output", value => {
    const message = z.object({ toUserId: z.literal(conversationId), text: z.string(), contextToken: z.string().optional() }).strict().parse(value);
    return output(message);
  });
  return { detach, send(id: string, text: string) { return connection.request<{ accepted: boolean }>("conversation.input", { id, text }, 24 * 60 * 60_000); } };
}
