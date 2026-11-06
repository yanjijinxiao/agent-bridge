import { withHttpContract } from "../runtime/http-contract.js";
import { IDEAuthorization, IDE_SESSION_TTL_MS } from "../ide/authorization.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { z } from "zod";
import { workspacePage } from "./workspace-page.js";
import { sameChatPerson } from "./sharing-types.js";
import type { PeerPrincipal } from "./context.js";
import type { PeerRegistry } from "./registry.js";
import type { SharedBrowserRef } from "./sharing-gateway.js";

const digest = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");
export type SharedPortalOptions = { host: string; port: number; publicOrigin: string; tls?: { key: Buffer; cert: Buffer }; allowInsecureLan?: boolean; stateFile?: string };
/** Dedicated resource plane; management APIs and device credentials are absent. */
export class SharedWorkspacePortal {
  private readonly entries = new Map<string, SharedBrowserRef>();
  private readonly authorization: IDEAuthorization;
  private readonly sockets = new Set<Socket>();
  private server?: http.Server | https.Server;
  constructor(private readonly registry: PeerRegistry, private readonly options: SharedPortalOptions, private readonly now = Date.now) {
    const u = new URL(options.publicOrigin);
    const loopback = (s: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(s);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash
      || u.protocol !== "https:" && !loopback(u.hostname) && !options.allowInsecureLan
      || !options.tls && !loopback(options.host) && !options.allowInsecureLan) throw new Error("共享工作区入口需要 HTTPS、回环监听或显式允许的内网测试模式。");
    if (options.stateFile) {
      const refSchema = z.object({ principal: z.object({ accountId: z.string(), conversationId: z.string(), actorId: z.string() }).strict(),
        target: z.object({ hostId: z.string(), threadId: z.string() }).strict(), grantId: z.string(), resourceId: z.string() }).strict();
      const saved = z.object({ version: z.literal(1), entries: z.array(z.tuple([z.string().uuid(), refSchema])).max(200) }).strict()
        .parse(readJsonFile(options.stateFile, { version: 1, entries: [] }));
      for (const [id, ref] of saved.entries) this.entries.set(id, ref);
    }
    this.authorization = new IDEAuthorization(now, options.stateFile && options.stateFile + ".sessions", u.origin, undefined, undefined, id => {
      const ref = this.entries.get(id), grant = ref && registry.grantsFor(ref.principal).find(g => g.id === ref.grantId);
      return grant ? grant.delegation?.expiresAt ?? now() + IDE_SESSION_TTL_MS : 0;
    });
  }
  entry(ref: SharedBrowserRef): string {
    // Entries survive restart. Retire only locally known revoked/expired or
    // replaced grants, never a live grant whose device is temporarily offline.
    const next = new Map([...this.entries].filter(([, entry]) =>
      this.registry.grantsFor(entry.principal).some(grant => grant.id === entry.grantId
        && (!grant.delegation || grant.delegation.resourceId === entry.resourceId))));
    const previous = [...next].find(([, r]) => JSON.stringify(r) === JSON.stringify(ref));
    if (next.size >= 200 && !previous) throw Error("共享入口过多，请撤销不再使用的共享授权后重试。");
    const id = previous?.[0] ?? crypto.randomUUID(); next.set(id, structuredClone(ref));
    // A failed durable write must not publish or accumulate entries in memory.
    if (this.options.stateFile) writeJsonFile(this.options.stateFile, { version: 1, entries: [...next] }, { durable: true });
    this.entries.clear();
    for (const [entryId, entry] of next) this.entries.set(entryId, entry);
    return `${new URL(this.options.publicOrigin).origin}/shared/${id}`;
  }
  async approve(principal: PeerPrincipal, code: string): Promise<string> {
    const item = this.authorization.pending().find(p => p.code === code), ref = item && this.entries.get(item.entryId);
    if (!item || !ref || !sameChatPerson(ref.principal, principal)) throw Error("浏览器申请已过期或不属于此用户和聊天。");
    await this.registry.sharing.workspace(ref, "workspace.list", { path: "" });
    this.authorization.approve(item.id, item.entryId);
    return "已确认当前浏览器。请回到原浏览器点击“检查授权”；转发链接不会授予别人访问权限。";
  }
  async listen(): Promise<void> {
    if (this.server) throw Error("Shared workspace server already running");
    const handler: http.RequestListener = (req, res) => { void withHttpContract(req, res, "workspace-portal", () => this.handle(req, res)).catch(() => { if (!res.headersSent) this.json(res, 403, { error: "访问被拒绝或资源暂不可用，请核对授权并刷新。" }); else res.destroy(); }); };
    const server = this.options.tls ? https.createServer(this.options.tls, handler) : http.createServer(handler);
    server.on("connection", socket => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
    server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.maxConnections = 100; server.maxHeadersCount = 50;
    server.on("upgrade", (_req, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.options.port, this.options.host, () => { server.removeListener("error", reject); resolve(); }); });
    this.server = server; this.registry.sharing.portal = this;
  }
  address(): string { const a = this.server?.address(); if (!a || typeof a === "string") throw Error("Not listening"); return `${this.options.tls ? "https" : "http"}://127.0.0.1:${a.port}`; }
  async close(): Promise<void> {
    if (this.registry.sharing.portal === this) this.registry.sharing.portal = undefined;
    for (const socket of this.sockets) socket.destroy();
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    this.entries.clear();
  }
  private cookie(req: http.IncomingMessage, name: string): string | undefined { return req.headers.cookie?.split(";").map(p => p.trim()).find(p => p.startsWith(name + "="))?.slice(name.length + 1); }
  private setCookie(res: http.ServerResponse, name: string, value: string, entryId: string, seconds: number) {
    res.setHeader("Set-Cookie", `${name}=${value}; Path=/shared/${entryId}; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.options.publicOrigin.startsWith("https:") ? "; Secure" : ""}`);
  }
  private json(res: http.ServerResponse, status: number, value: unknown) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    const origin = new URL(this.options.publicOrigin).origin;
    this.authorization.setAudience(origin);
    if (req.headers.host !== new URL(origin).host) { this.json(res, 403, { error: "入口主机不匹配。" }); return; }
    const route = /^\/shared\/([a-f0-9-]{36})(\/api)?$/.exec(new URL(req.url ?? "/", origin).pathname), entryId = route?.[1], ref = entryId && this.entries.get(entryId);
    if (!route || !entryId || !ref) { this.json(res, 404, { error: "入口不存在或已失效，请重新发送 /ide。" }); return; }
    const authenticated = this.authorization.authenticate(this.cookie(req, "shared-browser"), entryId);
    const [requestId, proof] = (this.cookie(req, "shared-proof") ?? "").split(".");
    const pendingHere = requestId && proof ? this.authorization.pendingRequest(requestId, proof, entryId) : undefined;
    const pendingCsrf = proof ? digest(proof + entryId) : undefined;
    if (req.method === "GET" && !route[2]) {
      let p = pendingHere, csrf = pendingCsrf;
      if (!authenticated && !p) {
        const created = this.authorization.request(entryId);
        p = created.request; csrf = digest(created.proof + entryId);
        this.setCookie(res, "shared-proof", `${p.id}.${created.proof}`, entryId, 300);
      }
      const nonce = random(); res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(workspacePage(nonce, authenticated?.csrf ?? csrf!, authenticated ? undefined : p!.code)); return;
    }
    if (req.method !== "POST" || !route[2] || req.headers.origin !== origin || !req.headers["content-type"]?.startsWith("application/json")) { this.json(res, 403, { error: "请求来源不匹配。" }); return; }
    const csrf = req.headers["x-workspace-csrf"];
    if (typeof csrf !== "string" || csrf !== (authenticated?.csrf ?? (pendingHere ? pendingCsrf : undefined))) { this.json(res, 403, { error: "浏览器验证失败。" }); return; }
    let length = 0; const parts: Buffer[] = [];
    for await (const part of req) { length += part.length; if (length > 900_000) { this.json(res, 413, { error: "文件过大。" }); return; } parts.push(part); }
    const body = z.object({ operation: z.enum(["exchange", "session", "list", "read", "write"]), path: z.string().max(4096).optional(), text: z.string().max(131072).optional(), hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
    if (body.operation === "exchange") {
      if (!pendingHere?.approved) throw Error("请先在机器人聊天中确认当前浏览器。");
      await this.registry.sharing.workspace(ref, "workspace.list", { path: "" });
      const result = this.authorization.exchangeRequest(requestId, proof, entryId);
      if (!result) throw Error("申请已过期。");
      const { token, session } = result;
      this.setCookie(res, "shared-browser", token, entryId, Math.floor((session.expiresAt - this.now()) / 1000));
      this.json(res, 200, { csrf: session.csrf }); return;
    }
    if (!authenticated) { this.json(res, 401, { error: "浏览器尚未确认或已过期。" }); return; }
    if (body.operation === "session") {
      await this.registry.sharing.workspace(ref, "workspace.list", { path: "" });
      const grant = this.registry.grantsFor(ref.principal).find(g => g.id === ref.grantId);
      this.json(res, 200, { csrf: authenticated.csrf, writable: Boolean(grant && (!grant.delegation || grant.delegation.permissions.includes("ide-write"))) }); return;
    }
    const result = await this.registry.sharing.workspace(ref, `workspace.${body.operation}`, { path: body.path ?? "", ...(body.text === undefined ? {} : { text: body.text }), ...(body.hash ? { hash: body.hash } : {}) });
    this.json(res, 200, result);
  }
}
