import fs from "node:fs";
import path from "node:path";

export type ResolveCodexCommandOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: (target: string) => boolean;
};

export function resolveCodexCommand(
  codexBin: string,
  options: ResolveCodexCommandOptions = {}
): { command: string; argsPrefix: string[] } {
  const execPath = options.execPath ?? process.execPath;
  if (/\.(?:js|mjs|cjs)$/i.test(codexBin)) {
    return { command: execPath, argsPrefix: [codexBin] };
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  if (platform === "darwin" && codexBin === "codex" && !commandExistsOnPath(codexBin, env, existsSync)) {
    const bundledCli = resolveMacDesktopCodex(env, existsSync);
    if (bundledCli) {
      return { command: bundledCli, argsPrefix: [] };
    }
  }
  if (platform !== "win32") {
    return { command: codexBin, argsPrefix: [] };
  }

  const npmShim = env.CHAT_CODEX_BIN;
  const pathApi = platform === "win32" ? path.win32 : path;
  const npmRoot = npmShim ? pathApi.dirname(npmShim) : "";
  const bundledCli = npmRoot
    ? pathApi.join(npmRoot, "node_modules", "@openai", "codex", "bin", "codex.js")
    : "";
  if (bundledCli && existsSync(bundledCli)) {
    return { command: execPath, argsPrefix: [bundledCli] };
  }

  return { command: codexBin, argsPrefix: [] };
}

function commandExistsOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  existsSync: (target: string) => boolean
): boolean {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => existsSync(path.join(directory, command)));
}

function resolveMacDesktopCodex(
  env: NodeJS.ProcessEnv,
  existsSync: (target: string) => boolean
): string | undefined {
  const home = env.HOME;
  const candidates = [
    env.CHAT_CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    ...(home ? [
      path.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
      path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex")
    ] : [])
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}
