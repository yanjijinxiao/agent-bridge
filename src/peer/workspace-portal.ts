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
type Pending = { entryId: string; proof: string; csrf: string; code: string; approved: boolean; expires: number };
type Browser = { entryId: string; csrf: string; expires: number };
export type SharedPortalOptions = { host: string; port: number; publicOrigin: string; tls?: { key: Buffer; cert: Buffer }; allowInsecureLan?: boolean };
/** Dedicated resource plane; management APIs and device credentials are absent. */
export class SharedWorkspacePortal {
  private readonly entries = new Map<string, SharedBrowserRef>();
  private readonly pending = new Map<string, Pending>();
  private readonly browsers = new Map<string, Browser>();
  private readonly sockets = new Set<Socket>();
  private server?: http.Server | https.Server;
  constructor(private readonly registry: PeerRegistry, private readonly options: SharedPortalOptions, private readonly now = Date.now) {
    const u = new URL(options.publicOrigin);
    const loopback = (s: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(s);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash
      || u.protocol !== "https:" && !loopback(u.hostname) && !options.allowInsecureLan
      || !options.tls && !loopback(options.host) && !options.allowInsecureLan) throw new Error("共享工作区入口需要 HTTPS、回环监听或显式允许的内网测试模式。");
  }
  entry(ref: SharedBrowserRef): string {
    const previous = [...this.entries].find(([, r]) => JSON.stringify(r) === JSON.stringify(ref));
    if (this.entries.size >= 200 && !previous) throw Error("共享入口过多，请重启资源入口清理未使用的浏览器。");
    const id = previous?.[0] ?? crypto.randomUUID(); this.entries.set(id, structuredClone(ref));
    return `${new URL(this.options.publicOrigin).origin}/shared/${id}`;
  }
  private prune() { for (const map of [this.pending, this.browsers]) for (const [key, item] of map) if (item.expires <= this.now()) map.delete(key); }
  async approve(principal: PeerPrincipal, code: string): Promise<string> {
    this.prune();
    const item = [...this.pending.values()].find(p => p.code === code && !p.approved), ref = item && this.entries.get(item.entryId);
    if (!item || !ref || !sameChatPerson(ref.principal, principal)) throw Error("浏览器申请已过期或不属于此用户和聊天。");
    await this.registry.sharing.workspace(ref, "workspace.list", { path: "" });
    this.prune(); if (![...this.pending.values()].includes(item)) throw Error("浏览器申请已过期。");
    item.approved = true; return "已确认当前浏览器。请回到原浏览器点击“检查授权”；转发链接不会授予别人访问权限。";
  }
  async listen(): Promise<void> {
    if (this.server) throw Error("Shared workspace server already running");
    const handler: http.RequestListener = (req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) this.json(res, 403, { error: "访问被拒绝或资源暂不可用，请核对授权并刷新。" }); else res.destroy(); }); };
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
    this.browsers.clear(); this.pending.clear(); this.entries.clear();
  }
  private cookie(req: http.IncomingMessage, name: string): string | undefined { return req.headers.cookie?.split(";").map(p => p.trim()).find(p => p.startsWith(name + "="))?.slice(name.length + 1); }
  private setCookie(res: http.ServerResponse, name: string, value: string, entryId: string, seconds: number) {
    res.setHeader("Set-Cookie", `${name}=${value}; Path=/shared/${entryId}; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.options.publicOrigin.startsWith("https:") ? "; Secure" : ""}`);
  }
  private json(res: http.ServerResponse, status: number, value: unknown) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    this.prune();
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    const origin = new URL(this.options.publicOrigin).origin;
    if (req.headers.host !== new URL(origin).host) { this.json(res, 403, { error: "入口主机不匹配。" }); return; }
    const route = /^\/shared\/([a-f0-9-]{36})(\/api)?$/.exec(new URL(req.url ?? "/", origin).pathname), entryId = route?.[1], ref = entryId && this.entries.get(entryId);
    if (!route || !entryId || !ref) { this.json(res, 404, { error: "入口不存在或已失效，请重新发送 /ide。" }); return; }
    const browserToken = this.cookie(req, "shared-browser"), browser = browserToken && this.browsers.get(digest(browserToken));
    const authenticated = browser && browser.entryId === entryId ? browser : undefined;
    const proof = this.cookie(req, "shared-proof"), pending = proof && this.pending.get(digest(proof));
    const pendingHere = pending && pending.entryId === entryId ? pending : undefined;
    if (req.method === "GET" && !route[2]) {
      let p = pendingHere;
      if (!authenticated && !p) {
        if (this.pending.size >= 100) { this.json(res, 429, { error: "待确认浏览器过多。" }); return; }
        let code: string; do { code = crypto.randomInt(100000, 1000000).toString(); } while ([...this.pending.values()].some(p => p.code === code));
        const token = random(); p = { entryId, proof: digest(token), csrf: random(), code, approved: false, expires: this.now() + 5 * 60_000 };
        this.pending.set(p.proof, p); this.setCookie(res, "shared-proof", token, entryId, 300);
      }
      const nonce = random(); res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(workspacePage(nonce, authenticated?.csrf ?? p!.csrf, authenticated ? undefined : p!.code)); return;
    }
    if (req.method !== "POST" || !route[2] || req.headers.origin !== origin || !req.headers["content-type"]?.startsWith("application/json")) { this.json(res, 403, { error: "请求来源不匹配。" }); return; }
    const csrf = req.headers["x-workspace-csrf"];
    if (typeof csrf !== "string" || csrf !== (authenticated?.csrf ?? pendingHere?.csrf)) { this.json(res, 403, { error: "浏览器验证失败。" }); return; }
    let length = 0; const parts: Buffer[] = [];
    for await (const part of req) { length += part.length; if (length > 900_000) { this.json(res, 413, { error: "文件过大。" }); return; } parts.push(part); }
    const body = z.object({ operation: z.enum(["exchange", "session", "list", "read", "write"]), path: z.string().max(4096).optional(), text: z.string().max(131072).optional(), hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
    if (body.operation === "exchange") {
      if (!pendingHere?.approved || this.pending.get(pendingHere.proof) !== pendingHere) throw Error("请先在机器人聊天中确认当前浏览器。");
      await this.registry.sharing.workspace(ref, "workspace.list", { path: "" });
      if (pendingHere.expires <= this.now()) throw Error("申请已过期。");
      if (this.browsers.size >= 100) throw Error("浏览器会话达到上限。");
      this.pending.delete(pendingHere.proof);
      const token = random(), session = { entryId, csrf: random(), expires: this.now() + 3600_000 };
      this.browsers.set(digest(token), session); this.setCookie(res, "shared-browser", token, entryId, 3600);
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
