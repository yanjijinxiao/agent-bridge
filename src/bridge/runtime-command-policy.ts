import type { RuntimeDescriptor, RuntimeOperation } from "../agents/contracts.js";
import type { ChannelCommand } from "./channel-intent.js";
import { CHANNEL_COMMAND_REGISTRY } from "./channel-commands.js";

type CommandName = typeof CHANNEL_COMMAND_REGISTRY[number]["name"];
type CommandTarget = "gateway" | "catalog" | "binding" | "record";
/** Every canonical command has an owner. Aliases normalize before this table.
 * Record-based answers retain the original request's executor even after a
 * directory selection or binding changes. This table never grants access. */
export const RUNTIME_COMMAND_TARGETS = {
  help: "binding", status: "binding", inbox: "record", balance: "binding", project: "gateway", new: "catalog",
  sessions: "gateway", session: "binding", connect: "gateway", share: "gateway", join: "gateway",
  history: "binding", ide: "gateway", access: "gateway", follow: "binding", leave: "gateway", unbind: "gateway",
  policy: "binding", role: "gateway", intervene: "record", steer: "binding", queue: "binding", model: "binding",
  effort: "binding", stream: "gateway", prompt: "gateway", approve: "record", reject: "record", answer: "record",
  skip: "record", stop: "binding", task: "gateway", mode: "binding", qa: "binding", plan: "binding", goal: "binding"
} as const satisfies Record<CommandName, CommandTarget>;

export function runtimeCommandTarget(command: ChannelCommand): CommandTarget {
  if (command.name === "session" && /^new(?:\s|$)/i.test(command.arg.trim())) return "catalog";
  if (command.name === "queue" && /^(?:list|cancel(?:\s|$))/.test(command.arg.trim())) return "record";
  return RUNTIME_COMMAND_TARGETS[command.name as CommandName] ?? "gateway";
}

/** Native operations, not product-name checks. Gateway directory, access,
 * sharing, buffering and presentation stay with their existing authorities. */
export function runtimeCommandOperation(command: ChannelCommand): RuntimeOperation | undefined {
  const direct: Record<string, RuntimeOperation> = { model: "models", effort: "settings", plan: "settings", goal: "goal",
    balance: "usage", steer: "native-steer",
    new: "create", stop: "interrupt" };
  if (direct[command.name]) return direct[command.name];
  if (command.name === "session" && /^new(?:\s|$)/i.test(command.arg.trim())) return "create";
  if (command.name === "session" && /^rename(?:\s|$)/i.test(command.arg.trim())) return "rename";
  if (command.name === "session" && /^close(?:\s|$)/i.test(command.arg.trim())) return "delete";
  if (command.name === "queue" && !/^(?:list|cancel(?:\s|$))/.test(command.arg.trim())) return "native-queue";
  if (command.name === "policy" && command.arg.trim() === "queue") return "native-queue";
  if (command.name === "policy" && command.arg.trim() === "steer") return "native-steer";
  if (command.name === "intervene" && /\s(steer|queue)$/.test(command.arg.trim()))
    return command.arg.trim().endsWith("queue") ? "native-queue" : "native-steer";
  return undefined;
}

export function runtimeCommandRestriction(descriptor: RuntimeDescriptor, command: ChannelCommand): string | undefined {
  const operation = runtimeCommandOperation(command), support = operation && descriptor.operations[operation];
  if (!support || support.supported) return;
  const boundary = support.availability === "not-adapted" ? "这项接口的业务适配尚未完成"
    : support.availability === "configuration-required" ? "这项操作尚未配置"
      : "此运行接口没有提供等价的结构化操作";
  return `/${command.name}：${boundary}。${support.reason}。未发送终端按键，也未切换执行器。`;
}

export function runtimeHelp(descriptor: RuntimeDescriptor): string {
  const unavailable = ["model", "effort", "plan", "goal", "balance", "steer", "queue"].flatMap(name => {
    const reason = runtimeCommandRestriction(descriptor, { name, arg: "" }); return reason ? [reason] : [];
  });
  return ["当前连接管理终端资源，普通消息是终端输入，状态与画面不是原生任务完成回执。/help 查看命令说明。",
    "/sessions、/project 查看目录；/session 绑定；/status 核对状态；/history 查看当前终端画面。",
    "/connect、/access、/role、/share、/join、/unbind、/leave、/ide 保持各自的授权范围。",
    "/prompt 合并输入；/follow on|off|sync 只读跟随；/stream 控制过程展示；/stop 按运行接口的中断能力处理。",
    "/new 显式选择程序与目录新建终端；/session rename 修改名称；/session close --confirm 结束指定终端进程。关闭不会归档聊天。",
    "/task 查看和操作看板；工作说明按普通消息交接，任务验收仍由看板记录。/mode session|task 切换工作模式。",
    "/inbox、/queue list|cancel、/intervene 处理原消息记录；/approve、/reject、/answer、/skip 处理原请求，不因切换目录转投其他执行器。",
    "/policy 查看消息处理方式。终端运行中不把按键当作插话或原生排队；/qa 需要原生动态检索工具接口，当前终端接口未提供。",
    "能力边界：\n" + unavailable.join("\n")].join("\n\n");
}
