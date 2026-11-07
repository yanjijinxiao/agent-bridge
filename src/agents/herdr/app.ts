import crypto from "node:crypto";
import { z } from "zod";
import { assertSameResource, assertSameReadTarget, RuntimeError, terminalOperations, type AgentRuntimeAdapter, type ResourceRef,
  type RuntimeCatalog, type RuntimeDescriptor, type RuntimeHandoff, type RuntimeInterrupt, type RuntimeOutput,
  type RuntimeResource, type RuntimeWrite, type RuntimeCreate, type RuntimeLifecycleResult } from "../contracts.js";
import type { RuntimeRpc } from "../json-line-client.js";
import type { HerdrAppView } from "./app-view.js";
import { verifiedAppSpaces } from "./app-layout.js";
import { herdrFileHost } from "./file-host.js";
import { runtimeFilesystemScope } from "../filesystem-scope.js";

const terminalSchema = z.object({ address: z.string().min(1), name: z.string().nullable().optional(), cwd: z.string(),
  state: z.enum(["live", "finished"]), pid: z.number().nullable(), created_ms: z.number(), turn: z.number().int().nonnegative(),
  foreground: z.object({ pid: z.number(), name: z.string(), argv: z.array(z.string()), cwd: z.string() }).nullable().optional(),
  status: z.object({ state: z.string(), app: z.string().optional(), kind: z.string().optional() }).nullable(),
  screen: z.string(), title: z.string().optional() }).passthrough();
type Terminal = z.infer<typeof terminalSchema>;

/** App directory + its explicitly configured core. Never launches a second
 * core or silently substitutes another endpoint when the window is offline. */
export class HerdrAppAdapter implements AgentRuntimeAdapter {
  private coreId?: string;
  constructor(private readonly endpointId: string, private readonly rpc: RuntimeRpc, private readonly view: HerdrAppView,
    private readonly expectedCoreId: string) {}
  async describe(): Promise<RuntimeDescriptor> {
    const hello = z.object({ generation: z.literal(1), version: z.string(),
      core: z.object({ id: z.string().min(1) }), methods: z.array(z.string()) }).passthrough().safeParse(
        await this.rpc.request("hello", { generation: 1, framed: false }));
    if (!hello.success) throw new RuntimeError("incompatible", "Herdr App 执行接口 generation 不兼容");
    const info = hello.data;
    if (info.core.id !== this.expectedCoreId || this.coreId && info.core.id !== this.coreId)
      throw new RuntimeError("changed", "Herdr App 执行核心身份发生变化");
    this.coreId = info.core.id;
    const operations = terminalOperations({
      create: this.view.command ? { supported: true, semantics: "explicit-app-space-or-tab-launch" }
        : { supported: false, availability: "configuration-required", reason: "App 窗口未连接生命周期控制接口" },
      rename: this.view.command ? { supported: true, semantics: "single-terminal-tab-name" }
        : { supported: false, availability: "configuration-required", reason: "App 窗口未连接命名接口" },
      delete: { supported: info.methods.includes("terminal.kill"), ...(info.methods.includes("terminal.kill")
        ? { semantics: "terminate-terminal-process" } : { reason: "core 未提供 terminal.kill" }) } as RuntimeDescriptor["operations"]["delete"]
    });
    const required = { catalog: "terminal.list", inspect: "terminal.get", read: "terminal.read", send: "terminal.send", interrupt: "terminal.interrupt" } as const;
    for (const [operation, method] of Object.entries(required)) if (!info.methods.includes(method))
      operations[operation as keyof typeof required] = { supported: false, reason: `当前 core 未提供 ${method}` };
    return { kind: "herdr-app", endpointId: this.endpointId, serverId: this.coreId, version: info.version,
      protocol: { name: "herdr-core-jsonrpc", generation: 1 }, operations };
  }
  private async require(operation: "catalog" | "inspect" | "read" | "send" | "interrupt") {
    const descriptor = await this.describe();
    if (!descriptor.operations[operation].supported) throw new RuntimeError("unsupported", `Herdr App 不支持 ${operation}`);
  }
  private resource(t: Terminal): RuntimeResource {
    // holder and program_started_ms are PRIVATE core fields and absent from
    // Public. Use available process observations, explicitly below native CAS.
    const incarnation = t.pid && t.foreground ? crypto.createHash("sha256").update(JSON.stringify([
      this.coreId, t.address, t.created_ms, t.pid, t.foreground.pid, t.foreground.argv])).digest("hex") : undefined;
    const word = t.status?.state;
    const state = t.state === "finished" ? "exited" : ["idle", "working", "blocked", "done", "error"].includes(word ?? "")
      ? word as RuntimeResource["state"] : "unknown";
    return { ref: { endpointId: this.endpointId, id: t.address }, kind: "terminal", title: t.name || t.title || t.address,
      cwd: t.foreground?.cwd || t.cwd, machine: t.address.includes("/") ? t.address.slice(0, t.address.lastIndexOf("/")) : undefined,
      state, agent: t.status?.app || undefined, evidence: t.state === "finished" ? "process-exit" : t.status ? "program-report" : "unknown",
      incarnation, identityStrength: incarnation ? "observed" : "unknown", observationSequence: t.turn, blockedKind: t.status?.kind };
  }
  async catalog(): Promise<RuntimeCatalog> {
    await this.require("catalog");
    const [window, raw] = await Promise.all([this.view.list(), this.rpc.request("terminal.list", { all: true })]);
    const views = await verifiedAppSpaces(this.rpc, window);
    const listed = z.object({ terminals: z.array(terminalSchema), machines: z.array(z.unknown()).optional() }).passthrough().parse(raw);
    const resources = listed.terminals.map(t => this.resource(t));
    const projects = views.spaces.filter((s, i, all) => all.findIndex(other => other.id === s.id) === i)
      .map(s => ({ id: s.id, name: s.name, roots: s.folder && views.spaces.filter(other => other.id === s.id).length === 1 ? [s.folder] : [], machine: s.machine ?? undefined }));
    const warnings = ["终端画面不是完整对话；状态来自程序报告，不能代替原生任务回执。", ...views.warnings];
    let complete = !views.warnings.length;
    const owners = new Map<string, typeof views.spaces>();
    for (const space of views.spaces) for (const terminal of new Set(space.tabs.flatMap(tab => tab.terminals.map(t => t.terminal)))) {
      owners.set(terminal, [...owners.get(terminal) ?? [], space]);
      if (!resources.some(r => r.ref.id === terminal)) { complete = false; warnings.push(`空间 ${space.name} 的终端 ${terminal} 当前不可见`); }
    }
    // A directory and direct inspection must agree on ownership. Keep an
    // ambiguous terminal visible but unassigned; never choose the first space
    // as a source of binding or filesystem authority.
    for (const resource of resources) {
      const spaces = owners.get(resource.ref.id) ?? [];
      if (spaces.length > 1) { complete = false; warnings.push(`终端 ${resource.ref.id} 出现在多个空间，归属未确认`); }
      else if (spaces.length && (spaces[0].machine ?? undefined) !== resource.machine) {
        complete = false; warnings.push(`终端 ${resource.ref.id} 与空间所属机器不一致`);
      } else if (spaces.length) {
        resource.projectId = spaces[0].id;
        const tab = spaces[0].tabs.find(t => t.terminals.length === 1 && t.terminals[0].terminal === resource.ref.id);
        if (tab?.name) resource.title = tab.name;
      }
    }
    // Remote list failures are not an empty complete directory. The core's
    // machine views vary by version, so do not assert completeness for them.
    if (listed.machines?.length) { complete = false; warnings.push("包含远程机器，目录完整性需逐主机核验。"); }
    return { projects, resources, complete, warnings };
  }
  async inspect(ref: ResourceRef): Promise<RuntimeResource> {
    if (ref.endpointId !== this.endpointId) throw new RuntimeError("scope", "运行接口不匹配");
    await this.require("inspect");
    const terminal = terminalSchema.parse(await this.rpc.request("terminal.get", { terminal: ref.id }));
    if (terminal.address !== ref.id) throw new RuntimeError("changed", "Herdr 返回了不同终端");
    const resource = this.resource(terminal);
    // terminal.get knows process state, not App project membership. Binding
    // and IDE inspect resources independently of the directory page, so carry
    // membership from a fresh App layout instead of losing it on inspection.
    const view = await verifiedAppSpaces(this.rpc, await this.view.list());
    const owners = view.spaces.filter(s => s.tabs.some(tab => tab.terminals.some(t => t.terminal === ref.id)));
    if (owners.length > 1) throw new RuntimeError("changed", "终端同时属于多个空间，项目归属未确认");
    if (owners[0]) {
      if ((owners[0].machine ?? undefined) !== resource.machine)
        throw new RuntimeError("changed", "终端与空间所属机器不一致");
      resource.projectId = owners[0].id;
      const tab = owners[0].tabs.find(t => t.terminals.length === 1 && t.terminals[0].terminal === ref.id);
      if (tab?.name) resource.title = tab.name;
    }
    return resource;
  }
  async read(ref: ResourceRef): Promise<RuntimeOutput> {
    const before = await this.inspect(ref); await this.require("read");
    const result = z.object({ text: z.string(), complete: z.boolean(), how: z.literal("screen") }).passthrough().parse(
      await this.rpc.request("terminal.read", { terminal: ref.id, lines: 0 }));
    const after = await this.inspect(ref);
    assertSameReadTarget(before, after);
    return { kind: "terminal-screen", ref, text: result.text, complete: result.complete, source: "screen" };
  }
  async fileHost(ref: ResourceRef) {
    const expected = await this.inspect(ref);
    if (!expected.machine) return undefined;
    const scope = runtimeFilesystemScope(expected);
    return herdrFileHost(this.rpc, this.endpointId, expected.machine, scope, async () => {
      if (runtimeFilesystemScope(await this.inspect(ref)) !== scope)
        throw new RuntimeError("changed", "文件资源所属机器、项目或目录已改变");
    });
  }
  async send(input: RuntimeWrite & { text: string }): Promise<RuntimeHandoff> {
    if (!input.text.trim()) throw new RuntimeError("not-ready", "消息不能为空");
    await this.require("send");
    const current = await this.inspect(input.target.ref); assertSameResource(input.target, current);
    if (!["idle", "done"].includes(current.state) || !current.agent) throw new RuntimeError("not-ready", "终端未报告 agent 就绪，未发送消息");
    // A completed agent can accept its next prompt without returning to idle.
    // Core's public only_if enum has idle/working, not done. Keep its exact idle
    // check when available; for done use our last read and the native blocked
    // guard (force=false). This does not manufacture an atomic done-state CAS.
    const result = z.object({ turn: z.number().int().nonnegative(), started: z.boolean().nullable() }).passthrough().safeParse(
      await this.rpc.request("terminal.send", { terminal: current.ref.id, text: input.text, force: false,
        ...(current.state === "idle" ? { if: "idle" } : {}), wait: false },
        { write: true, timeoutMs: 30000, beforeWrite: input.assertCurrent, prepareWrite: async () => {
          await input.prepareWrite?.();
          const again = await this.inspect(input.target.ref); assertSameResource(input.target, again);
          if (!["idle", "done"].includes(again.state) || !again.agent) throw new RuntimeError("not-ready", "输入前终端已不再空闲或完成");
        } }));
    if (!result.success) throw new RuntimeError("protocol", "Herdr 输入回执无法核对，未重发", "unknown");
    return { kind: "terminal-written", ref: current.ref, incarnation: current.incarnation!, started: result.data.started,
      observationSequence: result.data.turn };
  }
  async interrupt(input: RuntimeWrite): Promise<RuntimeInterrupt> {
    await this.require("interrupt");
    const current = await this.inspect(input.target.ref); assertSameResource(input.target, current);
    if (["idle", "done", "exited"].includes(current.state)) return { kind: "not-active", ref: current.ref };
    if (current.state !== "working") throw new RuntimeError("not-ready", "终端状态不明确，未发送中断按键");
    const parsed = z.object({ outcome: z.enum(["stopped", "exited", "still_working", "unknown"]), key: z.string() }).safeParse(
      await this.rpc.request("terminal.interrupt", { terminal: current.ref.id, timeout: 5 },
        { write: true, timeoutMs: 10000, beforeWrite: input.assertCurrent, prepareWrite: async () => {
          await input.prepareWrite?.();
          const again = await this.inspect(input.target.ref); assertSameResource(input.target, again);
          if (again.state !== "working") throw new RuntimeError("not-ready", "中断前终端已不再报告运行中");
        } }));
    if (!parsed.success) throw new RuntimeError("protocol", "中断结果无法核对", "unknown");
    // Even stopped means left working; it does not prove task cancellation.
    return { kind: "interrupt-requested", ref: current.ref, observation: parsed.data.outcome };
  }
  async create(input: RuntimeCreate): Promise<RuntimeResource> {
    await this.describe();
    if (!this.view.command) throw new RuntimeError("unsupported", "App 窗口控制接口未连接");
    const view = await verifiedAppSpaces(this.rpc, await this.view.list());
    const project = input.projectId ? view.spaces.find(s => s.id === input.projectId) : undefined;
    if (input.projectId && (!project || project.folder !== input.cwd || view.warnings.length))
      throw new RuntimeError("scope", "创建目录与 App 项目未核对一致");
    const result = z.object({ space: z.string().min(1), tab: z.string().min(1), terminal: z.string().min(1) }).safeParse(
      await this.view.command(project ? "tab.new" : "space.new", { name: input.title, folder: input.cwd,
        argv: [input.program, ...input.args], ...(project ? { space: project.id } : { machine: null, tab: input.title }) },
        { write: true, beforeWrite: input.assertCurrent, prepareWrite: async () => {
          await input.prepareWrite?.();
          if (project) {
            const current = await verifiedAppSpaces(this.rpc, await this.view.list());
            const again = current.spaces.find(s => s.id === project.id);
            if (current.warnings.length || !again || again.folder !== input.cwd || again.machine !== project.machine)
              throw new RuntimeError("changed", "创建前 App 项目的目录或机器发生变化");
          }
        } }));
    if (!result.success || project && result.data.space !== project.id)
      throw new RuntimeError("protocol", "App 创建回执无法核对", "unknown");
    const ref = { endpointId: this.endpointId, id: result.data.terminal };
    input.onCreated(ref);
    const resource = await this.inspect(ref);
    if (resource.cwd !== input.cwd || resource.projectId !== result.data.space || resource.machine !== (project?.machine ?? undefined))
      throw new RuntimeError("changed", "已创建终端的目录或项目未核对一致", "unknown");
    return resource;
  }
  async rename(input: RuntimeWrite & { title: string }): Promise<RuntimeResource> {
    if (!this.view.command) throw new RuntimeError("unsupported", "App 窗口控制接口未连接");
    assertSameResource(input.target, await this.inspect(input.target.ref));
    const view = await verifiedAppSpaces(this.rpc, await this.view.list());
    const tabs = view.spaces.flatMap(s => s.tabs).filter(t => t.terminals.some(r => r.terminal === input.target.ref.id));
    if (tabs.length !== 1 || tabs[0].terminals.length !== 1 || !tabs[0].id)
      throw new RuntimeError("unsupported", "此终端不独占一个标签页；App 只能命名标签页，未修改其他终端的名称");
    const raw = await this.view.command("tab.rename", { id: tabs[0].id, name: input.title },
      { write: true, beforeWrite: input.assertCurrent, prepareWrite: async () => {
        await input.prepareWrite?.(); assertSameResource(input.target, await this.inspect(input.target.ref));
        const latest = await verifiedAppSpaces(this.rpc, await this.view.list());
        const now = latest.spaces.flatMap(s => s.tabs).filter(t => t.terminals.some(r => r.terminal === input.target.ref.id));
        if (now.length !== 1 || now[0].id !== tabs[0].id || now[0].terminals.length !== 1)
          throw new RuntimeError("changed", "命名前标签页的终端归属已改变");
      } });
    if (!z.object({ ok: z.literal(true) }).safeParse(raw).success)
      throw new RuntimeError("protocol", "App 标签页命名回执未确认", "unknown");
    const result = await this.inspect(input.target.ref);
    if (result.title !== input.title) throw new RuntimeError("changed", "App 标签页名称未核对一致", "unknown");
    return result;
  }
  async closeResource(input: RuntimeWrite): Promise<Extract<RuntimeLifecycleResult, { kind: "closed" }>> {
    const info = await this.describe();
    if (!info.operations.delete.supported) throw new RuntimeError("unsupported", "core 没有终端关闭接口");
    assertSameResource(input.target, await this.inspect(input.target.ref));
    const result = terminalSchema.safeParse(await this.rpc.request("terminal.kill", { terminal: input.target.ref.id },
      { write: true, beforeWrite: input.assertCurrent, prepareWrite: async () => {
        await input.prepareWrite?.(); assertSameResource(input.target, await this.inspect(input.target.ref));
      } }));
    if (!result.success || result.data.address !== input.target.ref.id || result.data.state !== "finished")
      throw new RuntimeError("protocol", "终端关闭回执未确认", "unknown");
    return { kind: "closed", ref: input.target.ref, scope: "terminal-process" };
  }
  close(): void { this.rpc.close(); this.view.close?.(); }
}
