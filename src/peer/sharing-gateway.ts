import crypto from "node:crypto";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { PeerRegistry, PeerGrant } from "./registry.js";
import type { PeerPrincipal } from "./context.js";
import type { PeerSharingPort, SharedTarget, SharingCommandResult, SharedPermission } from "./sharing-types.js";
import { PeerError } from "./rpc.js";

export type SharedBrowserRef = { principal: PeerPrincipal; target: SharedTarget; grantId: string; resourceId: string };
type Portal = { entry(ref: SharedBrowserRef): string; approve(principal: PeerPrincipal, code: string): Promise<string> };
const stateSchema = z.object({ version: z.literal(1), invites: z.array(z.object({ hash: z.string(), hostId: z.string(), expiresAt: z.number() }).strict()) }).strict();
const hash = (code: string) => crypto.createHash("sha256").update(code).digest("hex");
const usage = "用法：/share claim [--ide]；/share invite；/share requests；/share approve 申请ID read|chat|control [--ide read|write] [--files] [--manage] [--hours 24]；/share deny 申请ID；/share list；/share revoke 授权ID。";

export class PeerSharingGateway implements PeerSharingPort {
  private state: z.infer<typeof stateSchema>;
  portal?: Portal;
  constructor(private readonly registry: PeerRegistry, private readonly file: string) {
    this.state = stateSchema.parse(readJsonFile(file, { version: 1, invites: [] }));
  }
  admitted(principal: PeerPrincipal): boolean { return this.registry.grantsFor(principal).some(g => Boolean(g.delegation)); }
  role(principal: PeerPrincipal): "viewer" | "participant" | "controller" {
    const permissions = this.registry.grantsFor(principal).flatMap(g => g.delegation?.permissions ?? []);
    return permissions.some(p => ["stop", "approve", "manage"].includes(p)) ? "controller" : permissions.includes("chat") ? "participant" : "viewer";
  }
  async command(principal: PeerPrincipal, command: "share" | "join", arg: string, target: SharedTarget | undefined, guard: () => void): Promise<SharingCommandResult> {
    if (command === "join") {
      const code = arg.trim().toUpperCase();
      if (!/^SH-[A-F0-9]{32}$/.test(code)) return { text: "请复制所有者给出的完整 /join SH-… 命令。邀请只用于申请，不直接授予权限。" };
      const invite = this.state.invites.find(i => i.hash === hash(code) && i.expiresAt > Date.now());
      if (!invite) throw new PeerError("access", "邀请已失效，请联系会话所有者。");
      const result = await this.registry.sharingCall(invite.hostId, "request", { code }, principal, guard);
      if (result.grant) {
        if (result.grant.principal.accountId !== principal.accountId || result.grant.principal.conversationId !== principal.conversationId || result.grant.principal.actorId !== principal.actorId) throw new PeerError("scope", "申请身份不匹配。");
        const grant = this.registry.addSharedGrant(result.grant);
        return { text: "所有者已授权此会话；该授权仅用于当前用户和当前聊天。", bind: { hostId: grant.hostId, threadId: grant.threadId! } };
      }
      return { text: result.request.status === "denied" ? "所有者已拒绝此申请。" : `访问申请已登记：${result.request.id}\n请所有者发送 /share requests，再批准具体权限与有效期。批准后重新发送本条 /join 命令。` };
    }
    if (!target) return { text: "请先选择自己的会话，再使用 /share claim 在 Connector 本机确认所有权。" };
    const call = (method: string, input: object = {}) => this.registry.sharingCall(target.hostId, method, { ...target, ...input }, principal, guard);
    if (/^claim(?:\s+--ide)?$/i.test(arg.trim())) {
      const result = await call("claim", { workspace: /--ide/i.test(arg) });
      // Ownership refresh invalidates all former delegations for this thread.
      this.registry.removeSharedGrants(this.registry.allSharedGrants(target).filter(g => g.delegation!.resourceId !== result.resource.id).map(g => g.id));
      return { text: `本机已确认会话所有者：${principal.actorId}\n${result.resource.directory ? `已确认可共享的工作目录：${result.resource.directory.path}\nWeb 编辑器按只读或读写分别授权；不提供终端。` : "尚未开放工作目录；如需 Web 编辑器，使用 /share claim --ide 并在本机确认。"}\n发送 /share invite 创建访问邀请。` };
    }
    if (/^invite$/i.test(arg.trim())) {
      const result = await call("invite");
      const next = { version: 1 as const, invites: [...this.state.invites.filter(i => i.expiresAt > Date.now()).slice(-99), { hash: hash(result.code), hostId: target.hostId, expiresAt: result.expiresAt }] };
      writeJsonFile(this.file, next, { durable: true }); this.state = next;
      return { text: `访问者在需要使用的私聊或群聊发送：\n\n/join ${result.code}\n\n邀请 24 小时有效。申请后仍需你通过 /share requests 批准。群聊中的机器人回复对群成员可见。` };
    }
    if (!arg.trim() || /^(?:requests|list)$/i.test(arg.trim())) {
      const result = await call("status");
      return { text: [`会话所有者：${result.resource.owner.actorId}`,
        "待批准申请：", ...result.requests.map((q: any) => `${q.id}\n用户：${q.principal.actorId}；聊天：${q.principal.conversationId}`),
        "有效授权：", ...result.grants.map((g: PeerGrant) => `${g.id}\n用户：${g.principal.actorId}；聊天：${g.principal.conversationId}\n权限：${g.delegation!.permissions.join(", ")}；到期：${new Date(g.delegation!.expiresAt).toISOString()}`), usage].join("\n\n") };
    }
    const decide = /^(deny|revoke)\s+([a-f0-9-]{36})$/i.exec(arg.trim());
    if (decide) {
      const result = await call(decide[1].toLowerCase(), { id: decide[2] });
      if (result.revoked) this.registry.removeSharedGrants(result.revoked);
      return { text: result.revoked ? "已撤销授权，后续请求和 Web 编辑器访问立即失效；已经开始的原生任务不会因此自动终止。" : "已拒绝访问申请。" };
    }
    const approve = /^approve\s+([a-f0-9-]{36})\s+(read|chat|control)(?:\s+--ide\s+(read|write))?(\s+--files)?(\s+--manage)?(?:\s+--hours\s+(\d+))?$/i.exec(arg.trim());
    if (!approve) return { text: usage };
    const permissions: SharedPermission[] = approve[2].toLowerCase() === "control" ? ["read", "chat", "stop", "approve"] : approve[2].toLowerCase() === "chat" ? ["read", "chat"] : ["read"];
    if (approve[3]) permissions.push("ide-read", ...(approve[3].toLowerCase() === "write" ? ["ide-write" as const] : []));
    if (approve[4]) permissions.push("files"); if (approve[5]) permissions.push("manage");
    const hours = approve[6] ? Number(approve[6]) : 24;
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) return { text: "授权有效期需为 1–168 小时。" };
    const result = await call("approve", { id: approve[1], permissions, hours });
    const grant = this.registry.addSharedGrant(result.grant);
    return { text: `已批准会话访问。\n授权 ID：${grant.id}\n权限：${grant.delegation!.permissions.join(", ")}\n到期：${new Date(grant.delegation!.expiresAt).toISOString()}\n访问者重新发送原 /join 命令即可绑定；也可以发送 /sessions 选择。\n撤销：/share revoke ${grant.id}` };
  }
  async ide(principal: PeerPrincipal, target: SharedTarget, guard: () => void): Promise<string> {
    if (!this.portal) throw new PeerError("unsupported", "共享 Web 编辑器入口尚未配置，请在 Peer 服务端配置 resources 监听地址与 publicOrigin。");
    const candidates = this.registry.grantsFor(principal).filter(g => g.hostId === target.hostId && (!g.threadId || g.threadId === target.threadId));
    const grant = candidates.find(g => g.delegation && g.threadId === target.threadId) ?? candidates[0];
    if (!grant) throw new PeerError("access", "没有此会话的授权。");
    let resourceId: string;
    if (grant.delegation) {
      if (!grant.delegation.permissions.includes("ide-read")) throw new PeerError("access", "会话所有者尚未授予 Web 编辑器权限。");
      resourceId = grant.delegation.resourceId;
    } else {
      const result = await this.registry.sharingCall(target.hostId, "status", target, principal, guard); resourceId = result.resource.id;
      if (!result.resource.directory) throw new PeerError("access", "请先通过 /share claim --ide 在本机确认工作目录。");
    }
    const ref = { principal, target, grantId: grant.id, resourceId };
    await this.workspace(ref, "workspace.list", { path: "" }); guard();
    return this.portal.entry(ref);
  }
  async workspace(ref: SharedBrowserRef, method: string, input: object): Promise<any> {
    const guard = () => {
      if (!this.registry.grantsFor(ref.principal).some(g => g.id === ref.grantId && (!g.delegation || g.delegation.resourceId === ref.resourceId)))
        throw new PeerError("access", "浏览器资源授权已撤销或过期。");
    };
    guard();
    return this.registry.sharingCall(ref.target.hostId, method, { ...ref.target, ...input, resourceId: ref.resourceId }, ref.principal, guard);
  }
  async browser(principal: PeerPrincipal, code: string): Promise<string> {
    if (!this.portal) throw new PeerError("unsupported", "共享 Web 编辑器入口尚未启用。");
    return this.portal.approve(principal, code);
  }
}
