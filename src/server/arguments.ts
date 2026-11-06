export type ServerCommand = "start" | "help" | "version";

export function parseServerCommand(args: string[]): ServerCommand {
  if (args.length === 0) {
    return "start";
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return "help";
  }
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) return "version";
  throw new Error(`Unknown argument: ${args.join(" ")}. Run agent-bridge --help.`);
}

export function serverHelpText(): string {
  return [
    "Usage: agent-bridge",
    "",
    "Starts the local Agent Bridge Web service.",
    "",
    "Options:",
    "  -h, --help  Show this help without starting the service",
    "  -v, --version  Show the installed npm product version",
    "",
    "Environment:",
    "  CODEX_IM_GATEWAY_PORT       Local Web port (default: 8787)",
    "  CODEX_IM_GATEWAY_STATE_DIR  State directory (default: ~/.codex-im-gateway)",
    "  CODEX_IM_GATEWAY_OPEN=0     Do not open the browser automatically",
    "  CODEX_IM_GATEWAY_PEER_CONFIG  Optional peer listener JSON file",
    "",
    "Legacy CODEX_CHANNEL_BRIDGE_* and CODEX_WEIXIN_* variables remain supported."
  ].join("\n");
}
