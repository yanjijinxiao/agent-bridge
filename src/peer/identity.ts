import crypto from "node:crypto";
import type { PeerPrincipal } from "./context.js";

export function peerOperationId(hostId: string, method: string, principal: PeerPrincipal | undefined, sourceId: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([hostId, method,
    principal?.accountId, principal?.conversationId, principal?.actorId, sourceId])).digest("hex");
}
