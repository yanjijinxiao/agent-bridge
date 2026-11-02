import fs from "node:fs";
import crypto from "node:crypto";
import { AccountManager } from "../../src/server/account-manager.ts";
import { AppServerCodexRunner } from "../../src/codex/app-server-runner.ts";
import { CodexAppServerGateway } from "../../src/codex/app-server-gateway.ts";
import { APP_SERVER_SOCKET_RELAY } from "../../src/codex/app-server-socket-relay.ts";
import { createChannelClient, TEXT_CAPABILITIES } from "../../src/channels/client.ts";
import { resolveStatePaths } from "../../src/state/paths.ts";
import { defaultConfig } from "../../src/state/config.ts";

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), mode = process.argv[3];
const paths = resolveStatePaths(config.gatewayRoot);
if (mode === "crash-after-recovered") {
  const original = fs.fsyncSync;
  fs.fsyncSync = function (fd) {
    const result = Reflect.apply(original, fs, [fd]);
    if (fs.existsSync(config.receiptFile)) {
      const target = fs.statSync(config.receiptFile), actual = fs.fstatSync(fd);
      if (target.dev === actual.dev && target.ino === actual.ino) {
        const receipt = JSON.parse(fs.readFileSync(config.receiptFile, "utf8").trim().split("\n").at(-1)).receipt;
        if (receipt?.phase === "accepted" && receipt.recoveredNativeInput) process.kill(process.pid, "SIGKILL");
      }
    }
    return result;
  };
}
if (mode === "crash" || mode === "crash-recover") {
  const original = fs.writeSync;
  fs.writeSync = function (fd, bytes, ...args) {
    if (Buffer.isBuffer(bytes) && bytes.toString().includes('"phase":"accepted"')) {
      const target = fs.statSync(config.receiptFile), actual = fs.fstatSync(fd);
      if (target.dev === actual.dev && target.ino === actual.ino) {
        const row = JSON.parse(bytes.toString());
        fs.writeFileSync(config.crashMarker, JSON.stringify({ pid: process.pid, receipt: row.receipt }), { mode: 0o600 });
        // The real native acceptance callback has reached its journal append.
        // Kill before writing it: the prior submitting record is durable.
        process.kill(process.pid, "SIGKILL");
      }
    }
    return Reflect.apply(original, fs, [fd, bytes, ...args]);
  };
}
const backend = new CodexAppServerGateway({ codexHome: config.nativeHome,
  appServerBackend: new AppServerCodexRunner({ codexHome: config.nativeHome, catalogSource: "native", requestTimeoutMs: 5000,
    transport: { command: process.execPath, args: ["-e", APP_SERVER_SOCKET_RELAY, config.endpoint], mode: "daemon-proxy" } }) });
let monitor;
const manager = new AccountManager({ paths, ideProjectsProvider: () => [], channelCapabilities: () => [],
  configProvider: () => ({ ...defaultConfig(config.nativeHome), allowedSenderIds: ["actor"], streamReplies: false, taskboardEnabled: false }),
  runnerFactory: () => backend,
  // Only unrelated device watchers and IM transport are controlled. The core,
  // native adapter, manager, inbox, receipts, Bridge and Hub are real.
  codexSessionMonitorFactory: () => ({ start() {}, stop() {} }),
  codexDesktopRequestMonitorFactory: () => ({ start() {}, stop() {}, setFollowedThreads() {} }),
  adapterFactory: () => ({ client: createChannelClient("dingtalk", TEXT_CAPABILITIES, {
    async sendText(input) {
      const messageId = crypto.randomUUID();
      fs.appendFileSync(config.deliveries, JSON.stringify({ messageId, text: input.text }) + "\n", { mode: 0o600 });
      return { messageId };
    }
  }), async monitor(options) {
    monitor = options; options.onStatus?.({ state: "connected" });
    await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
  } }) });
async function incoming(id, text) {
  const message = { id, senderId: "actor", replyTargetId: "room", text, attachments: [], raw: {} };
  if (monitor.claimMessage(message)) await monitor.onMessage(message);
}
process.on("message", async request => {
  try {
    if (request.command === "sync") {
      await incoming(`manual-sync-${request.id}`, "/follow sync");
      process.send?.({ id: request.id, type: "synced" });
    } else if (request.command === "stop") {
      await manager.stopAll(); process.send?.({ id: request.id, type: "stopped" }, () => process.exit(0));
    }
  } catch (error) { process.send?.({ id: request.id, type: "error", error: String(error?.stack ?? error) }); }
});
await manager.startAll();
process.send?.({ type: "ready" });
if (mode === "crash") await incoming("crash-input", "CRASH_INPUT: preserve this exact native task");
