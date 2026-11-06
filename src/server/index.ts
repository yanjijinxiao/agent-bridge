#!/usr/bin/env node
import path from "node:path";
import { PeerRegistry } from "../peer/registry.js";
import { loadPeerListener, listenGatewayPeers, listenSharedWorkspaces } from "../peer/runtime.js";
import { fileURLToPath } from "node:url";

import open from "open";

import { loadConfig } from "../state/config.js";
import { preferredStateDir, resolveStatePaths } from "../state/paths.js";
import { TaskboardLifecycle } from "../taskboard/lifecycle.js";
import { AccountManager } from "./account-manager.js";
import { parseServerCommand, serverHelpText } from "./arguments.js";
import { startLocalHttpServer } from "./http-server.js";
import { acquireServiceProcessLock } from "./process-lock.js";
import { launchRestartHelper } from "./restart.js";
import { cleanupResources } from "./cleanup.js";
import { diagnostic, installDiagnostics, terminalMessage } from "../runtime/diagnostics.js";
import { productVersion } from "../runtime/versions.js";

async function main(): Promise<void> {
  const stateDir = process.env.CODEX_IM_GATEWAY_STATE_DIR
    ?? process.env.CODEX_CHANNEL_BRIDGE_STATE_DIR
    ?? process.env.CODEX_WEIXIN_STATE_DIR
    ?? preferredStateDir();
  const port = parsePort(
    process.env.CODEX_IM_GATEWAY_PORT
      ?? process.env.CODEX_CHANNEL_BRIDGE_PORT
      ?? process.env.CODEX_WEIXIN_PORT
  );
  const paths = resolveStatePaths(stateDir);
  const config = loadConfig(paths);
  const peerConfig = loadPeerListener(process.env.CODEX_IM_GATEWAY_PEER_CONFIG);
  const peers = new PeerRegistry(path.join(paths.runtimeDir, "peer-grants.json"), peerConfig?.managedRoutes);
  // Validate deployment routes before acquiring the live process lease.
  const processLock = acquireServiceProcessLock(paths.root);
  let accountManager: AccountManager;
  const taskboard = new TaskboardLifecycle(paths.taskboardDir, undefined, () => accountManager.taskboardNativeBackend());
  accountManager = new AccountManager({ paths, restartParticipant: taskboard, peerRegistry: peers });
  let peerServer: Awaited<ReturnType<typeof listenGatewayPeers>>;
  let sharedWorkspaces: Awaited<ReturnType<typeof listenSharedWorkspaces>>;
  let server: Awaited<ReturnType<typeof startLocalHttpServer>> | undefined;
  let shutdownTask: Promise<void> | undefined;
  let restartScheduled = false;
  const shutdown = () => shutdownTask ??= cleanupResources([
    () => accountManager.stopAll(), () => sharedWorkspaces?.close(), () => peerServer?.close(), () => server?.close(), () => taskboard.close()
  ], "Gateway 部分资源清理失败，其余资源已继续清理", () => processLock.release());
  const exitAfterShutdown = () => void shutdown().then(() => process.exit(0), error => {
    console.error(`[codex-im-gateway] shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
  const scheduleRestart = async (version: string, releasePlan?: string): Promise<void> => {
    if (restartScheduled) return;
    restartScheduled = true;
    try {
      await launchRestartHelper({
        parentPid: process.pid,
        entryPath: fileURLToPath(import.meta.url),
        stateDir: paths.root,
        port,
        releasePlan
      });
    } catch (error) {
      restartScheduled = false;
      // The caller owns the release lease. Do not swallow an asynchronous
      // launch failure and leave the still-running Gateway permanently frozen.
      throw error;
    }
    console.log(`[codex-im-gateway] updated to ${version}; restarting`);
    exitAfterShutdown();
  };
  try {
    if (peerConfig) { peerServer = await listenGatewayPeers(peerConfig, peers); sharedWorkspaces = await listenSharedWorkspaces(peerConfig, peers); }
    await taskboard.apply(config);
    if (accountManager.releaseStatus().prepared) taskboard.pauseForRestart();
    server = await startLocalHttpServer({ paths, accountManager, port, onUpdateInstalled: scheduleRestart,
      onTaskboardConfig: next => taskboard.apply(next) });
    await accountManager.startAll();
  } catch (error) {
    try { await shutdown(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Gateway 启动失败且清理发生异常；已尝试清理全部资源"); }
    throw error;
  }

  // Supervisors consume the structured event, never prose or a credential-
  // bearing URL. A foreground operator still gets the clickable local entry.
  diagnostic("runtime.ready", { surface: "management", port: Number(new URL(server.url).port) });
  if (process.stdout.isTTY) terminalMessage(`Agent Bridge is running at ${server.url}`);
  if ((process.env.CODEX_IM_GATEWAY_OPEN
    ?? process.env.CODEX_CHANNEL_BRIDGE_OPEN
    ?? process.env.CODEX_WEIXIN_OPEN) !== "0") {
    void open(server.url).catch((error: unknown) => {
      console.warn(`Unable to open the browser automatically: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  process.once("SIGINT", exitAfterShutdown);
  process.once("SIGTERM", exitAfterShutdown);
}

function parsePort(value: string | undefined): number {
  if (!value) return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid CODEX_IM_GATEWAY_PORT: ${value}`);
  }
  return port;
}

async function run(): Promise<void> {
  const command = parseServerCommand(process.argv.slice(2));
  if (command === "version") { console.log(productVersion()); return; }
  if (command === "help") {
    console.log(serverHelpText());
    return;
  }
  installDiagnostics("gateway");
  await main();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
