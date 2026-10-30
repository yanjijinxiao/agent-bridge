import { AsyncLocalStorage } from "node:async_hooks";

export type PeerPrincipal = { accountId: string; conversationId: string; actorId: string };
export const peerPrincipal = new AsyncLocalStorage<PeerPrincipal>();

export type PeerBridgePort = {
  connect(code: string, principal: PeerPrincipal, assertCurrent: () => void): Promise<{ hostId: string; threadId?: string; label: string }>;
  hosts(principal: PeerPrincipal): string[];
  label(hostId: string): string;
};
