import { PEER_CAPABILITIES } from "../runtime/versions.js";
import crypto from "node:crypto";
import { z } from "zod";
import type { CodexBackendCapabilities, CodexThreadState, CodexBackendId } from "../codex/backend.js";
import { EXEC_BACKEND_CAPABILITIES } from "../codex/backend.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { peerPrincipal, type PeerBridgePort, type PeerPrincipal } from "./context.js";
import { PeerConnection, PeerConnectionError, PeerError, PEER_EXECUTION_TIMEOUT_MS } from "./rpc.js";
import { peerGrantSchema } from "./sharing-types.js";
import { PeerSharingGateway } from "./sharing-gateway.js";
import type { IDEHostContext } from "../ide/transport.js";
import type { PeerEnrollment } from "./credentials.js";
import { managedGrant, managedTarget, validateManagedRoutes, type ManagedConnectorRoute } from "./managed-route.js";
import { diagnostic } from "../runtime/diagnostics.js";

const principalSchema = z.object({ accountId: z.string().min(1).max(512), conversationId: z.string().min(1).max(512), actorId: z.string().min(1).max(512) }).strict();
export const grantSchema = peerGrantSchema;
export type PeerGrant = z.infer<typeof grantSchema>;
const descriptionSchema = z.object({ profileId: z.string().regex(/^[\w-]{1,80}$/),
  thread: z.object({ threadId: z.string().min(1), cwd: z.string().min(1), title: z.string().optional(),
    persistence: z.enum(["active", "archived"]), internal: z.literal(false).optional() }).passthrough().optional(),
  label: z.string().min(1).max(80).optional(),
  writeGuard: z.literal(PEER_CAPABILITIES.writeGuard).optional(),
  interactions: z.literal(PEER_CAPABILITIES.interactions).optional(),
  nativeContract: z.literal(PEER_CAPABILITIES.nativeContract).optional(),
  fullIDE: z.literal(PEER_CAPABILITIES.fullIDE).optional(),
  managedHost: z.string().optional(),
  hosts: z.array(z.object({ nativeHostId: z.string().min(1).max(512), managedHost: z.string().optional() }).strict()).max(100).optional(),
  files: z.object({ version: z.literal(PEER_CAPABILITIES.files) }).strict().optional(),
  management: z.object({ version: z.literal(PEER_CAPABILITIES.management) }).strict().optional(),
  sharing: z.object({ version: z.union([z.literal(1), z.literal(PEER_CAPABILITIES.sharing)]) }).strict().optional(),
  info: z.object({ id: z.enum(["exec", "app-server"]), capabilities: z.record(z.string(), z.boolean()) }),
  independent: z.boolean() }).strict();
export type PeerDescription = { profileId: string; label?: string; managedHost?: string; hosts?: { nativeHostId: string; managedHost?: string }[]; writeGuard?: 1; interactions?: 1; nativeContract?: 1; fullIDE?: 1; files?: { version: 1 }; management?: { version: 1 }; sharing?: { version: 1 | 2 }; thread?: CodexThreadState & { cwd: string };
  info: { id: CodexBackendId; capabilities: CodexBackendCapabilities }; independent: boolean };
type Host = { nodeId: string; description: PeerDescription; connection?: PeerConnection; parent?: string; nativeHostId?: string;
  versions: ReturnType<PeerConnection["versionStatus"]> };
export const peerNativeHost = (root: string, native: string) => `${root}:host:${crypto.createHash("sha256").update(native).digest("hex").slice(0, 24)}`;
const samePrincipal = (a: PeerPrincipal, b: PeerPrincipal) => a.accountId === b.accountId && a.conversationId === b.conversationId && a.actorId === b.actorId;

/** Device authentication does not grant every bot participant session access. */
export class PeerRegistry implements PeerBridgePort {
  readonly sharing: PeerSharingGateway;
  private readonly entries = new Map<string, Host>();
  private grants: PeerGrant[];
  private readonly tickets = new Map<string, { hostId: string; host: Host; connection: PeerConnection; expiresAt: number; enrollment?: PeerEnrollment }>();
  private readonly callbacks = new WeakMap<PeerConnection, Map<string, (name: string, args: unknown[]) => Promise<unknown>>>();
  constructor(private readonly stateFile: string, private readonly managedRoutes: readonly ManagedConnectorRoute[] = []) {
    validateManagedRoutes(managedRoutes);
    this.grants = z.object({ version: z.literal(1), grants: z.array(grantSchema) })
      .parse(readJsonFile(stateFile, { version: 1, grants: [] })).grants;
    this.sharing = new PeerSharingGateway(this, stateFile + ".sharing");
  }
  managedRoute(hostId = "local"): ManagedConnectorRoute | undefined { return this.managedRoutes.find(r => r.hostId === hostId); }
  managedHosts(): string[] { return this.managedRoutes.map(r => r.hostId); }
  connectorRoot(hostId: string): string {
    const route = this.managedRoute(hostId);
    return route ? this.managedRoutes.find(r => managedTarget(r) === managedTarget(route) && !r.nativeHostId)?.hostId ?? hostId : this.host(hostId)?.parent ?? hostId;
  }
  catalogHosts(hostId: string): string[] {
    const root = this.connectorRoot(hostId);
    if (hostId !== root) return [hostId];
    return [...new Set([root, ...this.managedHosts().filter(h => this.connectorRoot(h) === root),
      ...[...this.entries].filter(([, h]) => h.parent === root && !h.description.managedHost).map(([id]) => id)])];
  }
  private grantsAt(hostId: string): PeerGrant[] {
    const parent = this.host(hostId)?.parent;
    return this.grants.flatMap(g => g.hostId === hostId ? [g]
      : parent && g.hostId === parent && g.scope === "device" && !g.delegation ? [{ ...g, hostId }] : []);
  }
  status() {
    const versions = (id: string) => { const host = this.host(id); return { ...structuredClone(host?.versions ?? { compatibility: "legacy", runtime: null }),
      nativeHosts: (host?.description.hosts ?? []).map(item => ({ nativeHostId: item.nativeHostId,
        hostId: item.managedHost ?? peerNativeHost(this.connectorRoot(id), item.nativeHostId) })) }; };
    return { mode: "connector-only" as const, routes: [
      ...this.managedRoutes.map(r => ({ hostId: r.hostId, connectorId: managedTarget(r), label: this.label(r.hostId), online: this.isOnline(r.hostId), managed: true, ...versions(r.hostId) })),
      ...[...this.entries].filter(([, host]) => !host.description.managedHost && !host.parent).map(([id, host]) => ({ hostId: id, connectorId: id, label: this.label(id), online: host.connection?.open === true, managed: false, ...versions(id) }))
    ] };
  }
  /** Routing is separate from user-device pairing. Existing host ACLs remain
   * Gateway-owned; isPeer deliberately keeps its original authorization meaning. */
  isRouted(hostId = "local"): boolean { return this.isPeer(hostId) || !!this.managedRoute(hostId); }
  private host(hostId: string): Host | undefined {
    const route = this.managedRoute(hostId);
    return this.entries.get(route ? route.nativeHostId ? peerNativeHost(managedTarget(route), route.nativeHostId) : managedTarget(route) : hostId);
  }
  grantsFor(principal: PeerPrincipal): PeerGrant[] { return this.grants.filter(g => samePrincipal(g.principal, principal) && (!g.delegation || g.delegation.version === 2 && g.delegation.expiresAt > Date.now())); }
  grantsForTarget(principal: PeerPrincipal, hostId: string): PeerGrant[] {
    return this.grantsAt(hostId).filter(g => samePrincipal(g.principal, principal)
      && (!g.delegation || g.delegation.version === 2 && g.delegation.expiresAt > Date.now()));
  }
  sourcesForScope(scope: { hostId: string; threadId: string }): PeerPrincipal[] {
    return this.grantsAt(scope.hostId).filter(g => (g.scope === "device" || g.threadId === scope.threadId)
      && (!g.delegation || g.delegation.version === 2 && g.delegation.expiresAt > Date.now())).map(g => g.principal);
  }
  allSharedGrants(target: { hostId: string; threadId: string }): PeerGrant[] { return this.grants.filter(g => g.hostId === target.hostId && g.threadId === target.threadId && g.delegation); }
  addSharedGrant(raw: unknown): PeerGrant {
    const grant = grantSchema.parse(raw); if (!grant.delegation || grant.delegation.version !== 2) throw new PeerError("scope", "共享授权需要重新批准；请更新 Gateway 和 Connector。");
    const next = [...this.grants.filter(g => g.id !== grant.id), grant];
    writeJsonFile(this.stateFile, { version: 1, grants: next }, { durable: true }); this.grants = next; return grant;
  }
  removeSharedGrants(ids: string[]): void {
    const next = this.grants.filter(g => !g.delegation || !ids.includes(g.id));
    writeJsonFile(this.stateFile, { version: 1, grants: next }, { durable: true }); this.grants = next;
  }
  async sharingCall(hostId: string, method: string, input: object, principal: PeerPrincipal, guard: () => void): Promise<any> {
    if (this.description(hostId).sharing?.version !== 2) throw new PeerError("unsupported", "请先更新 Connector 以启用所有权和共享。");
    const host = this.host(hostId); if (!host?.connection?.open) throw new PeerConnectionError(false);
    const threadId = (input as any).threadId;
    const candidates = this.grantsAt(hostId).filter(g => samePrincipal(g.principal, principal) && (!g.threadId || !threadId || g.threadId === threadId));
    const grant = (method.startsWith("workspace.") ? candidates.find(g => g.delegation && g.threadId === threadId) : candidates.find(g => !g.delegation)) ?? candidates[0];
    if (method !== "request" && !grant) throw new PeerError("access", "当前用户没有此设备或会话的授权。");
    guard(); const result = await host.connection.request("sharing.call", { method, input: method === "request" ? { ...input, principal } : input, ...(method === "request" ? {} : { grant }) }, method === "claim" ? 120_000 : 30_000); guard();
    return result;
  }
  accept(nodeId: string, connection: PeerConnection, enrollment?: PeerEnrollment): void {
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
      const capabilities = { ...EXEC_BACKEND_CAPABILITIES, skills: false, mcpServers: false } as Record<string, boolean>;
      for (const key of Object.keys(capabilities)) capabilities[key] = raw.info.capabilities[key] === true;
      const description = { ...raw, info: { id: raw.info.id, capabilities } } as PeerDescription;
      const suffix = description.thread ? `:${crypto.createHash("sha256").update(description.thread.threadId).digest("hex").slice(0, 16)}` : "";
      const hostId = `peer:${nodeId}:${description.profileId}${suffix}`;
      const managed = this.managedRoutes.find(r => managedTarget(r) === hostId);
      if (managed ? enrollment || description.thread || description.managedHost !== managed.hostId : description.managedHost !== undefined)
        throw new PeerError("scope", "Managed Connector identity does not match the deployment route");
      const exports = description.hosts ?? [];
      if (description.thread && exports.length || new Set(exports.map(h => h.nativeHostId)).size !== exports.length
        || exports.some(h => h.nativeHostId === "local")
        || (managed ? exports.some(h => !this.managedRoutes.some(r => managedTarget(r) === hostId && r.nativeHostId === h.nativeHostId && r.hostId === h.managedHost)) : exports.some(h => h.managedHost)))
        throw new PeerError("scope", "Connector native host exports do not match deployment routes");
      const host: Host = { nodeId, description, connection, versions: connection.versionStatus() };
      // Pending devices live only in the pairing ticket. They cannot publish
      // IDE/session hosts, displace a healthy connection or use old grants.
      const publish = () => {
        this.entries.get(hostId)?.connection?.close();
        for (const [id, old] of this.entries) if (old.parent === hostId) this.entries.delete(id);
        this.entries.set(hostId, host);
        const version = connection.versionStatus();
        diagnostic("peer.registered", { hostId, connectionId: connection.connectionId, compatibility: version.compatibility,
          remoteInstanceId: version.runtime?.instanceId, remoteVersion: version.runtime?.productVersion, remoteCommit: version.runtime?.build?.commit });
        for (const exported of exports) {
          const id = peerNativeHost(hostId, exported.nativeHostId), child = connection.channel(exported.nativeHostId);
          const entry: Host = { nodeId, parent: hostId, nativeHostId: exported.nativeHostId, connection: child,
            versions: host.versions, description: { ...description, hosts: undefined, managedHost: exported.managedHost } };
          this.entries.set(id, entry); this.callbacks.set(child, callbacks);
          child.handle("execution.callback", async params => {
            const { operationId, name, args } = z.object({ operationId: z.string(), name: z.string(), args: z.array(z.unknown()) }).strict().parse(params);
            const callback = callbacks.get(operationId); if (!callback) throw new PeerError("stale", "The originating request is no longer active");
            return callback(name, args);
          });
          connection.onClose(() => { if (entry.connection === child) entry.connection = undefined; });
        }
      };
      if (!enrollment) publish();
      registered = true;
      connection.onClose(() => { if (host.connection === connection) host.connection = undefined; });
      // An admin-provisioned export is not a reusable personal pairing code.
      if (managed) return { hostId: managed.hostId, managed: true, paired: true };
      const code = crypto.randomBytes(6).toString("hex").toUpperCase();
      const expiresAt = Date.now() + 5 * 60_000;
      for (const [key, ticket] of this.tickets) if (ticket.expiresAt < Date.now() || !ticket.connection.open) this.tickets.delete(key);
      const key = this.codeKey(code);
      this.tickets.set(key, { hostId, host, connection, expiresAt, enrollment });
      this.publications.set(host, publish);
      connection.onClose(() => { this.tickets.delete(key); });
      return { hostId, code: `${code.slice(0, 6)}-${code.slice(6)}`, expiresAt,
        enrollment: !!enrollment, paired: !enrollment && this.grants.some(g => g.hostId === hostId && !g.delegation) };
    });
  }
  private codeKey(code: string): string { return crypto.createHash("sha256").update(code.replace(/-/g, "").toUpperCase()).digest("hex"); }
  async connect(code: string, principal: PeerPrincipal, assertCurrent: () => void): Promise<{ hostId: string; threadId?: string; label: string }> {
    if (!/^[a-fA-F0-9]{6}-?[a-fA-F0-9]{6}$/.test(code)) throw new PeerError("code", "绑定码格式不正确，请复制本机显示的完整绑定码。");
    assertCurrent();
    const key = this.codeKey(code), ticket = this.tickets.get(key);
    if (!ticket || ticket.expiresAt < Date.now() || !ticket.connection.open) throw new PeerError("code", "绑定码已过期或设备离线，请在本机重新连接获取。");
    this.tickets.delete(key);
    const host = ticket.host;
    const current = () => ticket.connection.open && host.connection === ticket.connection
      && (ticket.enrollment ? !this.entries.has(ticket.hostId) : this.entries.get(ticket.hostId) === host);
    if (!current()) throw new PeerError("code", "设备连接已改变，请使用新的绑定码。");
    const grant: PeerGrant = { id: crypto.randomUUID(), principal, hostId: ticket.hostId,
      ...(host.description.thread ? { threadId: host.description.thread.threadId } : { scope: "device" as const }) };
    try {
      const accepted = await ticket.connection.request("binding.approve", grant, 120_000);
      assertCurrent();
      if (accepted !== true || !current() || Date.now() >= ticket.expiresAt) throw new PeerError("declined", "本机未确认绑定或申请已过期，原聊天绑定未改变。");
      const next = [...this.grants.filter(g => !(g.hostId === grant.hostId && samePrincipal(g.principal, principal))), grant];
      // Persist identity before grants. A later grant-write failure leaves an
      // authenticated but ungranted device that can pair again after reconnect.
      ticket.enrollment?.commit(principal);
      writeJsonFile(this.stateFile, { version: 1, grants: next }, { durable: true }); this.grants = next;
      if (ticket.enrollment) this.publications.get(host)?.();
      return { hostId: grant.hostId, threadId: grant.threadId, label: this.label(grant.hostId) };
    } finally {
      // A consumed failed enrollment must not leave a live socket with no
      // usable code. Reconnect obtains a fresh ticket; no input is replayed.
      if (ticket.enrollment && this.entries.get(ticket.hostId) !== host) ticket.connection.close();
    }
  }
  private readonly publications = new WeakMap<Host, () => void>();
  hosts(principal: PeerPrincipal): string[] { return [...new Set(this.grantsFor(principal).flatMap(g => g.scope === "device" && !g.delegation ? this.catalogHosts(g.hostId) : [g.hostId]))]; }
  /** Local management discovery only. A configured host is not a browser
   * grant: every IDE request still resolves its own personal device grant. */
  fullIDEHosts(): string[] {
    return [...this.managedHosts().filter(id => this.host(id)?.description.fullIDE === 1), ...[...this.entries].filter(([id, host]) => !host.description.managedHost && host.connection?.open && host.description.fullIDE === 1
      && this.grantsAt(id).some(g => !g.delegation)).map(([id]) => id)];
  }
  fullIDEAvailable(principal: PeerPrincipal, target: { hostId: string; threadId: string }): boolean {
    return this.host(target.hostId)?.description.fullIDE === 1 && this.grantsAt(target.hostId).filter(g => samePrincipal(g.principal, principal))
      .some(g => !g.delegation && g.hostId === target.hostId && (g.scope === "device" || g.threadId === target.threadId));
  }
  /** Browser authority is a person, never an unscoped observation fallback.
   * A person's device pairing in another chat is still theirs; other actors,
   * accounts and text-sharing delegations are never candidates. */
  private ideGrant(hostId: string, context: IDEHostContext): PeerGrant | undefined {
    const route = this.managedRoute(hostId);
    if (route && context.administrative && context.threadId && this.host(hostId)?.description.fullIDE === 1) return managedGrant(route);
    const person = context.subject?.principal;
    if (!person || person.accountId !== context.accountId || !context.threadId || this.host(hostId)?.description.fullIDE !== 1) return;
    const managed = this.managedRoute(hostId);
    if (managed) return managedGrant(managed, { accountId: person.accountId, actorId: person.actorId, conversationId: "gateway-ide" });
    return this.grantsAt(hostId).find(g => !g.delegation && g.principal.accountId === person.accountId
      && g.principal.actorId === person.actorId && (g.scope === "device" || g.threadId === context.threadId));
  }
  canAccessIDE(hostId: string, context: IDEHostContext): boolean { return !!this.ideGrant(hostId, context); }
  ideConnection(hostId: string, context: IDEHostContext) {
    const grant = this.ideGrant(hostId, context), connection = this.host(hostId)?.connection;
    if (!grant) throw new PeerError("access", "完整 IDE 需要本人已确认的 Connector 授权，请由同一用户配对浏览器。");
    if (!connection?.open) throw new PeerConnectionError(false);
    return { grant, connection, guard: () => {
      if (!connection.open || this.host(hostId)?.connection !== connection || this.ideGrant(hostId, context)?.id !== grant.id)
        throw new PeerError("access", "Connector IDE 连接或授权已改变。");
    } };
  }
  label(hostId: string): string {
    const host = this.host(hostId), device = host?.description.label ?? host?.nodeId ?? hostId;
    // A remote execution host travels through this device; it is not the Mac
    // itself. Derive display only from the authenticated exported host identity.
    return host?.nativeHostId ? `${host.nativeHostId.replace(/^remote-ssh-discovered:/, "")}（经 ${device}）` : device;
  }
  isOnline(hostId: string): boolean { return this.host(hostId)?.connection?.open === true; }
  isPeer(hostId?: string): boolean { return hostId?.startsWith("peer:") === true; }
  description(hostId: string): PeerDescription {
    const host = this.host(hostId);
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
    if (this.managedRoute(hostId)) return peerPrincipal.run(principal ?? { accountId: scope.accountId, conversationId: scope.conversationId, actorId: "gateway-delivery" },
      () => this.invoke<T>(hostId, method, [payload]));
    const candidates = this.grantsAt(hostId).filter(g => g.principal.accountId === scope.accountId
      && g.principal.conversationId === scope.conversationId && (!principal || samePrincipal(g.principal, principal))
      && (!g.delegation || g.delegation.version === 2 && g.delegation.expiresAt > Date.now())
      && (g.scope === "device" || g.threadId === scope.threadId));
    const grant = candidates.find(g => g.delegation && g.threadId === scope.threadId) ?? candidates[0];
    if (!grant) throw new PeerError("access", "This chat is not authorized to transfer files for the selected session");
    return peerPrincipal.run(grant.principal, () => this.invoke<T>(hostId, method, [payload], false, undefined, undefined, undefined, grant.id));
  }
  async invoke<T>(hostId: string, method: string, args: unknown[], write = false,
    operationId?: string, callback?: (name: string, args: unknown[]) => Promise<unknown>, signal?: AbortSignal, selectedGrantId?: string, retainCallback = false): Promise<T> {
    const principal = peerPrincipal.getStore();
    const first = args[0] as any, target = ["listSkills", "warmUp"].includes(method) ? undefined : method === "getRuntimeInfo" ? args[1] : typeof first === "string" ? first : first?.threadId;
    const candidates = this.grantsAt(hostId).filter(g => (!principal || samePrincipal(g.principal, principal))
      && (!selectedGrantId || g.id === selectedGrantId)
      && (!g.delegation || g.delegation.version === 2 && g.delegation.expiresAt > Date.now() && (!target || target === g.threadId)));
    const managed = this.managedRoute(hostId);
    const grant = managed ? managedGrant(managed, principal) : (target ? candidates.find(g => g.delegation && g.threadId === target) : candidates.find(g => !g.delegation)) ?? candidates[0];
    if (!grant || write && !principal && !managed) throw new PeerError("access", "当前用户或入口未获准操作这个远程会话，请先通过 /connect 绑定。");
    const host = this.host(hostId);
    if (!host?.connection?.open) throw new PeerConnectionError(false);
    if (write && host.description.writeGuard !== 1) throw new PeerError("unsupported", "请更新 Connector：当前版本不支持最终写入前的来源检查。");
    const connection = host.connection, callbacks = this.callbacks.get(connection)!;
    let registeredCallback = false;
    if (operationId && callback && !(retainCallback && callbacks.has(operationId))) {
      if (callbacks.size >= 512) throw new PeerError("busy", "Too many pending native callback leases");
      if (callbacks.has(operationId)) throw new PeerError("busy", "同一条消息正在交接，请等待原回执。");
      registeredCallback = true;
      callbacks.set(operationId, async (name, values) => {
        if (grant.delegation && !this.grantsFor(grant.principal).some(g => g.id === grant.id)) throw new PeerError("access", "共享已撤销或过期。");
        return callback(name, values);
      });
    }
    let completed = false;
    try {
      const result = await connection.request<T>("execution.call", { grant, method, args, operationId }, write || ["observeThreadInteractions", "monitorSessionEvents"].includes(method) ? PEER_EXECUTION_TIMEOUT_MS : 30_000, signal);
      if (grant.delegation && !this.grantsFor(grant.principal).some(g => g.id === grant.id)) throw new PeerError("access", "共享已撤销或过期，未继续投递。");
      completed = true; return result;
    }
    finally { if (operationId && registeredCallback && (!completed || !retainCallback)) callbacks.delete(operationId); }
  }
  callbackLease(hostId: string, operationId: string): () => void {
    const connection = this.host(hostId)?.connection;
    const callbacks = connection && this.callbacks.get(connection);
    return () => { callbacks?.delete(operationId); };
  }
  onDisconnect(hostId: string, handler: () => void): () => void {
    const connection = this.host(hostId)?.connection;
    if (!connection?.open) { handler(); return () => {}; }
    return connection.onClose(handler);
  }
  close(): void { for (const host of this.entries.values()) host.connection?.close(); for (const ticket of this.tickets.values()) ticket.connection.close(); this.tickets.clear(); }
}
