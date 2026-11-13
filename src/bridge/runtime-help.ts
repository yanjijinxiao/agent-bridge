import type { RuntimeDescriptor } from "../agents/contracts.js";
import type { ChannelCommandCapability } from "./channel-capability.js";
import { commandHelpText, type CommandHelpContext } from "./command-help.js";

/** Terminal wording and capability evidence are inputs to the shared formatter,
 * not a second command inventory or a parallel business-help implementation. */
export function runtimeHelp(descriptor: RuntimeDescriptor, topic = "", context: Omit<CommandHelpContext, "runtime"> & {
  capabilities?: readonly ChannelCommandCapability[];
} = {}): string {
  return commandHelpText(context.capabilities ?? [], topic, { ...context, runtime: descriptor });
}
