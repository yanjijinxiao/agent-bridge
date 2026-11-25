import { bindingRecipient } from "./conversation-binding.js";
import type { ChannelClient } from "./types.js";
import type { ChannelMessage } from "./message.js";
import type { ChannelStreamStartInput } from "./stream-bootstrap.js";

/** Binding addresses may be persisted in receipts and subscriptions. Only the
 * actual provider conversation is ever passed to a transport or media lookup. */
export function withBindingDelivery(client: ChannelClient): ChannelClient {
  function deliver<T extends { toUserId: string }>(input: T): T {
    return { ...input, toUserId: bindingRecipient(input.toUserId) };
  }
  function source(message: ChannelMessage): ChannelMessage {
    return { ...message, senderId: bindingRecipient(message.senderId),
      ...(message.replyTargetId && { replyTargetId: bindingRecipient(message.replyTargetId) }) };
  }
  function stream(input: ChannelStreamStartInput): ChannelStreamStartInput {
    const provider = bindingRecipient(input.toUserId);
    if (provider === input.toUserId) return input;
    // The provider proves a delivery to the group. The presentation journal
    // also binds that receipt to this member, including continuation pages.
    return { ...input, toUserId: provider, ...(input.onBootstrap && { onBootstrap(state) {
      if (state.recipientId !== provider) throw Error("Stream provider recipient mismatch");
      input.onBootstrap!({ ...state, recipientId: input.toUserId });
    } }) };
  }
  return {
    channel: client.channel, capabilities: client.capabilities, resumableTextStream: client.resumableTextStream,
    measureTerminalText: text => client.measureTerminalText(text),
    canCombineCompletionMentionCard: input => client.canCombineCompletionMentionCard(input),
    updateActionCard: input => client.updateActionCard(input),
    updateTaskCard: input => client.updateTaskCard(input),
    conversationIdentity: id => client.conversationIdentity(bindingRecipient(id)),
    deliveryRouteStatus: id => client.deliveryRouteStatus(bindingRecipient(id)),
    sendText: input => client.sendText(deliver(input)),
    sendMedia: input => client.sendMedia(deliver(input)),
    sendTyping: input => client.sendTyping(deliver(input)),
    sendActionCard: input => client.sendActionCard(deliver(input)),
    sendTaskCard: input => client.sendTaskCard(deliver(input)),
    sendMentionNotification: input => client.sendMentionNotification(deliver(input)),
    sendProgressText: input => client.sendProgressText(deliver(input)),
    startTextStream: input => client.startTextStream(stream(input)),
    resumeTextStream(input) {
      if (input.bootstrap.recipientId !== input.toUserId) throw Error("Stream binding recipient mismatch");
      const provider = stream(input);
      return client.resumeTextStream({ ...input, ...provider, bootstrap: { ...input.bootstrap, recipientId: provider.toUserId } });
    },
    updateTextStream: input => client.updateTextStream(deliver(input)),
    resolveAttachments: message => client.resolveAttachments(source(message)),
    async resolveReferences(message) {
      const resolved = await client.resolveReferences(source(message));
      return { ...resolved, senderId: message.senderId, replyTargetId: message.replyTargetId };
    }
  };
}
