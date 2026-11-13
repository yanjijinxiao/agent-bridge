import { splitCommandText } from "../channels/command-text.js";
import {
  channelCapabilityAliases,
  type ChannelCommandCapability
} from "./channel-capability.js";
import type { ChannelCommand } from "./channel-intent.js";
import { commandHelpText, type CommandHelpContext } from "./command-help.js";
import { CHANNEL_COMMAND_REGISTRY, CHANNEL_COMMAND_ALIASES as COMMAND_ALIASES } from "./channel-command-registry.js";
export { CHANNEL_COMMAND_REGISTRY } from "./channel-command-registry.js";

/** Buffer controls must not overtake earlier pieces (or be overtaken by later
 * pieces). This applies to text, menu and card commands without changing their
 * conservative command-replay policy. Viewing the buffer is independent. */
export function ordersPromptInput(text: string): boolean {
  const command = parseCommand(text);
  return command?.name === "prompt" && /^(?:start|s|done|d|cancel)$/i.test(command.arg.trim());
}

const BUILT_IN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  ...CHANNEL_COMMAND_REGISTRY.map(command => command.name),
  ...Object.keys(COMMAND_ALIASES)
]);

export function isReservedChannelCommandToken(token: string): boolean {
  return BUILT_IN_COMMAND_NAMES.has(token.toLowerCase());
}

export function parseCommand(
  text: string,
  capabilityAliases: Readonly<Record<string, string>> = {}
): ChannelCommand | undefined {
  const parts = splitCommandText(text);
  if (!parts) return;
  const { name, argument } = parts;
  const rest = argument.trim().split(/\s+/).filter(Boolean);
  const canonicalName = Object.hasOwn(COMMAND_ALIASES, name) ? COMMAND_ALIASES[name]
    : BUILT_IN_COMMAND_NAMES.has(name) ? name : Object.hasOwn(capabilityAliases, name) ? capabilityAliases[name] : name;
  // Normalize before authorization and mode checks, including /s new.
  if (canonicalName === "session" && rest[0]?.toLowerCase() === "new") {
    return { name: "new", arg: argument.trim().replace(/^new(?:\s+|$)/i, "") };
  }
  return { name: canonicalName, arg: ["answer", "queue", "steer", "goal", "new"].includes(canonicalName) ? argument : rest.join(" ") };
}

/** Registration, not a leading slash, grants Gateway command semantics.
 * Keep parseCommand syntax-only: old durable receipts deliberately use its
 * conservative classification. Path separators/control characters cannot be
 * extension aliases (the manifest enforces the same boundary). */
export function mayBeChannelCommand(text: string): boolean {
  const parts = splitCommandText(text);
  return Boolean(parts && /^[^\s/\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u.test(parts.name));
}

export function classifyChannelInput(text: string, capabilities: readonly ChannelCommandCapability[] = []):
  { kind: "command"; command: ChannelCommand } | { kind: "message"; unknownCommand?: string } {
  if (!mayBeChannelCommand(text)) return { kind: "message" };
  const command = parseCommand(text, channelCapabilityAliases(capabilities))!;
  if (isReservedChannelCommandToken(command.name) || capabilities.some(item => item.commandName === command.name))
    return { kind: "command", command };
  // A filename, punctuation or prose after '/' is ordinary content. Registered
  // extension aliases (including non-ASCII ones) have already been considered.
  const name = splitCommandText(text)!.name;
  return { kind: "message", ...(/^[a-z][a-z0-9_-]*$/i.test(name) ? { unknownCommand: name } : {}) };
}

/** Compatibility export; all backends now use the same help selection contract. */
export type ChannelHelpContext = CommandHelpContext;

export function channelHelpText(capabilities: readonly ChannelCommandCapability[], topic = "", context: ChannelHelpContext = {}): string {
  return commandHelpText(capabilities, topic, context);
}
