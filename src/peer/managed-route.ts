import { z } from "zod";
import type { PeerPrincipal } from "./context.js";
import type { PeerGrant } from "./registry.js";

/** Deployment-owned identity, never learned from a remote registration. Logical
 * host IDs remain stable so old receipts, bindings and IDE scopes keep meaning. */
export const managedHostSchema = z.string().min(1).max(512).refine(v => v.trim() === v && !v.startsWith("peer:") && !/[\r\n\0]/.test(v));
export const managedExportSchema = z.object({ hostId: managedHostSchema, grantId: z.string().uuid() }).strict();
export const managedRouteSchema = managedExportSchema.extend({ nodeId: z.string().regex(/^[\w-]{1,80}$/), profileId: z.string().regex(/^[\w-]{1,80}$/) }).strict();
export type ManagedConnectorRoute = z.infer<typeof managedRouteSchema>;
export type ManagedConnectorExport = z.infer<typeof managedExportSchema>;
export const managedTarget = (route: ManagedConnectorRoute): string => `peer:${route.nodeId}:${route.profileId}`;
export const gatewayServicePrincipal: PeerPrincipal = { accountId: "gateway-service", conversationId: "gateway-service", actorId: "gateway-service" };

export function managedGrant(route: ManagedConnectorExport, principal = gatewayServicePrincipal): PeerGrant {
  return { id: route.grantId, hostId: route.hostId, principal, scope: "device" };
}

/** This delegation is configured at both ends by the host's administrator.
 * It trusts the authenticated Gateway's existing ACL; it is not device pairing
 * or a way to upgrade an ordinary visitor's independently owned Connector. */
export function matchesManagedGrant(route: ManagedConnectorExport | undefined, grant: PeerGrant): boolean {
  return !!route && grant.id === route.grantId && grant.hostId === route.hostId
    && grant.scope === "device" && !grant.threadId && !grant.delegation;
}

export function validateManagedRoutes(routes: readonly ManagedConnectorRoute[]): void {
  const hosts = new Set<string>(), targets = new Set<string>();
  for (const route of routes) {
    managedRouteSchema.parse(route);
    if (hosts.has(route.hostId) || targets.has(managedTarget(route))) throw new Error("Managed Connector routes must have unique hosts and targets");
    hosts.add(route.hostId); targets.add(managedTarget(route));
  }
}
