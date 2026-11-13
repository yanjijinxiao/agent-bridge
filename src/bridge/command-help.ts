import type { RuntimeDescriptor } from "../agents/contracts.js";
import type { CodexBackendCapabilities } from "../codex/backend.js";
import type { ProjectInteractionMode } from "../channels/channel-mode-settings.js";
import type { ChannelChoice } from "../channels/action-card.js";
import { channelCapabilityHelpLines, type ChannelCommandCapability } from "./channel-capability.js";
import { CHANNEL_COMMAND_ALIASES, CHANNEL_COMMAND_REGISTRY, HELP_SECTIONS, type ChannelCommandDefinition, type HelpSection } from "./channel-command-registry.js";
import { runtimeCommandRestriction } from "./runtime-command-policy.js";
import { requiredModeForCommand } from "./channel-command-policy.js";

export type CommandHelpContext = {
  backendCapabilities?: CodexBackendCapabilities;
  runtime?: RuntimeDescriptor;
  taskboardAvailable?: boolean;
  enabledModes?: readonly ProjectInteractionMode[];
  qaAvailable?: boolean;
};
type HelpSelection = { kind: "home" | "all" | "section" | "command"; value?: string };
const definitions: readonly ChannelCommandDefinition[] = CHANNEL_COMMAND_REGISTRY;

/** Topic parsing is presentation-only. A leading slash disambiguates a command
 * from a family: /help session is the family; /help /session is the command. */
export function selectCommandHelp(topic: string): HelpSelection {
  const input = topic.trim().toLowerCase();
  if (!input) return { kind: "home" };
  if (input === "all") return { kind: "all" };
  if (Object.hasOwn(HELP_SECTIONS, input)) return { kind: "section", value: input };
  const token = input.replace(/^(?:command\s+|\/)/, "");
  const name = Object.hasOwn(CHANNEL_COMMAND_ALIASES, token) ? CHANNEL_COMMAND_ALIASES[token] : token;
  return { kind: "command", value: name };
}

/** Use the dispatch capability contract for native operations. Configuration
 * only narrows discoverability; nothing here grants access or submits work. */
export function commandHelpRestriction(command: ChannelCommandDefinition, context: CommandHelpContext): string | undefined {
  const requiredMode = requiredModeForCommand({ name: command.name, arg: "" });
  if (requiredMode && context.enabledModes && !context.enabledModes.includes(requiredMode))
    return `当前渠道未启用 ${requiredMode} 模式`;
  if (command.name === "task" && (context.taskboardAvailable === false || context.enabledModes && !context.enabledModes.includes("task")))
    return "需启用 Taskboard 和任务模式";
  if (command.name === "qa") {
    if (context.runtime) return "终端 QA 工作流尚未适配，需要结构化工具调用";
    if (context.enabledModes && !context.enabledModes.includes("qa")) return "当前渠道未启用 QA 模式";
    if (context.qaAvailable === false) return "当前项目未绑定可用知识库";
    if (context.backendCapabilities?.dynamicTools === false) return "当前后端不支持 QA 所需的结构化工具";
  }
  if (context.runtime) {
    const restriction = runtimeCommandRestriction(context.runtime, { name: command.name, arg: "" });
    if (restriction) return restriction;
    if (["approve", "reject", "answer", "skip"].includes(command.name) && !context.runtime.operations.interaction.supported)
      return "本后端无结构化交互接口；已有审批或问题仍按原请求处理";
  }
  return command.capability && context.backendCapabilities?.[command.capability] === false
    ? command.localControl ? "当前后端不支持开启；状态查看、关闭等本地操作仍可用" : "当前后端不支持" : undefined;
}

function variant(command: ChannelCommandDefinition, context: CommandHelpContext) {
  const terminal = context.runtime && command.help.terminal;
  return terminal ? { ...command.help, ...terminal } : command.help;
}

function visible(command: ChannelCommandDefinition, selection: HelpSelection, context: CommandHelpContext): boolean {
  if (selection.kind === "all") return true;
  if (selection.kind === "command") return command.name === selection.value;
  if (command.compatibility) return false;
  const restriction = commandHelpRestriction(command, context);
  if (selection.kind === "home") return Boolean(variant(command, context).summary) && !restriction;
  return command.help.section === selection.value && (!restriction || command.record === true || command.localControl === true);
}

/** All help views and their buttons share the same selection and availability.
 * Menus offer read-only navigation; destructive commands stay on their own flow. */
export function commandHelpChoices(topic = "", context: CommandHelpContext = {}): ChannelChoice[] {
  const selection = selectCommandHelp(topic);
  const commands = definitions.filter(command => visible(command, selection, context));
  const navigation: ChannelChoice[] = commands.flatMap(command => command.help.navigation ? [command.help.navigation] : []);
  return [...navigation, ...Object.entries(HELP_SECTIONS).map(([arg, label]): ChannelChoice => ({ label, command: "help", arg })),
    { label: selection.kind === "home" ? "完整参考" : "常用入口", command: "help", arg: selection.kind === "home" ? "all" : "" }];
}

/** Read-only formatter shared by Codex and terminal adapters. Full and explicit
 * command help retain disabled/unsupported operations and compatibility syntax;
 * home hides them. Record controls remain in their family after a backend switch. */
export function commandHelpText(capabilities: readonly ChannelCommandCapability[], topic = "", context: CommandHelpContext = {}): string {
  const selection = selectCommandHelp(topic);
  const commands = definitions.filter(command => visible(command, selection, context));
  const extensions = capabilities.filter(capability => selection.kind === "all"
    || selection.kind === "command" && !commands.length && (capability.commandName === selection.value || Object.hasOwn(capability.aliases, selection.value!)));
  if (!commands.length && !extensions.length && selection.kind === "command")
    return "未找到这个帮助主题。帮助主题：/help all、/help session、/help input、/help access、/help workflow、/help capabilities；也可发送 /help 命令名。";
  const home = selection.kind === "home";
  const lines = [home ? "Agent Bridge · 常用命令" : "Agent Bridge · 命令参考",
    context.runtime ? "普通消息提交给已绑定终端；终端画面按容量滚动展示。" : "普通消息发到已绑定会话；运行中默认安全插话。"];
  if (home) {
    lines.push(...commands.map(command => `/${command.name} — ${variant(command, context).summary}`));
    if (capabilities.length) lines.push(`另有 ${capabilities.length} 项已安装扩展，用 /help all 查看。`);
  } else {
    lines.push("以下为命令语法参考：方括号、竖线和“编号/内容”表示待选参数；实际操作使用当前列表或页面提供的完整命令。");
    const groups = selection.kind === "command" ? [["command", commands] as const]
      : Object.keys(HELP_SECTIONS).map(section => [section, commands.filter(command => command.help.section === section)] as const);
    for (const [section, group] of groups) {
      if (!group.length) continue;
      if (section !== "command") lines.push(HELP_SECTIONS[section as HelpSection]);
      for (const command of group) {
        const entry = variant(command, context), restriction = commandHelpRestriction(command, context);
        const aliases = command.aliases.length ? `（别名 ${command.aliases.map(alias => `/${alias}`).join("、")}）` : "";
        lines.push(`/${command.name}${entry.usage ? ` ${entry.usage}` : ""}${aliases}${restriction ? `【${restriction}】` : ""}\n${entry.description}`,
          ...entry.details ?? []);
      }
    }
    if (!commands.length && selection.kind === "section") lines.push("当前配置下此分项没有可用操作；/help all 可查看功能条件。");
    if (extensions.length) lines.push("已安装扩展", ...channelCapabilityHelpLines(extensions));
    if (selection.kind === "all") lines.push("未注册的 /xxx 先给简短文字提示，再按普通消息处理；路径、引用和正文中的斜杠直接转发。已注册命令即使参数错误或能力不足也不会透传。");
  }
  lines.push("分项帮助：/help session · /help input · /help access · /help workflow · /help capabilities",
    home ? "完整参考：/help all；单命令：/help 命令名。兼容写法继续可用。" : "常用入口：/help；完整参考：/help all。/help /session、/help /access 可单独查看同名命令。");
  return lines.join("\n\n");
}
