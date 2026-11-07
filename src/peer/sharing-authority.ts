import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { CodexBridgeBackend } from "../codex/backend.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { PeerPrincipal } from "./context.js";
import { PeerError } from "./rpc.js";
import { peerGrantSchema, sharingPrincipalSchema, sharedPermissionSchema, samePerson, sameChatPerson, type SharedPeerGrant, type SharedPermission } from "./sharing-types.js";
import { SharedWorkspaceHost } from "./shared-workspace.js";
import { SessionControlQueue } from "../bridge/session-control.js";
import { scriptHostResolver, type ScriptHost } from "../hosts/script-host.js";

const rootSchema = z.object({ path: z.string(), dev: z.number(), ino: z.number() }).strict();
const resourceSchema = z.object({ id: z.string().uuid(), hostId: z.string(), threadId: z.string(), owner: sharingPrincipalSchema, cwd: z.string(), root: rootSchema, directory: rootSchema.optional(), filesystemHost: z.string().optional() }).strict();
const inviteSchema = z.object({ hash: z.string(), resourceId: z.string().uuid(), expiresAt: z.number() }).strict();
const requestSchema = z.object({ id: z.string().uuid(), resourceId: z.string().uuid(), principal: sharingPrincipalSchema, createdAt: z.number(), status: z.enum(["pending", "approved", "denied"]), grantId: z.string().uuid().optional() }).strict();
const storeSchema = z.object({ version: z.literal(1), resources: z.array(resourceSchema), invites: z.array(inviteSchema), requests: z.array(requestSchema), grants: z.array(peerGrantSchema) }).strict();
export type OwnerConfirmation = { principal: PeerPrincipal; threadId: string; workspace?: string };
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const unavailable = () => new PeerError("access", "资源未授权、已撤销、已过期或目录已改变。");

/** The device is the durable authority. IM roles cannot mint ownership. */
export class PeerSharingAuthority {
  private data: z.infer<typeof storeSchema>;
  private readonly claims = new SessionControlQueue();
  constructor(private readonly file: string, private readonly backend: Pick<CodexBridgeBackend, "inspectThread">,
    private readonly confirm: (input: OwnerConfirmation) => Promise<boolean>, private readonly now = Date.now,
    private readonly workspace = new SharedWorkspaceHost(),
    private readonly fileHost?: (threadId: string) => Promise<ScriptHost | undefined>) {
    this.data = storeSchema.parse(readJsonFile(file, { version: 1, resources: [], invites: [], requests: [], grants: [] }));
  }
  private save(next: typeof this.data): void { writeJsonFile(this.file, next, { durable: true }); this.data = next; }
  private resource(id: string) { const r = this.data.resources.find(r => r.id === id); if (!r) throw unavailable(); return r; }
  private current(grant: SharedPeerGrant): void {
    const stored = this.data.grants.find(g => g.id === grant.id);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(grant) || !grant.delegation || grant.delegation.version !== 2 || grant.delegation.expiresAt <= this.now()) throw unavailable();
    const r = this.resource(grant.delegation.resourceId);
    if (r.threadId !== grant.threadId || r.hostId !== grant.hostId) throw unavailable();
  }
  valid(grant: SharedPeerGrant): boolean { try { this.current(grant); return true; } catch { return false; } }
  hasResources(): boolean { return this.data.resources.length > 0; }
  private async workspaceFor(threadId: string, resource?: z.infer<typeof resourceSchema>) {
    const host = await this.fileHost?.(threadId);
    if (resource && resource.filesystemHost !== host?.id) throw unavailable();
    return { hostId: host?.id, workspace: host ? new SharedWorkspaceHost(host.id, undefined, scriptHostResolver(host)) : this.workspace };
  }
  private async state(r: z.infer<typeof resourceSchema>) {
    const state = await this.inspect(r.threadId);
    const { workspace } = await this.workspaceFor(r.threadId, r);
    if (state.threadId !== r.threadId || state.internal || !["active", "archived"].includes(state.persistence) || !state.cwd || JSON.stringify(await workspace.directory(state.cwd)) !== JSON.stringify(r.root)) throw unavailable();
    return state;
  }
  private async inspect(threadId: string) {
    const state = await this.backend.inspectThread(threadId, undefined, { includeTurns: false, timeoutMs: 5000 });
    if (state.resource?.machine && !await this.fileHost?.(threadId)) throw new PeerError("scope", "远端资源不能授权本机同名目录。");
    return state;
  }
  assert(grant: SharedPeerGrant, method: string, args: unknown[]): void {
    const first = args[0] as any;
    const thread = ["listSkills", "warmUp"].includes(method) ? grant.threadId : method === "getRuntimeInfo" ? args[1] : typeof first === "string" ? first : first?.threadId;
    if (!grant.delegation) {
      const owned = this.data.resources.find(r => r.hostId === grant.hostId && r.threadId === thread);
      if (owned && !samePerson(owned.owner, grant.principal)) throw unavailable();
      return;
    }
    this.current(grant);
    const permissions = grant.delegation.permissions;
    // Identity, resource scope, expiry and revocation are owned here. Session
    // roles and operation approval remain the Gateway's existing policy.
    const permission = method.startsWith("fileDownload") ? "files"
      : method === "workspace.write" ? "ide-write" : method.startsWith("workspace.") ? "ide-read" : undefined;
    if (permission && !permissions.includes(permission)
      || ["createThread", "deleteThread", "runtimeLifecycle", "getAccountRateLimits", "receipt", "listModels"].includes(method)) throw unavailable();
    if (thread && thread !== grant.threadId) throw unavailable();
  }
  visible(grant: SharedPeerGrant, threadId: string): boolean {
    try { this.assert(grant, "inspectThread", [threadId]); return true; } catch {
      return !grant.delegation && this.data.grants.some(g => g.threadId === threadId && g.hostId === grant.hostId && sameChatPerson(g.principal, grant.principal)
        && this.valid(g));
    }
  }
  async verify(grant: SharedPeerGrant, method: string, args: unknown[]): Promise<void> {
    this.assert(grant, method, args);
    if (grant.delegation) { await this.state(this.resource(grant.delegation.resourceId)); this.assert(grant, method, args); }
  }
  catalog(grant: SharedPeerGrant) {
    this.current(grant);
    return this.data.grants.filter(g => sameChatPerson(g.principal, grant.principal) && this.valid(g));
  }
  async call(method: string, raw: unknown, grant: SharedPeerGrant | undefined, live: () => void, serialized = false): Promise<any> {
    const input = z.object({ threadId: z.string().min(1).optional(), hostId: z.string().optional(), code: z.string().max(100).optional(),
      principal: sharingPrincipalSchema.optional(), workspace: z.boolean().optional(), resourceId: z.string().uuid().optional(), id: z.string().uuid().optional(), hours: z.number().int().min(1).max(168).optional(),
      permissions: z.array(sharedPermissionSchema).max(3).optional(), path: z.string().max(4096).optional(), text: z.string().max(384 * 1024).optional(), hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(raw);
    if (method === "claim" && !serialized) return this.claims.run(`${grant?.hostId}:${input.threadId ?? grant?.threadId}`, () => this.call(method, raw, grant, live, true));
    if (method === "request") {
      if (!input.code || !input.principal) throw unavailable();
      const invite = this.data.invites.find(i => i.hash === hash(input.code!) && i.expiresAt > this.now());
      if (!invite) throw unavailable();
      const resource = this.resource(invite.resourceId); await this.state(resource); live();
      const prior = this.data.requests.find(r => r.resourceId === resource.id && sameChatPerson(r.principal, input.principal!));
      const priorGrant = prior?.grantId ? this.data.grants.find(g => g.id === prior.grantId && this.valid(g)) : undefined;
      if (prior && (prior.status !== "approved" || priorGrant)) return { request: prior, grant: priorGrant };
      if (this.data.requests.filter(r => r.status === "pending").length >= 100) throw new PeerError("busy", "待批准申请过多。");
      const request = { id: crypto.randomUUID(), resourceId: resource.id, principal: input.principal, createdAt: this.now(), status: "pending" as const };
      this.save({ ...this.data, requests: [...this.data.requests.filter(r => r !== prior), request] }); return { request };
    }
    if (!grant || input.principal || input.hostId && input.hostId !== grant.hostId) throw unavailable();
    if (method.startsWith("workspace.")) {
      if (!grant.delegation) {
        const r = this.data.resources.find(r => r.hostId === grant.hostId && r.threadId === input.threadId && samePerson(r.owner, grant.principal));
        if (!r?.directory || input.resourceId && input.resourceId !== r.id) throw unavailable(); await this.state(r); live(); if (!this.data.resources.includes(r)) throw unavailable();
        return (await this.workspaceFor(r.threadId, r)).workspace.workspace(r.directory, method, { path: input.path ?? "", text: input.text, hash: input.hash }, live);
      }
      await this.verify(grant, method, [input]); const r = this.resource(grant.delegation.resourceId);
      if (!r.directory || input.resourceId && input.resourceId !== r.id) throw unavailable();
      return (await this.workspaceFor(r.threadId, r)).workspace.workspace(r.directory, method, { path: input.path ?? "", text: input.text, hash: input.hash }, () => { live(); this.assert(grant, method, [input]); });
    }
    if (grant.delegation) throw unavailable(); // Delegation never includes re-sharing or ownership.
    const threadId = input.threadId ?? grant.threadId;
    if (!threadId || grant.threadId && threadId !== grant.threadId) throw unavailable();
    let r = this.data.resources.find(r => r.threadId === threadId && r.hostId === grant.hostId);
    if (method === "claim") {
      const state = await this.inspect(threadId);
      if (state.threadId !== threadId || state.internal || state.persistence !== "active" || !state.cwd || !path.isAbsolute(state.cwd)) throw unavailable();
      const { workspace, hostId: filesystemHost } = await this.workspaceFor(threadId);
      const root = await workspace.directory(state.cwd), cwd = root.path, directory = input.workspace ? root : undefined;
      if (r && r.filesystemHost === filesystemHost && samePerson(r.owner, grant.principal) && r.cwd === cwd && JSON.stringify(r.root) === JSON.stringify(root) && (!input.workspace || r.directory && JSON.stringify(r.directory) === JSON.stringify(directory))) return { resource: r };
      if (!await this.confirm({ principal: grant.principal, threadId, workspace: directory?.path })) throw new PeerError("declined", "本机未确认所有权。");
      live(); const again = await this.inspect(threadId); live();
      if (again.persistence !== "active" || again.internal || !again.cwd || (await this.workspaceFor(threadId)).hostId !== filesystemHost
        || JSON.stringify(await workspace.directory(again.cwd)) !== JSON.stringify(root)) throw unavailable();
      const resource = { id: crypto.randomUUID(), hostId: grant.hostId, threadId, owner: grant.principal, cwd, root, directory, ...(filesystemHost ? { filesystemHost } : {}) };
      this.save({ ...this.data, resources: [...this.data.resources.filter(x => x !== r), resource],
        invites: this.data.invites.filter(i => i.resourceId !== r?.id), requests: this.data.requests.filter(i => i.resourceId !== r?.id), grants: this.data.grants.filter(g => g.delegation?.resourceId !== r?.id) });
      return { resource };
    }
    if (!r || !samePerson(r.owner, grant.principal)) throw unavailable();
    await this.state(r); live(); if (!this.data.resources.includes(r)) throw unavailable();
    if (method === "status") return { resource: r, requests: this.data.requests.filter(q => q.resourceId === r!.id && q.status === "pending"), grants: this.data.grants.filter(g => g.delegation?.resourceId === r!.id && this.valid(g)) };
    if (method === "invite") {
      const code = `SH-${crypto.randomBytes(16).toString("hex").toUpperCase()}`, expiresAt = this.now() + (input.hours ?? 24) * 3600_000;
      this.save({ ...this.data, invites: [...this.data.invites.filter(i => i.expiresAt > this.now()).slice(-99), { hash: hash(code), resourceId: r.id, expiresAt }] });
      return { code, expiresAt, resourceId: r.id };
    }
    if (method === "revoke") {
      const found = this.data.grants.find(g => g.id === input.id && g.delegation?.resourceId === r!.id); if (!found) throw unavailable();
      this.save({ ...this.data, grants: this.data.grants.filter(g => g !== found), requests: this.data.requests.filter(q => q.grantId !== found.id) }); return { revoked: [found.id] };
    }
    const request = this.data.requests.find(q => q.id === input.id && q.resourceId === r!.id && q.status === "pending"); if (!request) throw unavailable();
    if (method === "deny") {
      this.save({ ...this.data, requests: this.data.requests.map(q => q === request ? { ...q, status: "denied" } : q) }); return { denied: request.id };
    }
    if (method !== "approve") throw unavailable();
    const permissions: SharedPermission[] = [...new Set(input.permissions ?? [])];
    if (permissions.some(p => p.startsWith("ide-")) && !r.directory) throw new PeerError("workspace", "请先通过 /share claim --ide 在本机确认共享目录。");
    if (permissions.includes("ide-write") && !permissions.includes("ide-read")) permissions.push("ide-read");
    const delegated = peerGrantSchema.parse({ id: crypto.randomUUID(), hostId: r.hostId, threadId, principal: request.principal,
      delegation: { version: 2, resourceId: r.id, permissions, expiresAt: this.now() + (input.hours ?? 24) * 3600_000 } });
    this.save({ ...this.data, grants: [...this.data.grants, delegated], requests: this.data.requests.map(q => q === request ? { ...q, status: "approved", grantId: delegated.id } : q) });
    return { grant: delegated };
  }
}
