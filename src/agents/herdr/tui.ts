import crypto from "node:crypto";
import { z } from "zod";
import { assertSameResource, assertSameReadTarget, RuntimeError, terminalOperations, type AgentRuntimeAdapter, type ResourceRef,
  type RuntimeCatalog, type RuntimeDescriptor, type RuntimeHandoff, type RuntimeInterrupt, type RuntimeOutput,
  type RuntimeResource, type RuntimeWrite, type RuntimeCreate, type RuntimeLifecycleResult } from "../contracts.js";
import type { RuntimeRpc } from "../json-line-client.js";

const agentSchema = z.object({ terminal_id: z.string().min(1), pane_id: z.string().min(1), workspace_id: z.string(),
  agent: z.string().nullable().optional(), name: z.string().nullable().optional(), title: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(), foreground_cwd: z.string().nullable().optional(),
  agent_status: z.enum(["idle", "working", "blocked", "done", "unknown"]), launch_pending: z.boolean().optional(),
  state_change_seq: z.number().int().nonnegative(), completion_seq: z.number().nullable().optional(),
  agent_session: z.object({ source: z.string(), agent: z.string(), kind: z.string(), value: z.string() }).nullable().optional()
}).passthrough();
const snapshotSchema = z.object({ type: z.literal("session_snapshot"), snapshot: z.object({ version: z.string(),
  workspaces: z.array(z.object({ workspace_id: z.string(), label: z.string(),
    worktree: z.object({ checkout_path: z.string() }).nullable().optional() }).passthrough()),
  agents: z.array(agentSchema) }).passthrough() });
type Agent = z.infer<typeof agentSchema>;

/** Uses the public JSON API. Public pane positions are looked up on every
 * operation; saved terminal ids are never sent as if the API accepted them. */
export class HerdrTuiAdapter implements AgentRuntimeAdapter {
  constructor(private readonly endpointId: string, private readonly rpc: RuntimeRpc,
    private readonly interruptKeys: Readonly<Record<string, "esc" | "ctrl+c">> = {}) {}
  async describe(): Promise<RuntimeDescriptor> {
    const info = z.object({ type: z.literal("pong"), version: z.string() }).passthrough().parse(await this.rpc.request("ping"));
    // Herdr's private endpoint protocol (22 in 0.9.5) is NOT this API's version.
    if (!/^0\.9\.\d+(?:[-+].*)?$/.test(info.version)) throw new RuntimeError("incompatible", "Herdr TUI 公共接口版本尚未验证");
    return { kind: "herdr-tui", endpointId: this.endpointId, version: info.version,
      protocol: { name: "herdr-public-jsonl" }, operations: terminalOperations({
        create: { supported: true, semantics: "workspace-or-tab-then-agent-start" },
        rename: { supported: true, semantics: "live-agent-name" },
        delete: { supported: true, semantics: "close-terminal-pane-not-archive" }, interrupt: Object.keys(this.interruptKeys).length
          ? { supported: true, semantics: "configured-agent-interrupt-key-with-state-observation" }
          : { supported: false, availability: "configuration-required", reason: "需为对应 agent 配置一个明确的中断键；不会猜测按键或强杀终端" } }) };
  }
  private async snapshot() { await this.describe(); return snapshotSchema.parse(await this.rpc.request("session.snapshot")).snapshot; }
  private resource(agent: Agent): RuntimeResource {
    const incarnation = agent.agent ? crypto.createHash("sha256").update(JSON.stringify([
      agent.terminal_id, agent.agent, agent.agent_session ?? null])).digest("hex") : undefined;
    return { ref: { endpointId: this.endpointId, id: agent.terminal_id }, kind: "terminal",
      title: agent.name || agent.title || agent.agent || agent.terminal_id, projectId: agent.workspace_id,
      cwd: agent.foreground_cwd || agent.cwd || undefined, agent: agent.agent ?? undefined,
      state: agent.launch_pending ? "unknown" : agent.agent_status, evidence: "terminal-detection",
      incarnation, identityStrength: incarnation ? "observed" : "unknown", observationSequence: agent.state_change_seq };
  }
  async catalog(): Promise<RuntimeCatalog> {
    const snapshot = await this.snapshot();
    const resources = snapshot.agents.map(a => this.resource(a));
    return { projects: snapshot.workspaces.map(w => ({ id: w.workspace_id, name: w.label,
      roots: [...new Set([w.worktree?.checkout_path, ...resources.filter(r => r.projectId === w.workspace_id).map(r => r.cwd)]
        .filter((s): s is string => !!s))] })), resources, complete: true,
      warnings: ["这里只列出 Herdr 托管的终端；终端状态检测不等于原生轮次或完整聊天历史。"] };
  }
  private async resolve(ref: ResourceRef): Promise<Agent> {
    if (ref.endpointId !== this.endpointId) throw new RuntimeError("scope", "运行接口不匹配");
    const snapshot = await this.snapshot();
    const matches = snapshot.agents.filter(a => a.terminal_id === ref.id);
    if (matches.length !== 1) throw new RuntimeError("changed", "原 Herdr 终端已不可用");
    // agent.get accepts a pane position or name, not terminal_id. Verify that
    // the current pane still denotes the terminal selected by this binding.
    const value = z.object({ type: z.literal("agent_info"), agent: agentSchema }).parse(
      await this.rpc.request("agent.get", { target: matches[0].pane_id }));
    if (value.agent.terminal_id !== ref.id) throw new RuntimeError("changed", "Herdr 面板已换成其他终端");
    return value.agent;
  }
  async inspect(ref: ResourceRef): Promise<RuntimeResource> { return this.resource(await this.resolve(ref)); }
  async read(ref: ResourceRef): Promise<RuntimeOutput> {
    const before = await this.resolve(ref);
    const value = z.object({ type: z.literal("pane_read"), read: z.object({ text: z.string(), truncated: z.boolean(), pane_id: z.string() }).passthrough() })
      .parse(await this.rpc.request("agent.read", { target: before.pane_id, source: "visible", format: "text", strip_ansi: true }));
    if (value.read.pane_id !== before.pane_id) throw new RuntimeError("changed", "Herdr 返回了其他面板的画面");
    assertSameReadTarget(this.resource(before), await this.inspect(ref));
    return { kind: "terminal-screen", ref, text: value.read.text, complete: !value.read.truncated, source: "screen" };
  }
  async send(input: RuntimeWrite & { text: string }): Promise<RuntimeHandoff> {
    if (!input.text.trim()) throw new RuntimeError("not-ready", "消息不能为空");
    const agent = await this.resolve(input.target.ref), current = this.resource(agent);
    assertSameResource(input.target, current);
    if (!["idle", "done"].includes(current.state)) throw new RuntimeError("not-ready", "Herdr 终端尚未就绪或正在等待人工处理，未发送消息");
    // No fallback to send_keys, no forced answer, no retry after ambiguous ack.
    const raw = await this.rpc.request("agent.prompt", { target: agent.pane_id, text: input.text },
      { write: true, timeoutMs: 30000, beforeWrite: input.assertCurrent, prepareWrite: async () => {
        await input.prepareWrite?.();
        const again = await this.resolve(input.target.ref), observed = this.resource(again);
        assertSameResource(input.target, observed);
        if (again.pane_id !== agent.pane_id || !["idle", "done"].includes(observed.state))
          throw new RuntimeError("changed", "输入前终端位置或状态已变化");
      } });
    const parsed = z.object({ type: z.literal("agent_prompted"), agent: agentSchema }).safeParse(raw);
    if (!parsed.success || parsed.data.agent.terminal_id !== agent.terminal_id)
      throw new RuntimeError("protocol", "Herdr 输入回执无法核对，未重发", "unknown");
    return { kind: "terminal-written", ref: current.ref, incarnation: current.incarnation!, started: null,
      observationSequence: parsed.data.agent.state_change_seq };
  }
  async interrupt(input: RuntimeWrite): Promise<RuntimeInterrupt> {
    const agent = await this.resolve(input.target.ref), current = this.resource(agent);
    assertSameResource(input.target, current);
    const key = current.agent && Object.hasOwn(this.interruptKeys, current.agent) ? this.interruptKeys[current.agent] : undefined;
    if (!key) throw new RuntimeError("unsupported", "当前 agent 未配置中断键；未发送按键或结束终端");
    if (["idle", "done", "exited"].includes(current.state)) return { kind: "not-active", ref: current.ref };
    if (current.state !== "working") throw new RuntimeError("not-ready", "终端未确认正在工作，未发送中断键");
    const raw = await this.rpc.request("pane.send_keys", { pane_id: agent.pane_id, keys: [key] }, {
      write: true, beforeWrite: input.assertCurrent, prepareWrite: async () => {
        await input.prepareWrite?.();
        const again = await this.resolve(input.target.ref), observed = this.resource(again);
        assertSameResource(input.target, observed);
        if (again.pane_id !== agent.pane_id || observed.state !== "working")
          throw new RuntimeError("changed", "中断前终端位置或状态已变化");
      }
    });
    if (!z.object({ type: z.literal("ok") }).safeParse(raw).success)
      throw new RuntimeError("protocol", "中断按键回执无法核对，未重复发送", "unknown");
    // Delivery is confirmed; subsequent loss of observation cannot turn that
    // fact into not-sent, nor authorize a second key press.
    let observation: RuntimeInterrupt["observation"] = "unknown";
    try {
      const after = await this.inspect(current.ref); assertSameResource(current, after);
      observation = after.state === "working" ? "still_working" : after.state === "exited" ? "exited"
        : ["idle", "done"].includes(after.state) ? "stopped" : "unknown";
    } catch { /* Leave the confirmed request with an unknown observed effect. */ }
    return { kind: "interrupt-requested", ref: current.ref, observation };
  }
  async create(input: RuntimeCreate): Promise<RuntimeResource> {
    await this.describe();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.title))
      throw new RuntimeError("not-ready", "TUI agent 名称须以小写字母开头，最多 32 位，仅含小写字母、数字、_、-");
    if (input.projectId) {
      const catalog = await this.catalog();
      const project = catalog.projects.find(p => p.id === input.projectId);
      if (!project || !project.roots.includes(input.cwd)) throw new RuntimeError("scope", "新终端目录不属于所选项目");
    }
    const opts = { write: true, beforeWrite: input.assertCurrent, prepareWrite: async () => {
      await input.prepareWrite?.();
      if (input.projectId && !(await this.catalog()).projects.find(p => p.id === input.projectId)?.roots.includes(input.cwd))
        throw new RuntimeError("changed", "创建前 TUI 项目目录发生变化");
    } };
    const raw = await this.rpc.request(input.projectId ? "tab.create" : "workspace.create",
      { ...(input.projectId ? { workspace_id: input.projectId } : {}), cwd: input.cwd, label: input.title, focus: false }, opts);
    const created = z.object({ type: z.enum(["workspace_created", "tab_created"]),
      root_pane: z.object({ pane_id: z.string().min(1), terminal_id: z.string().min(1) }).passthrough() }).passthrough().safeParse(raw);
    if (!created.success || created.data.type !== (input.projectId ? "tab_created" : "workspace_created"))
      throw new RuntimeError("protocol", "拓扑创建回执无法核对，未再次创建", "unknown");
    const ref = { endpointId: this.endpointId, id: created.data.root_pane.terminal_id };
    input.onCreated(ref); // synchronous durable boundary: no start if this fails
    // Shell panes are deliberately absent from agent.list/get. Inspect the
    // created pane itself until agent.start establishes an agent identity.
    const current = z.object({ type: z.literal("pane_info"), pane: z.object({ pane_id: z.string(), terminal_id: z.string(),
      cwd: z.string().nullable().optional(), foreground_cwd: z.string().nullable().optional(), agent: z.string().nullable().optional() }).passthrough() })
      .parse(await this.rpc.request("pane.get", { pane_id: created.data.root_pane.pane_id })).pane;
    if (current.terminal_id !== ref.id || current.pane_id !== created.data.root_pane.pane_id || current.agent
      || (current.foreground_cwd || current.cwd) !== input.cwd)
      throw new RuntimeError("changed", "新建面板已变化，未启动 agent");
    const result = z.object({ type: z.literal("agent_started"), agent: agentSchema }).passthrough().safeParse(
      await this.rpc.request("agent.start", { pane_id: current.pane_id, name: input.title, kind: input.program,
        args: input.args, timeout_ms: 30000 }, { ...opts, timeoutMs: 35000, prepareWrite: async () => {
          await input.prepareWrite?.();
          const again = z.object({ type: z.literal("pane_info"), pane: z.object({ terminal_id: z.string(), agent: z.string().nullable().optional(),
            cwd: z.string().nullable().optional(), foreground_cwd: z.string().nullable().optional() }).passthrough() })
            .parse(await this.rpc.request("pane.get", { pane_id: current.pane_id })).pane;
          if (again.terminal_id !== ref.id || again.agent || (again.foreground_cwd || again.cwd) !== input.cwd)
            throw new RuntimeError("changed", "启动前面板已变化");
        } }));
    if (!result.success || result.data.agent.terminal_id !== ref.id)
      throw new RuntimeError("protocol", "启动回执无法核对，未再次启动", "unknown");
    return this.resource(result.data.agent);
  }
  async rename(input: RuntimeWrite & { title: string }): Promise<RuntimeResource> {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.title)) throw new RuntimeError("not-ready", "TUI agent 名称格式无效");
    const current = await this.resolve(input.target.ref); assertSameResource(input.target, this.resource(current));
    if (current.launch_pending) throw new RuntimeError("not-ready", "Herdr agent 仍在启动，尚不能命名");
    const raw = await this.rpc.request("agent.rename", { target: current.pane_id, name: input.title },
      { write: true, beforeWrite: input.assertCurrent, prepareWrite: async () => {
        await input.prepareWrite?.(); const again = await this.resolve(input.target.ref);
        assertSameResource(input.target, this.resource(again));
        if (again.launch_pending) throw new RuntimeError("not-ready", "Herdr agent 尚未完成启动，未命名");
        if (again.pane_id !== current.pane_id) throw new RuntimeError("changed", "命名前终端面板位置已改变");
      } });
    const parsed = z.object({ type: z.literal("agent_info"), agent: agentSchema }).safeParse(raw);
    if (!parsed.success || parsed.data.agent.terminal_id !== current.terminal_id || parsed.data.agent.name !== input.title)
      throw new RuntimeError("protocol", "命名回执未确认，未重发", "unknown");
    return this.resource(parsed.data.agent);
  }
  async closeResource(input: RuntimeWrite): Promise<Extract<RuntimeLifecycleResult, { kind: "closed" }>> {
    const current = await this.resolve(input.target.ref); assertSameResource(input.target, this.resource(current));
    const result = await this.rpc.request("pane.close", { pane_id: current.pane_id },
      { write: true, beforeWrite: input.assertCurrent, prepareWrite: async () => {
        await input.prepareWrite?.(); const again = await this.resolve(input.target.ref);
        assertSameResource(input.target, this.resource(again));
        if (again.pane_id !== current.pane_id) throw new RuntimeError("changed", "关闭前终端面板位置已改变");
      } });
    if (!z.object({ type: z.literal("ok") }).safeParse(result).success)
      throw new RuntimeError("protocol", "面板关闭回执未确认", "unknown");
    return { kind: "closed", ref: input.target.ref, scope: "pane" };
  }
  close(): void { this.rpc.close(); }
}
