import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJsonFile } from "../state/json-store.js";
import { channelPrincipalSchema, type ChannelPrincipal } from "../channels/principal.js";
import type { ChannelMessage } from "../channels/message.js";
import { createChoiceCard, type ChannelActionCard } from "../channels/action-card.js";
import { copyBlock } from "../channels/copyable.js";

const id = z.string().regex(/^[a-f0-9]{12}$/);
const observationSchema = z.object({ id, version: z.string().regex(/^[a-f0-9]{64}$/), principal: channelPrincipalSchema,
  conversationId: z.string().min(1).max(500), kind: z.enum(["direct", "group"]),
  createdAt: z.number().safe(), expiresAt: z.number().safe(), phase: z.enum(["pending", "applying", "dismissed"]) }).strict();
export type AdmissionRequest = z.infer<typeof observationSchema>;
/** Presentation of existing ACL facts, never a separate source of authority.
 * IDE eligibility is read separately because group/config-only IM admission
 * does not enroll a personal browser identity. */
export type AdmissionAccessStatus = { personal: boolean; conversation: boolean; ide: boolean | null };
const schema = z.object({ version: z.literal(1), admins: z.array(channelPrincipalSchema).max(50),
  observations: z.array(observationSchema).max(500) }).strict();
const key = (p: ChannelPrincipal) => JSON.stringify([p.accountId, p.channel, p.providerId, p.actorId]);
export const admissionVersion = z.string().regex(/^[a-f0-9]{64}$/);
export const admissionId = id;
export class AdmissionConflictError extends Error {}

/** Administrative admission is separate from chat participation, session roles,
 * native tool approvals and browser pairing. Only local management enrolls admins.
 * Web and IM decisions call the existing ACL owner; this is never a second ACL.
 */
export class AdmissionService {
  private readonly file: string;
  private state: z.infer<typeof schema> = { version: 1, admins: [], observations: [] };
  error?: string;
  constructor(private readonly options: { root: string; accounts: () => { accountId: string; channel: string; providerId: string }[];
    allowed: (accountId: string, actorId: string, conversationId: string) => boolean;
    accessStatus?: (principal: ChannelPrincipal, conversationId: string) => AdmissionAccessStatus;
    allow: (accountId: string, target: string) => void; now?: () => number }) {
    this.file = path.join(options.root, "admission.json");
    try {
      this.state = schema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
      if (new Set(this.state.observations.map(r => r.id)).size !== this.state.observations.length) throw Error("duplicate request");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = "准入审批记录无法读取，远程准入审批已关闭；原文件未覆盖。";
    }
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private valid(p: ChannelPrincipal) { return this.options.accounts().some(a => a.accountId === p.accountId && a.channel === p.channel && a.providerId === p.providerId); }
  private assertReady() { if (this.error) throw Error(this.error); }
  private save(next: typeof this.state) { this.assertReady(); writeJsonFile(this.file, next, { durable: true }); this.state = next; }
  private current(r: AdmissionRequest) { return r.expiresAt > this.now() && this.valid(r.principal); }
  private allowed(r: AdmissionRequest) { return this.options.allowed(r.principal.accountId, r.principal.actorId, r.conversationId); }
  isAdmin(p: ChannelPrincipal) { return !this.error && this.valid(p) && this.state.admins.some(a => key(a) === key(p)); }
  snapshot() {
    if (this.error) return { admins: [], candidates: [], requests: [], error: this.error };
    const rows = this.state.observations.filter(r => this.current(r));
    return structuredClone({ admins: this.state.admins, candidates: rows,
      requests: rows.filter(r => r.phase !== "dismissed" && !this.allowed(r)) });
  }
  observe(principal: ChannelPrincipal, conversationId: string, kind: "direct" | "group") {
    this.assertReady(); principal = channelPrincipalSchema.parse(principal);
    if (!this.valid(principal) || kind === "group" && principal.actorId === conversationId) throw Error("无法核验真实用户与渠道账号");
    const existing = this.state.observations.find(r => key(r.principal) === key(principal) && r.conversationId === conversationId && r.kind === kind && this.current(r) && r.phase !== "dismissed");
    if (existing) return structuredClone(existing);
    let requestId: string;
    do { requestId = crypto.randomBytes(6).toString("hex"); } while (this.state.observations.some(r => r.id === requestId));
    const record = observationSchema.parse({ id: requestId, version: crypto.randomBytes(32).toString("hex"),
      principal, conversationId, kind, createdAt: this.now(), expiresAt: this.now() + 24 * 60 * 60_000, phase: "pending" });
    const current = this.state.observations.filter(r => this.current(r));
    const open = current.filter(r => r.phase !== "dismissed");
    if (open.length >= 500 || open.filter(r => key(r.principal) === key(principal)).length >= 8) throw Error("准入申请已达上限，请管理员先处理");
    // Completed tickets are revocation tombstones, not active capacity. Evict
    // only these when space is needed; applying/unknown grants remain retained.
    const room = 499 - open.length;
    const completed = room > 0 ? current.filter(r => r.phase === "dismissed").slice(-room) : [];
    this.save({ ...this.state, observations: [...completed, ...open, record] }); return structuredClone(record);
  }
  private request(requestId: string, version: string) {
    this.assertReady(); const r = this.state.observations.find(r => r.id === requestId && r.version === version && this.current(r));
    if (!r || r.phase !== "pending") throw new AdmissionConflictError("申请已处理、过期或渠道已改变，请重新查看申请。");
    return r;
  }
  setAdmin(requestId: string, version: string) {
    const r = this.request(requestId, version), admins = this.state.admins.filter(a => key(a) !== key(r.principal));
    if (admins.length >= 50) throw Error("准入审批管理员已达上限");
    this.save({ ...this.state, admins: [...admins, r.principal] });
  }
  forgetAccount(accountId: string) {
    this.save({ ...this.state, admins: this.state.admins.filter(a => a.accountId !== accountId),
      observations: this.state.observations.filter(r => r.principal.accountId !== accountId) });
  }
  removeAdmin(principal: ChannelPrincipal) {
    this.save({ ...this.state, admins: this.state.admins.filter(a => key(a) !== key(channelPrincipalSchema.parse(principal))) });
  }
  decideLocal(requestId: string, version: string, choice: "actor" | "conversation" | "deny") {
    return this.applyChoice(requestId, version, choice);
  }
  decideRemote(admin: ChannelPrincipal, requestId: string, version: string, choice: "actor" | "conversation" | "deny") {
    if (!this.isAdmin(admin)) throw Error("仅本渠道已指定的准入审批管理员可以处理");
    return this.applyChoice(requestId, version, choice, admin);
  }
  private applyChoice(requestId: string, version: string, choice: "actor" | "conversation" | "deny", admin?: ChannelPrincipal) {
    const r = this.request(requestId, version);
    if (admin && (admin.accountId !== r.principal.accountId || admin.channel !== r.principal.channel || admin.providerId !== r.principal.providerId))
      throw Error("不能跨渠道账号处理准入申请");
    if (this.allowed(r)) throw new AdmissionConflictError("此用户或会话已经获准，请刷新。");
    if (choice === "conversation" && r.kind !== "group") throw Error("此申请不是已核验的群聊，不能授权整个会话");
    // Persist the dispatch boundary before touching the existing ACL. A crash or
    // write failure must never replay an unconfirmed grant on restart.
    const replace = (phase: AdmissionRequest["phase"]) => ({ ...this.state, observations: this.state.observations.map(x => x.id === r.id ? { ...x, phase } : x) });
    this.save(replace(choice === "deny" ? "dismissed" : "applying"));
    if (choice !== "deny") {
      try {
        this.options.allow(r.principal.accountId, choice === "actor" ? r.principal.actorId : r.conversationId);
        this.save(replace("dismissed"));
      } catch {
        throw Error("这次准入授权结果未确认，未自动重试。请在本机账号授权中核对该用户或群，勿重复批准其他申请。");
      }
    }
    return choice === "deny" ? "已拒绝此准入申请，未修改访问权限。" : choice === "actor"
      ? `已仅允许用户 ${r.principal.actorId}，可使用 IM 并为本人浏览器配对 IDE；没有授予准入审批管理员权限。请申请人重新发送原消息。`
      : `已允许整个群聊 ${r.conversationId} 的成员使用 IM；不授予个人 IDE 配对资格。请申请人重新发送原消息。`;
  }
  notice(r: AdmissionRequest, all = false): ChannelActionCard {
    const suffix = all ? " --all" : "";
    const body = `渠道账号：${r.principal.accountId}\n用户：${r.principal.actorId}\n来源${r.kind === "group" ? "群聊" : "私聊"}：${r.conversationId}\n用户准入包含 IM 使用和本人 IDE 浏览器配对资格；不含管理员权限。整个群聊准入只允许 IM，覆盖其他群成员。`;
    const choices = [{ label: "仅允许此用户", choice: "actor", confirm: "允许该用户使用 Codex 和本人 Web IDE 配对？" },
      ...(r.kind === "group" ? [{ label: "允许整个群聊", choice: "conversation", confirm: "群内所有成员都将获得 IM 使用权限，继续？" }] : []),
      { label: "拒绝", choice: "deny", confirm: "拒绝此准入申请？" }];
    return createChoiceCard({ title: `Gateway 准入申请 ${r.id}`, body, note: "只处理这条申请，不执行或重发申请人的消息。24 小时内有效。",
      fallbackText: [body, ...choices.map(c => `${c.label}\n\n${copyBlock(`/access ${c.choice} ${r.id} ${r.version}${suffix}`)}`)].join("\n\n"),
      choices: choices.map(c => ({ label: c.label, command: "access", arg: `${c.choice} ${r.id} ${r.version}${suffix}`, confirm: c.confirm,
        style: c.choice === "deny" ? "danger" : "default" })) });
  }
  private personalStatus(p: ChannelPrincipal, conversationId: string, kind: "direct" | "group"): string {
    const admitted = this.options.allowed(p.accountId, p.actorId, conversationId);
    const status = this.options.accessStatus?.(p, conversationId);
    const sources = status ? [status.personal ? "个人授权" : "", kind === "group" && status.conversation ? "本群授权" : ""].filter(Boolean) : [];
    return ["本人在当前聊天的权限", `IM 准入：${admitted ? "已获准" : "未获准"}`,
      `授权来源：${sources.length ? sources.join("、") : admitted ? "已有准入记录" : "无"}`,
      `本人 Web IDE 配对资格：${status?.ide == null ? "暂未核验" : status.ide ? "已获准（浏览器首次确认本人，之后自动信任有权访问的项目）" : "未获准"}`,
      `准入审批管理员：${this.isAdmin(p) ? "是" : "否"}`].join("\n");
  }
  /** List, details and decisions share this boundary, including old/copied
   * cards. A global admin's authority alone never publishes other chats into
   * this group; cross-chat management requires explicit private invocation. */
  private inCommandScope(r: AdmissionRequest, p: ChannelPrincipal, conversationId: string, kind: "direct" | "group", admin: boolean, all: boolean): boolean {
    return r.principal.accountId === p.accountId && r.principal.channel === p.channel && r.principal.providerId === p.providerId
      && (all || r.conversationId === conversationId && r.kind === kind)
      && (admin || key(r.principal) === key(p));
  }
  command(p: ChannelPrincipal, conversationId: string, kind: "direct" | "group", arg: string): string | ChannelActionCard {
    this.assertReady();
    if (!this.valid(p)) throw Error("渠道账号已改变，请重新核验身份");
    const parts = arg.trim().split(/\s+/).filter(Boolean);
    if (parts[0] === "identity" && parts.length === 1) {
      this.observe(p, conversationId, kind);
      return `准入审批身份：${p.actorId}\n渠道账号：${p.accountId}\n${this.isAdmin(p) ? "已登记为本渠道准入审批管理员。/access 查看当前聊天；在机器人私聊发送 /access all 查看本渠道申请。" : "尚未登记为准入审批管理员。请在本机 Gateway「待审批 → 远程准入管理员」选中此身份登记一次；以后可在钉钉处理，无需访问本机页面。"}`;
    }
    const admin = this.isAdmin(p), all = parts[0] === "all" || parts.includes("--all");
    if (all) {
      if (!admin) throw Error("仅准入审批管理员可以查看全部申请。");
      if (kind !== "direct") throw Error("跨聊天准入管理仅限机器人私聊，请在私聊发送 /access all。");
    }
    const inScope = (r: AdmissionRequest) => this.inCommandScope(r, p, conversationId, kind, admin, all);
    if (!parts.length || parts.length === 1 && ["list", "all"].includes(parts[0])) {
      const rows = this.snapshot().requests.filter(inScope), suffix = all ? " --all" : "";
      return [this.personalStatus(p, conversationId, kind),
        all ? "本渠道全部待处理申请（管理员私聊）" : admin ? "当前聊天待处理申请" : "本人在当前聊天的申请",
        ...(rows.length ? rows.slice(0, 10).map(r => `${r.principal.actorId} · ${r.kind === "group" ? "群聊" : "私聊"} ${r.conversationId}\n${r.phase === "applying" ? `申请 ${r.id}：上次授权结果未确认，请在本机核对。` : copyBlock(`/access show ${r.id}${suffix}`)}`) : ["暂无待处理申请。"]),
        ...(rows.length > 10 ? ["仅展示前 10 条；处理后再查看。"] : []),
        ...(admin && !all ? ["跨聊天管理请在机器人私聊发送 /access all。"] : [])].join("\n\n");
    }
    const detail = parts[0] === "show", decision = ["actor", "conversation", "deny"].includes(parts[0]);
    const count = detail ? 2 : 3;
    if ((!detail && !decision) || !(parts.length === count || parts.length === count + 1 && parts[count] === "--all"))
      throw Error("用法：/access 查看当前聊天权限与申请；管理员在私聊使用 /access all；从申请详情操作。");
    if (decision && !admin) return "你没有准入审批管理员权限。个人准入、群授权和会话 controller 不能代替管理员资格。";
    const r = this.state.observations.find(r => r.id === parts[1] && inScope(r));
    if (!r) throw new AdmissionConflictError("申请不在当前可查看范围，或已经失效。");
    if (detail) {
      const current = this.request(r.id, r.version);
      return admin ? this.notice(current, all) : `本人当前聊天的准入申请 ${current.id}\n状态：等待管理员处理。`;
    }
    return this.decideRemote(p, r.id, parts[2], parts[0] as "actor" | "conversation" | "deny");
  }
}

export function admissionPrincipal(accountId: string | undefined, providerId: string | undefined, channel: string, message: ChannelMessage): ChannelPrincipal | undefined {
  if (!accountId || !providerId || !["direct", "group"].includes(message.conversationKind ?? "")
    || message.conversationKind === "group" && (!message.replyTargetId || message.senderId === message.replyTargetId)) return;
  return channelPrincipalSchema.safeParse({ accountId, providerId, channel, actorId: message.senderId }).data;
}
