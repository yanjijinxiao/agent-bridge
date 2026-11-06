import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import type { AppServerTransport } from "./app-server-transport.js";
import { resolveCodexCommand } from "./codex-command.js";
import { APP_SERVER_SOCKET_RELAY } from "./app-server-socket-relay.js";
import { CodexConnectionSetupError } from "./connection-errors.js";

export type AppServerConnectionMode = "auto" | "daemon" | "stdio";

export type LocalAppServerTransportOptions = {
  readonly codexBin?: string;
  readonly mode?: AppServerConnectionMode;
  readonly codexHome?: string;
  readonly platform?: NodeJS.Platform;
  readonly existsSync?: (target: string) => boolean;
  readonly commandTimeoutMs?: number;
};

/**
 * Connects to the independent managed daemon using the native CLI (standalone
 * or explicitly configured). Custom script/test commands can opt into stdio;
 * daemon initialization failure must never silently create a private executor.
 */
export function resolveLocalAppServerTransport(
  options: LocalAppServerTransportOptions = {}
): AppServerTransport | undefined {
  const mode = options.mode ?? "auto";
  if (mode === "stdio") return undefined;

  const platform = options.platform ?? process.platform;
  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
  const managedExecutable = path.join(
    codexHome,
    "packages",
    "standalone",
    "current",
    platform === "win32" ? "codex.exe" : "codex"
  );
  const existsSync = options.existsSync ?? fs.existsSync;
  const managed = existsSync(managedExecutable);
  if (!managed && !options.codexBin && mode === "auto") return undefined;
  const executable = managed ? managedExecutable : options.codexBin ?? managedExecutable;
  const command = resolveCodexCommand(executable);
  const socketPath = path.join(codexHome, "app-server-control", "app-server-control.sock");

  const ensureAvailable = async () => {
    // Desktop may already own a healthy service even if PATH resolves to an
    // older CLI without daemon commands. Connect to that exact home first.
    // This probe grants no task ownership; the relay still performs the native
    // handshake. Only an absent/refused socket permits starting the same daemon.
    if (await canConnect(socketPath)) return;
    if (!managed && !options.codexBin) {
      throw new CodexConnectionSetupError("command-unavailable");
    }
    await runCodexDaemonCommand(command.command, [...command.argsPrefix, "app-server", "daemon", "start"], options.commandTimeoutMs, codexHome);
  };

  return {
    command: process.execPath,
    args: ["-e", APP_SERVER_SOCKET_RELAY, socketPath],
    label: managed ? "managed-daemon" : "configured-daemon",
    mode: "daemon-proxy",
    prepare: ensureAvailable
  };
}

async function canConnect(socketPath: string): Promise<boolean> {
  // A missing path needs no connect syscall (which may reject a long, absent
  // Unix path before reporting ENOENT). Permission and invalid-path failures
  // still fail closed, rather than being mistaken for a stopped daemon.
  try { await fs.promises.lstat(socketPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new CodexConnectionSetupError("socket-unavailable", error);
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const finish = (error?: NodeJS.ErrnoException) => {
      socket.destroy();
      if (!error) resolve(true);
      else if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(new CodexConnectionSetupError("socket-unavailable", error));
    };
    socket.setTimeout(1000, () => finish(Object.assign(new Error("Socket probe timed out"), { code: "ETIMEDOUT" })));
    socket.once("connect", () => finish());
    socket.once("error", finish);
  });
}

function runCodexDaemonCommand(command: string, args: readonly string[], timeoutMs = 30_000, codexHome?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(codexHome ? { env: { ...process.env, CODEX_HOME: codexHome } } : {}),
      shell: false,
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new CodexConnectionSetupError("start-timeout"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new CodexConnectionSetupError("command-unavailable", error));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat([...stderr, ...stdout]).toString("utf8").trim();
      reject(new CodexConnectionSetupError("start-failed", new Error(`daemon exit ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`)));
    });
  });
}
