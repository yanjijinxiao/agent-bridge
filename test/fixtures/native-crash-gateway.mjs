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
if (["crash", "crash-recover", "disk-full"].includes(mode)) {
  const original = fs.writeSync;
  fs.writeSync = function (fd, bytes, ...args) {
    if (Buffer.isBuffer(bytes) && bytes.toString().includes('"phase":"accepted"')) {
      const target = fs.statSync(config.receiptFile), actual = fs.fstatSync(fd);
      if (target.dev === actual.dev && target.ino === actual.ino) {
        const row = JSON.parse(bytes.toString());
        fs.writeFileSync(config.crashMarker, JSON.stringify({ pid: process.pid, receipt: row.receipt }), { mode: 0o600 });
        if (mode === "disk-full") throw Object.assign(Error("test receipt volume is full"), { code: "ENOSPC" });
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
if (mode === "disk-full") {
  const run = backend.run.bind(backend);
  backend.run = input => run({ ...input, async onTurnStarted(turn) {
    try { await input.onTurnStarted?.(turn); }
    catch (error) {
      if (error.code !== "ENOSPC") throw error;
      // Hold the failed handoff at its actual callback, so the parent can run
      // the release client and inspect the previous durable receipt before SIGKILL.
      await new Promise(() => {});
    }
  } });
}
let monitor;
const manager = new AccountManager({ paths, ideProjectsProvider: () => [], channelCapabilities: () => [],
  configProvider: () => ({ ...defaultConfig(config.nativeHome), allowedSenderIds: ["actor"], streamReplies: false, taskboardEnabled: false }),
  runnerFactory: () => backend,
  // Only unrelated device watchers and IM transport are controlled. The core,
  // native adapter, manager, inbox, receipts, Bridge and Hub are real.
  codexSessionMonitorFactory: () => ({ start() {}, stop() {} }),
  codexDesktopRequestMonitorFactory: () => ({ start() {}, stop() {}, setFollowedThreads() {} }),
  adapterFactory: () => ({ client: createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, outbound: { ...TEXT_CAPABILITIES.outbound, file: "available" } }, {
    async sendMedia(input) {
      const bytes = fs.readFileSync(input.path), messageId = crypto.randomUUID();
      if (bytes.toString() !== "synthetic recovered attachment") throw Error("Unexpected recovered file bytes");
      fs.appendFileSync(config.deliveries, JSON.stringify({ messageId, text: "", kind: "file", path: input.path,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex") }) + "\n", { mode: 0o600 });
      return { messageId };
    },
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
    } else if (request.command === "unbind" || request.command === "message-after-unbind") {
      await incoming(request.command, request.command === "unbind" ? "/unbind" : "ordinary message after detach");
      process.send?.({ id: request.id, type: "handled" });
    } else if (request.command === "stop") {
      await manager.stopAll(); process.send?.({ id: request.id, type: "stopped" }, () => process.exit(0));
    }
  } catch (error) { process.send?.({ id: request.id, type: "error", error: String(error?.stack ?? error) }); }
});
await manager.startAll();
if (config.releaseProbe) {
  const { startLocalHttpServer } = await import("../../src/server/http-server.ts");
  const server = await startLocalHttpServer({paths, accountManager: manager, port: 0});
  fs.writeFileSync(config.releaseProbe, server.url, {mode: 0o600});
}
process.send?.({ type: "ready" });
if (mode === "crash" || mode === "disk-full") {
  try { await incoming("crash-input", "CRASH_INPUT: preserve this exact native task"); }
  catch (error) {
    // Channels catch processing errors after dispatch and keep their monitor alive.
    if (mode !== "disk-full" || !fs.existsSync(config.crashMarker)) throw error;
    fs.writeFileSync(config.crashMarker + ".returned", error.name);
  }
}
