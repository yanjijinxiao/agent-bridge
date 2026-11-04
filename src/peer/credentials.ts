import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { PeerPrincipal } from "./context.js";

export const deviceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const secretSchema = z.string().min(32).max(512).regex(/^[^\r\n]+$/);
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const ownerSchema = z.object({ accountId: z.string().min(1), actorId: z.string().min(1) }).strict();
const recordSchema = z.object({ nodeId: deviceIdSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  owner: ownerSchema, createdAt: z.number().int().positive() }).strict();

/** Only transport identity lives here. IM admission and session grants are
 * checked by the normal /connect path before a credential may be enrolled. */
export class PeerCredentialStore {
  private records: z.infer<typeof recordSchema>[];
  constructor(private readonly file: string) {
    this.records = z.object({ version: z.literal(1), devices: z.array(recordSchema).max(10_000)
      .refine(rows => new Set(rows.map(row => row.nodeId)).size === rows.length) }).strict()
      .parse(readJsonFile(file, { version: 1, devices: [] })).devices;
  }
  has(nodeId: string): boolean { return this.records.some(row => row.nodeId === nodeId); }
  matches(nodeId: string, secret: string): boolean {
    const row = this.records.find(row => row.nodeId === nodeId);
    return !!row && crypto.timingSafeEqual(Buffer.from(row.digest, "hex"), Buffer.from(digest(secret), "hex"));
  }
  enroll(nodeId: string, secret: string, principal: PeerPrincipal): void {
    deviceIdSchema.parse(nodeId); secretSchema.parse(secret);
    // Concurrent sockets must not replace an identity committed by another.
    if (this.has(nodeId) || this.records.length >= 10_000) throw new Error("Device is already registered or capacity reached");
    const row = recordSchema.parse({ nodeId, digest: digest(secret),
      owner: { accountId: principal.accountId, actorId: principal.actorId }, createdAt: Date.now() });
    const next = [...this.records, row];
    writeJsonFile(this.file, { version: 1, devices: next }, { durable: true }); this.records = next;
  }
}

/** Called under the Connector state-directory lock. A corrupt or differently
 * scoped identity fails closed; silently regenerating it would lose grants. */
export function loadPeerIdentity(stateDir: string, url: string): { nodeId: string; token: string } {
  const gateway = new URL(url).href, file = path.join(stateDir, "device-identity.json");
  const schema = z.object({ version: z.literal(1), gateway: z.string(), nodeId: deviceIdSchema, token: secretSchema }).strict();
  const saved = readJsonFile<unknown>(file, undefined);
  if (saved !== undefined) {
    const identity = schema.parse(saved);
    if (identity.gateway !== gateway) throw new Error("Device identity belongs to another Gateway; select a separate stateDir");
    return { nodeId: identity.nodeId, token: identity.token };
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const identity = { version: 1, gateway, nodeId: `device-${crypto.randomUUID()}`, token: crypto.randomBytes(32).toString("hex") };
  writeJsonFile(file, identity, { durable: true });
  return { nodeId: identity.nodeId, token: identity.token };
}

export type PeerEnrollment = { commit(principal: PeerPrincipal): void };
