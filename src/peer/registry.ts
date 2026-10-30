import crypto from "node:crypto";
import { z } from "zod";
import type { CodexBackendCapabilities, CodexThreadState, CodexBackendId } from "../codex/backend.js";
import { EXEC_BACKEND_CAPABILITIES } from "../codex/backend.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { peerPrincipal, type PeerBridgePort, type PeerPrincipal } from "./context.js";
import { PeerConnection, PeerConnectionError, PeerError } from "./rpc.js";

const principalSchema = z.object({ accountId: z.string().min(1).max(512), conversationId: z.string().min(1).max(512), actorId: z.string().min(1).max(512) }).strict();
export const grantSchema = z.object({ id: z.string().uuid(), principal: principalSchema, hostId: z.string(),
  threadId: z.string().min(1).optional(), scope: z.literal("device").optional() }).strict()
  .refine(grant => grant.scope === "device" ? grant.threadId === undefined : grant.threadId !== undefined, "Explicit device or session scope required");
export type PeerGrant = z.infer<typeof grantSchema>;
const descriptionSchema = z.object({ profileId: z.string().regex(/^[\w-]{1,80}$/),
  thread: z.object({ threadId: z.string().min(1), cwd: z.string().min(1), title: z.string().optional(),
    persistence: z.enum(["active", "archived"]), internal: z.literal(false).optional() }).passthrough().optional(),
  label: z.string().min(1).max(80).optional(),
  files: z.object({ version: z.literal(1) }).strict().optional(),
  management: z.object({ version: z.literal(1) }).strict().optional(),
  info: z.object({ id: z.enum(["exec", "app-server"]), capabilities: z.record(z.string(), z.boolean()) }),
  independent: z.boolean() }).strict();
export type PeerDescription = { profileId: string; label?: string; files?: { version: 1 }; management?: { version: 1 }; thread?: CodexThreadState & { cwd: string };
  info: { id: CodexBackendId; capabilities: CodexBackendCapabilities }; independent: boolean };
type Host = { nodeId: string; description: PeerDescription; connection?: PeerConnection };
const samePrincipal = (a: PeerPrincipal, b: PeerPrincipal) => a.accountId === b.accountId && a.conversationId === b.conversationId && a.actorId === b.actorId;

/** Device authentication does not grant every bot participant session access. */
export class PeerRegistry implements PeerBridgePort {
  private readonly entries = new Map<string, Host>();
  private grants: PeerGrant[];
  private readonly tickets = new Map<string, { hostId: string; connection: PeerConnection; expiresAt: number }>();
  private readonly callbacks = new WeakMap<PeerConnection, Map<string, (name: string, args: unknown[]) => Promise<unknown>>>();
  constructor(private readonly stateFile: string) {
    this.grants = z.object({ version: z.literal(1), grants: z.array(grantSchema) })
      .parse(readJsonFile(stateFile, { version: 1, grants: [] })).grants;
  }
  accept(nodeId: string, connection: PeerConnection): void {
    const callbacks = new Map<string, (name: string, args: unknown[]) => Promise<unknown>>();
    this.callbacks.set(connection, callbacks);
    let registered = false;
    connection.handle("execution.callback", async params => {
      const { operationId, name, args } = z.object({ operationId: z.string(), name: z.string(), args: z.array(z.unknown()) }).strict().parse(params);
      const callback = callbacks.get(operationId);
      if (!callback) throw new PeerError("stale", "The originating request is no longer active");
      return callback(name, args);
    });
    connection.handle("peer.register", params => {
      if (registered) throw new PeerError("duplicate", "This connection has already registered");
      const raw = descriptionSchema.parse(params);
      const capabilities = { ...EXEC_BACKEND_CAPABILITIES } as Record<string, boolean>;
      for (const key of Object.keys(capabilities)) capabilities[key] = raw.info.capabilities[key] === true;
      const description = { ...raw, info: { id: raw.info.id, capabilities } } as PeerDescription;
      const suffix = description.thread ? `:${crypto.createHash("sha256").update(description.thread.threadId).digest("hex").slice(0, 16)}` : "";
      const hostId = `peer:${nodeId}:${description.profileId}${suffix}`;
      this.entries.get(hostId)?.connection?.close();
      const host: Host = { nodeId, description, connection };
      this.entries.set(hostId, host); registered = true;
      connection.onClose(() => { if (host.connection === connection) host.connection = undefined; });
      const code = crypto.randomBytes(6).toString("hex").toUpperCase();
      const expiresAt = Date.now() + 5 * 60_000;
      for (const [key, ticket] of this.tickets) if (ticket.expiresAt < Date.now() || !ticket.connection.open) this.tickets.delete(key);
      this.tickets.set(this.codeKey(code), { hostId, connection, expiresAt });
      return { hostId, code: `${code.slice(0, 6)}-${code.slice(6)}`, expiresAt };
    });
  }
  private codeKey(code: string): string { return crypto.createHash("sha256").update(code.replace(/-/g, "").toUpperCase()).digest("hex"); }
  async connect(code: string, principal: PeerPrincipal, assertCurrent: () => void): Promise<{ hostId: string; threadId?: string; label: string }> {
    if (!/^[a-fA-F0-9]{6}-?[a-fA-F0-9]{6}$/.test(code)) throw new PeerError("code", "绑定码格式不正确，请复制本机显示的完整绑定码。");
    assertCurrent();
    const key = this.codeKey(code), ticket = this.tickets.get(key);
    if (!ticket || ticket.expiresAt < Date.now() || !ticket.connection.open) throw new PeerError("code", "绑定码已过期或设备离线，请在本机重新连接获取。");
    this.tickets.delete(key);
    const host = this.entries.get(ticket.hostId);
    if (!host || host.connection !== ticket.connection) throw new PeerError("code", "设备连接已改变，请使用新的绑定码。");
    const grant: PeerGrant = { id: crypto.randomUUID(), principal, hostId: ticket.hostId,
      ...(host.description.thread ? { threadId: host.description.thread.threadId } : { scope: "device" as const }) };
    const accepted = await ticket.connection.request("binding.approve", grant, 120_000);
    assertCurrent();
    if (accepted !== true || !ticket.connection.open || host.connection !== ticket.connection) throw new PeerError("declined", "本机未确认绑定，原聊天绑定未改变。");
    const next = [...this.grants.filter(g => !(g.hostId === grant.hostId && samePrincipal(g.principal, principal))), grant];
    writeJsonFile(this.stateFile, { version: 1, grants: next }, { durable: true }); this.grants = next;
    return { hostId: grant.hostId, threadId: grant.threadId, label: this.label(grant.hostId) };
  }
  hosts(principal: PeerPrincipal): string[] { return [...new Set(this.grants.filter(g => samePrincipal(g.principal, principal)).map(g => g.hostId))]; }
  label(hostId: string): string { const host = this.entries.get(hostId); return host?.description.label ?? host?.nodeId ?? hostId; }
  isPeer(hostId?: string): boolean { return hostId?.startsWith("peer:") === true; }
  description(hostId: string): PeerDescription {
    const host = this.entries.get(hostId);
    if (!host) throw new PeerConnectionError(false);
    return host.description;
  }
  invokeFile<T>(hostId: string, method: string, payload: unknown,
    scope: { accountId: string; conversationId: string; threadId: string }): Promise<T> {
    const principal = peerPrincipal.getStore();
    // Uploads require an authenticated chat. Recovered output delivery must
    // still match its exact account, conversation and exported thread.
    if ((method.startsWith("fileUpload") && !principal) || (principal
      && (principal.accountId !== scope.accountId || principal.conversationId !== scope.conversationId)))
      throw new PeerError("access", "File transfer has no authorized chat identity");
    const grant = this.grants.find(g => g.hostId === hostId && g.principal.accountId === scope.accountId
      && g.principal.conversationId === scope.conversationId && (!principal || samePrincipal(g.principal, principal))
      && (g.scope === "device" || g.threadId === scope.threadId));
    if (!grant) throw new PeerError("access", "This chat is not authorized to transfer files for the selected session");
    return peerPrincipal.run(grant.principal, () => this.invoke<T>(hostId, method, [payload]));
  }
  async invoke<T>(hostId: string, method: string, args: unknown[], write = false,
    operationId?: string, callback?: (name: string, args: unknown[]) => Promise<unknown>, signal?: AbortSignal): Promise<T> {
    const principal = peerPrincipal.getStore();
    const grant = this.grants.find(g => g.hostId === hostId && (!principal || samePrincipal(g.principal, principal)));
    if (!grant || write && !principal) throw new PeerError("access", "当前用户或入口未获准操作这个远程会话，请先通过 /connect 绑定。");
    const host = this.entries.get(hostId);
    if (!host?.connection?.open) throw new PeerConnectionError(false);
    const connection = host.connection, callbacks = this.callbacks.get(connection)!;
    if (operationId && callback) {
      if (callbacks.has(operationId)) throw new PeerError("busy", "同一条消息正在交接，请等待原回执。");
      callbacks.set(operationId, callback);
    }
    try { return await connection.request<T>("execution.call", { grant, method, args, operationId }, write ? 24 * 60 * 60_000 : 30_000, signal); }
    finally { if (operationId && callback) callbacks.delete(operationId); }
  }
  close(): void { for (const host of this.entries.values()) host.connection?.close(); this.tickets.clear(); }
}
