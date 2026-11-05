import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readJsonFile } from "../state/json-store.js";
import { GatewayPeerServer } from "./transport.js";
import type { PeerRegistry } from "./registry.js";
import { SharedWorkspacePortal } from "./workspace-portal.js";
import { PeerCredentialStore } from "./credentials.js";
import { managedRouteSchema, validateManagedRoutes } from "./managed-route.js";

const listenSchema = z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().min(0).max(65535).default(9478),
  allowInsecureLan: z.boolean().default(false), tls: z.object({ keyFile: z.string(), certFile: z.string() }).optional(),
  enrollment: z.boolean().default(false),
  devices: z.array(z.object({ nodeId: z.string(), tokenFile: z.string() }).strict()).default([]) }).strict();
export function loadPeerListener(file: string | undefined) {
  if (!file) return undefined;
  const config = z.object({ listen: listenSchema, managedRoutes: z.array(managedRouteSchema).default([]), resources: z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().min(0).max(65535), publicOrigin: z.string().url(), allowInsecureLan: z.boolean().default(false), tls: z.object({ keyFile: z.string(), certFile: z.string() }).strict().optional() }).strict().optional() }).strict().parse(readJsonFile(file, null));
  validateManagedRoutes(config.managedRoutes);
  const resolve = (name: string) => path.resolve(path.dirname(file), name);
  const credentials: Record<string, string> = Object.create(null);
  for (const device of config.listen.devices) {
    if (Object.hasOwn(credentials, device.nodeId)) throw new Error("Duplicate peer node ID");
    credentials[device.nodeId] = fs.readFileSync(resolve(device.tokenFile), "utf8").trim();
  }
  if (config.managedRoutes.some(r => !Object.hasOwn(credentials, r.nodeId))) throw new Error("Managed Connector requires a statically provisioned device identity");
  return { ...config.listen, managedRoutes: config.managedRoutes, credentials, deviceStore: new PeerCredentialStore(file + ".devices.json"), resources: config.resources ? { ...config.resources, stateFile: file + ".resources.json", tls: config.resources.tls ? { key: fs.readFileSync(resolve(config.resources.tls.keyFile)), cert: fs.readFileSync(resolve(config.resources.tls.certFile)) } : undefined } : undefined, tls: config.listen.tls ? {
    key: fs.readFileSync(resolve(config.listen.tls.keyFile)), cert: fs.readFileSync(resolve(config.listen.tls.certFile)) } : undefined };
}
export async function listenSharedWorkspaces(options: ReturnType<typeof loadPeerListener>, registry: PeerRegistry): Promise<SharedWorkspacePortal | undefined> {
  if (!options?.resources) return;
  const server = new SharedWorkspacePortal(registry, options.resources); await server.listen(); return server;
}
export async function listenGatewayPeers(options: ReturnType<typeof loadPeerListener>, registry: PeerRegistry): Promise<GatewayPeerServer | undefined> {
  return options ? GatewayPeerServer.listen({ ...options, accept: (id, connection, enrollment) => registry.accept(id, connection, enrollment) }) : undefined;
}
