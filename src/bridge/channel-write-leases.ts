import type { ChannelClient } from "../channels/types.js";
import type { RestartWork } from "./restart-work.js";

const WRITE_METHODS = new Set<keyof ChannelClient>([
  "sendText", "sendMentionNotification", "sendProgressText", "startTextStream",
  "resumeTextStream", "updateTextStream", "sendActionCard", "updateActionCard",
  "sendTaskCard", "updateTaskCard", "sendMedia"
]);

/** Protect provider writes independently of a native execution's lifetime.
 * Capability/routing checks and inbound reads are not outgoing handoffs.
 * Typing is an ephemeral indicator, not a user message or result receipt.
 */
export function withChannelWriteLeases(client: ChannelClient, work: RestartWork): ChannelClient {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!methods.has(key)) methods.set(key, WRITE_METHODS.has(key as keyof ChannelClient)
        ? (...args: unknown[]) => work.run(async () => Reflect.apply(value, target, args))
        : value.bind(target));
      return methods.get(key);
    }
  });
}
