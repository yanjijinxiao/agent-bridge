import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { readBuildInfo } from "./build-info.js";

/** One inventory, independent compatibility domains. Product releases do not
 * change wire meaning; capabilities do not prove which artifact is running. */
export const CONTRACTS = Object.freeze({
  http: Object.freeze({ major: 1, minor: 0 }), peer: Object.freeze({ major: 1, minor: 0 }),
  execution: Object.freeze({ major: 1, minor: 0 }), nativeAdapter: Object.freeze({ major: 1, minor: 0 }),
  log: Object.freeze({ major: 1, minor: 0 })
} as const);
export const PEER_CAPABILITIES = Object.freeze({ writeGuard: 1, interactions: 1, nativeContract: 1,
  runtimeContract: 1, fullIDE: 1, files: 1, management: 1, sharing: 2 } as const);
export const PEER_PATH = `/gateway/v${CONTRACTS.peer.major}/peer`;
export const versionSchema = z.object({ major: z.number().int().positive(), minor: z.number().int().nonnegative() });
export const runtimeIdentitySchema = z.object({
  component: z.enum(["gateway", "connector"]), productVersion: z.string().min(1).max(80),
  build: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), builtAt: z.string().datetime({ offset: true }) }).nullable(),
  buildStatus: z.enum(["sealed", "unsealed"]), instanceId: z.string().uuid(), pid: z.number().int().positive(),
  startedAt: z.string().datetime(), contracts: z.object({ http: versionSchema, peer: versionSchema,
    execution: versionSchema, nativeAdapter: versionSchema, log: versionSchema })
}).refine(value => (value.buildStatus === "sealed") === (value.build !== null), "Build identity must match its status");
export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;
const identities = new Map<RuntimeIdentity["component"], RuntimeIdentity>();

function readProductVersion(): string {
  try { const value = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof value.version === "string" && /^[\w.+-]{1,80}$/.test(value.version) ? value.version : "unknown";
  } catch { return "unknown"; }
}

const installedBuild = readBuildInfo() ?? null;
const installedProductVersion = installedBuild?.productVersion ?? readProductVersion();
export function productVersion(): string { return installedProductVersion; }

/** Capture once: replacing files on disk cannot relabel the current process. */
export function runtimeIdentity(component: RuntimeIdentity["component"]): RuntimeIdentity {
  let identity = identities.get(component);
  if (!identity) {
    const build = installedBuild;
    identity = runtimeIdentitySchema.parse({ component, productVersion: productVersion(), build,
      buildStatus: build ? "sealed" : "unsealed", instanceId: crypto.randomUUID(), pid: process.pid,
      startedAt: new Date().toISOString(), contracts: CONTRACTS });
    identities.set(component, identity);
  }
  return structuredClone(identity);
}

export function incompatibleContract(local: RuntimeIdentity, remote: RuntimeIdentity): string | undefined {
  return (["peer", "execution"] as const).find(key => local.contracts[key].major !== remote.contracts[key].major);
}
