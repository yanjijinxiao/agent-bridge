import type { UnboundSessionPolicy } from "./contract.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PeerSharingPort } from "./sharing-types.js";

export type PeerPrincipal = { accountId: string; conversationId: string; actorId: string };
export const peerPrincipal = new AsyncLocalStorage<PeerPrincipal>();

export type PeerBridgePort = {
  isRouted?(hostId?: string): boolean;
  managedHosts?(): string[];
  isFirstContactOnly?(hostId: string): boolean;
  unboundSessionPolicy?(hostId: string): UnboundSessionPolicy | undefined;
  hasDeviceGrant?(principal: PeerPrincipal, hostId: string): boolean;
  supportsFirstContact?(hostId: string): boolean | undefined;
  connectorRoot?(hostId: string): string;
  catalogHosts?(hostId: string): string[];
  fullIDEAvailable?(principal: PeerPrincipal, target: { hostId: string; threadId: string }): boolean;
  sharing?: PeerSharingPort;
  connect(code: string, principal: PeerPrincipal, assertCurrent: () => void): Promise<{ hostId: string; threadId?: string; label: string }>;
  hosts(principal: PeerPrincipal): string[];
  label(hostId: string): string;
  isOnline?(hostId: string): boolean;
};

/** A missing registration is only evidence of an offline Connector for a known route. */
export function offlineConnectorLabel(peer: PeerBridgePort | undefined, hostId: string): string | undefined {
  if ((hostId.startsWith("peer:") || peer?.isRouted?.(hostId)) && peer?.isOnline?.(hostId) === false)
    return peer.label(hostId);
}
