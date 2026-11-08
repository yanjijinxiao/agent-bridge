import type { RuntimeDescriptor } from "../agents/contracts.js";
import { CHANNEL_COMMAND_REGISTRY, parseCommand } from "./channel-commands.js";
import { channelCapabilityHelpLines, type ChannelCommandCapability } from "./channel-capability.js";
import { runtimeCommandRestriction } from "./runtime-command-policy.js";
import { RUNTIME_CREATE_USAGE } from "./runtime-lifecycle-command.js";

type CommandName = typeof CHANNEL_COMMAND_REGISTRY[number]["name"];
const sections = { session: "会话与终端", input: "输入、进度与回执", access: "权限、共享与 IDE",
  workflow: "项目与工作流", capabilities: "原生能力边界" } as const;
type Section = keyof typeof sections;
type Entry = { section: Section; usage: string; description: string };

/** Exhaustive presentation inventory. Execution stays in command policy/service;
 * aliases come from the registry and capability refusals from the same policy
 * used by dispatch. A new built-in cannot silently disappear from Herdr help. */
const entries = {
  help: { section: "session", usage: "[all|session|input|access|workflow|capabilities|命令名]", description: "查看全部、分项或单命令帮助。" },
  sessions: { section: "session", usage: "[all|more|prev|page 页码|size 5-50|search 关键词|detail R编号|unbound|project] [--host 主机ID]", description: "查看所选 Connector 的终端目录；保留空项目。all 查看已授权来源；--host 仅临时指定来源。" },
  session: { section: "session", usage: "R编号或会话ID [--host 主机ID]；/session rename 新名称；/session close --confirm", description: "绑定终端并跟随画面。rename 修改资源名称（App 要求独占标签页）；close 会结束指定终端进程，不是解绑或聊天归档。/session new 与 /new 等价。" },
  new: { section: "session", usage: "--agent 程序名 --name 名称 [--cwd 绝对目录] [-- 程序参数]", description: RUNTIME_CREATE_USAGE },
  status: { section: "session", usage: "", description: "查看绑定终端、接口、运行状态与证据。空闲或终端报告结束不代表原生任务验收成功。" },
  history: { section: "session", usage: "", description: "查看当前终端画面，不是 Codex 的历史对话翻页。" },
  follow: { section: "session", usage: "[on|off|sync]；/follow sync --retry-delivery", description: "只读跟随原终端；off 停止本聊天的跟随。控制者可明确重试原卡投递；不会重发终端输入。primary 不改写 Codex 审批路由。" },
  unbind: { section: "session", usage: "", description: "解绑当前聊天并停止本聊天跟随，不关闭终端、不停止任务。" },
  leave: { section: "session", usage: "", description: "/unbind 的兼容命令。" },
  stop: { section: "session", usage: "", description: "请求当前终端中断（controller 权限）；依据接口能力和配置执行，不把发送中断当作任务成功。" },
  prompt: { section: "input", usage: "[start|s|done|d|cancel]", description: "start 开始合并多条消息，done 一次提交，cancel 丢弃合并区；无参数查看当前合并状态。" },
  stream: { section: "input", usage: "[on|off|default]", description: "控制过程展示，最终结果仍发送；阶段成果保留，短期工具动态滚动更新。" },
  policy: { section: "input", usage: "[ask|steer|queue]", description: "查看消息处理策略。终端忙碌时不会用按键伪装插话或原生队列；不支持的设置会明确拒绝。" },
  inbox: { section: "input", usage: "", description: "查看待转发消息及原目标；已接收或回执不明的输入不会自动重发。" },
  intervene: { section: "input", usage: "编号 steer|queue|cancel", description: "处理原消息记录；编号取自提示卡，继续使用原目标和能力检查。" },
  queue: { section: "input", usage: "list；/queue cancel 队列ID；/queue 消息", description: "list/cancel 处理本聊天原队列记录；提交新消息需要原生队列接口。查看和取消原记录不因切换到 Herdr 而改变目标。" },
  steer: { section: "input", usage: "补充要求", description: "需要原生插话接口；不支持时拒绝，不暗中排队或键入终端。" },
  connect: { section: "access", usage: "[配对码|use C编号]", description: "查看本人在当前聊天已授权设备；配对需本机确认。use 只切换目录来源，不改变已绑定会话。" },
  access: { section: "access", usage: "[identity|all]", description: "查看当前聊天准入；identity 查看本人身份，管理员私聊 all 查看全部申请。使用页面提供的审批操作。" },
  role: { section: "access", usage: "[用户ID或* viewer|participant|controller]", description: "查看或设置聊天角色；viewer 只读，participant 可提交输入，controller 可中断和管理权限。修改仅限 controller。" },
  share: { section: "access", usage: "claim [--ide]；/share invite；/share requests|list；/share approve 申请ID [--ide read|write] [--files] [--hours 24]；/share revoke 授权ID", description: "会话提供者在本机确认所有权并审批准入；只授予指定会话及可选目录/文件权限。" },
  join: { section: "access", usage: "邀请码", description: "申请指定共享会话访问，等待提供者审批。" },
  ide: { section: "access", usage: "[status|identity]", description: "获取当前项目 Web IDE 入口，复用个人准入；共享访问受所有者授权限制。需要确认时使用授权页生成的完整命令。不会启动 agent 任务。" },
  approve: { section: "access", usage: "[A编号]", description: "批准原结构化审批记录；不会把 yes 输入 Herdr。终端中的交互提示须在 Herdr 内处理。" },
  reject: { section: "access", usage: "[A编号]", description: "拒绝原审批，继续使用原请求所属执行器。" },
  answer: { section: "access", usage: "[list]；/answer Q编号 回答内容；/answer Q编号 --option 1", description: "查看或回答原结构化问题；不能拿它回答终端中没有结构化请求 ID 的提示。" },
  skip: { section: "access", usage: "Q编号", description: "跳过原结构化问题，不等于批准操作。" },
  project: { section: "workflow", usage: "[l|P编号|C编号|add]；/project rename P编号|新名称；/project delete P编号", description: "查看或选择项目；rename/delete 只改 Gateway 登记，不改原生项目或磁盘目录。选项目不自动换绑终端。" },
  task: { section: "workflow", usage: "[ISSUE编号|new|todo|start|detail|comment|attach|block|review|accept|return]", description: "操作项目看板；工作说明作为普通输入交接，任务验收由看板记录。" },
  mode: { section: "workflow", usage: "[session|task|qa]", description: "查看或切换工作模式。Herdr 的 QA 结构化工具工作流尚未适配，qa 会明确拒绝。" },
  qa: { section: "workflow", usage: "", description: "依赖结构化工具调用，Herdr 终端工作流尚未适配；不改变模式或发送输入。" },
  model: { section: "capabilities", usage: "[编号|模型ID|default]", description: "需要运行接口提供结构化模型设置。" },
  effort: { section: "capabilities", usage: "[编号|级别|default]", description: "需要运行接口提供结构化推理设置。" },
  plan: { section: "capabilities", usage: "[on|off]", description: "需要运行接口提供结构化计划模式。" },
  goal: { section: "capabilities", usage: "[目标|pause|resume|complete|clear]", description: "需要运行接口提供原生目标操作。" },
  balance: { section: "capabilities", usage: "", description: "需要运行接口提供账号用量查询。" }
} satisfies Record<CommandName, Entry>;

export function runtimeHelp(descriptor: RuntimeDescriptor, topic = "", context: {
  capabilities?: readonly ChannelCommandCapability[]; taskboardAvailable?: boolean;
} = {}): string {
  const selected = topic.trim().toLowerCase().replace(/^\//, "");
  const commandName = parseCommand(`/${selected}`)?.name;
  const full = !selected || selected === "all";
  const matches = CHANNEL_COMMAND_REGISTRY.filter(command => full || command.name === commandName
    || selected !== "session" && command.aliases.some(alias => alias === selected));
  // /help session has always meant the session family, not only /session.
  const section = Object.hasOwn(sections, selected) ? selected as Section : undefined;
  const commands = section ? CHANNEL_COMMAND_REGISTRY.filter(command => entries[command.name].section === section) : matches;
  const extensionLines = (context.capabilities ?? []).filter(capability => full || capability.commandName === selected || Object.hasOwn(capability.aliases, selected));
  if (!commands.length && !extensionLines.length)
    return "帮助主题：/help all、/help session、/help input、/help access、/help workflow、/help capabilities；也可发送 /help 命令名。";
  const lines = ["Herdr 终端帮助：普通消息提交给已绑定终端；Gateway 命令不会作为终端按键执行。",
    "未注册的 /xxx 先给文字提示，再按普通消息处理；路径、引文和正文中的斜杠直接作为普通内容。注册命令即使不支持或参数错误也不会透传。",
    "以下为语法参考，方括号、竖线和“编号/内容”需要选择或填写；实际操作优先使用当前卡片按钮。"];
  for (const [key, label] of Object.entries(sections)) {
    const group = commands.filter(command => entries[command.name].section === key);
    if (!group.length) continue;
    lines.push(label);
    for (const command of group) {
      const entry = entries[command.name];
      const restriction = runtimeCommandRestriction(descriptor, { name: command.name, arg: "" });
      lines.push(`/${command.name}${entry.usage ? ` ${entry.usage}` : ""}${command.aliases.length ? `（别名 ${command.aliases.map(alias => `/${alias}`).join("、")}）` : ""}\n${entry.description}`
        + (command.name === "task" && context.taskboardAvailable === false ? "【需启用 Taskboard】" : "")
        + (restriction ? `\n${restriction}` : ""));
    }
  }
  if (extensionLines.length) lines.push("已安装扩展", ...channelCapabilityHelpLines(extensionLines));
  return lines.join("\n\n");
}
