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
// Stop at the actual production journal publication boundary, after native
// acceptance. The native daemon is owned by the parent test, never this child.
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  let receipt;
  if (String(to) === config.queueFile && mode !== "recover") {
    const value = JSON.parse(fs.readFileSync(from, "utf8"));
    receipt = Object.values(value.receipts).find(row => row.messageId === "queue-crash-input"
      && ["queued", "running", "completed"].includes(row.status));
  }
  const crash = () => {
    fs.writeFileSync(config.crashMarker, JSON.stringify({ pid: process.pid, receipt, mode }), { mode: 0o600 });
    process.kill(process.pid, "SIGKILL");
  };
  if (receipt && mode.endsWith("before")) crash();
  const result = Reflect.apply(rename, fs, [from, to]);
  if (receipt && mode.endsWith("after")) crash();
  return result;
};
const backend = new CodexAppServerGateway({ codexHome: config.nativeHome,
  appServerBackend: new AppServerCodexRunner({ codexHome: config.nativeHome, catalogSource: "native", requestTimeoutMs: 5000,
    transport: { command: process.execPath, args: ["-e", APP_SERVER_SOCKET_RELAY, config.endpoint], mode: "daemon-proxy" } }) });
const native = backend.appServer;
// Audit only RPC method names; this never fabricates an ack or a native event.
const request = native.request.bind(native);
native.request = async (method, ...args) => {
  fs.appendFileSync(config.wireLog, JSON.stringify({ pid: process.pid, method }) + "\n", { mode: 0o600 });
  const result = await request(method, ...args);
  if (method === "thread/read" || method === "thread/turns/list") fs.appendFileSync(config.wireLog, JSON.stringify({ pid: process.pid, method, response: method === "thread/read" ? { status: result.thread?.status } : { turns: result.data?.map(t => ({ id: t.id, status: t.status, completedAt: t.completedAt, items: t.items?.map(i => i.type) })) } }) + "\n", { mode: 0o600 });
  return result;
};
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
if (mode.startsWith("submit-")) await incoming("queue-crash-input", "/queue QUEUE_CRASH_INPUT: preserve this exact native task");
