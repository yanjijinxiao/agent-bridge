#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { connectorConfigSchema } from "./config.js";
import { closeConnectorResources } from "./cleanup.js";
import { createHerdrRuntime, runtimeEndpointId } from "../agents/config.js";
import { RuntimeResourceCatalog } from "../agents/resource-catalog.js";
import { CodexBackendRouter } from "../codex/runner.js";
import { readJsonFile } from "../state/json-store.js";
import { withConnectorProjects } from "./project-catalog.js";
import { PeerExecutionService } from "./execution-service.js";
import { GatewayPeerClient } from "./transport.js";
import { acquireServiceProcessLock } from "../server/process-lock.js";
import { loadPeerIdentity } from "./credentials.js";
import { hostScopedBackend } from "../codex/host-scoped-backend.js";
import { registeredRemoteHosts } from "../codex/remote-host.js";
import { diagnostic, installDiagnostics, terminalMessage } from "../runtime/diagnostics.js";
import { productVersion } from "../runtime/versions.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) { terminalMessage(productVersion()); return; }
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    terminalMessage("Usage: agent-bridge-connector --config /absolute/path/peer-client.json\n\nConnects this device to Gateway. Pair the device once, then list and select sessions/resources in chat.\nDefault backend: app-server. Herdr uses an explicit herdr-tui or herdr-app runtime configuration.\nOptional threadId restricts access to one existing session; otherwise no session ID is needed locally.\n--version prints the installed npm product version."); return;
  }
  installDiagnostics("connector");
  if (args.length !== 2 || args[0] !== "--config") throw new Error("Use --config /absolute/path/peer-client.json (or --help)");
  const file = path.resolve(args[1]);
  const config = connectorConfigSchema.parse(readJsonFile(file, null));
  const resolve = (name: string) => path.resolve(path.dirname(file), name);
  const runtime = config.runtime ? createHerdrRuntime(config.runtime) : undefined;
  const native = config.backend === "app-server" ? withConnectorProjects(new CodexBackendRouter({ backend: config.backend, appServerTransport: config.appServerTransport,
    codexBin: config.codexBin, codexHome: config.codexHome ? resolve(config.codexHome) : process.env.CODEX_HOME }), config.codexHome ? resolve(config.codexHome) : process.env.CODEX_HOME) : undefined;
  const closeBackend = async () => { if (native) await native.close(); else runtime!.close(); };
  let questions: Promise<unknown> = Promise.resolve();
  const stateKey = crypto.createHash("sha256").update(JSON.stringify([config.url, config.nodeId, config.profileId, config.threadId])).digest("hex").slice(0, 24);
  const baseStateDir = config.stateDir ? resolve(config.stateDir) : path.join(os.homedir(), ".codex-im-gateway", "peer-client", stateKey);
  const stateDir = config.runtime ? path.join(baseStateDir, "runtimes", crypto.createHash("sha256").update(runtimeEndpointId(config.runtime)).digest("hex")) : baseStateDir;
  const lock = acquireServiceProcessLock(stateDir);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  let client: GatewayPeerClient | undefined;
  let service: PeerExecutionService | undefined;
  const hostServices = new Map<string, PeerExecutionService>();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= closeConnectorResources([
    () => client?.close(), () => { terminal.close(); }, () => native?.detachIndependentObservations(),
    async () => { await service?.close(); },
    ...[...hostServices.values()].map(child => () => child.close()), closeBackend, () => lock.release()
  ]);
  try {
    // A failed handshake is inside the same cleanup boundary as registration.
    // Otherwise an open core socket can keep a failed Connector process alive.
    const backend = native ?? new RuntimeResourceCatalog(runtime!, await runtime!.describe());
    const identity = config.tokenFile ? { nodeId: config.nodeId!, token: fs.readFileSync(resolve(config.tokenFile), "utf8").trim() }
      : loadPeerIdentity(stateDir, config.url);
    const label = config.label ?? os.hostname();
    service = await PeerExecutionService.create({ backend, threadId: config.threadId, profileId: config.profileId, label,
      stateDir, webIDE: config.webIDE, managedRoute: config.managedRoute,
      codexHome: native ? config.codexHome ? resolve(config.codexHome) : process.env.CODEX_HOME : undefined,
      independent: !!runtime || config.appServerTransport === "daemon",
      approveOwner: confirmation => {
        const answer = questions.then(async () => {
          if (!process.stdin.isTTY) return false;
          terminalMessage(`\n所有权确认：${JSON.stringify(confirmation.principal)}\n会话：${confirmation.threadId}\n${confirmation.workspace ? `目录：${confirmation.workspace}\n此人可授权他人在浏览器读取或编辑该目录已有文本文件，不开放终端。` : "仅会话所有权；未开放工作目录。"}\n所有者可批准、限时开放和撤销他人的会话访问。已有 owner 改变时撤销原共享。`);
          return (await terminal.question("确认这个账号拥有上述资源并可授权别人？输入 yes：")).trim() === "yes";
        });
        questions = answer.catch(() => {}); return answer;
      },
      approve: grant => {
        const answer = questions.then(async () => {
          if (!process.stdin.isTTY) return false;
          if (config.webIDE?.enabled) terminalMessage("完整 Web IDE 已在本机启用：本人浏览器可使用文件、Git 和终端，权限等同于运行 Connector 的系统用户；目录列表不是系统沙箱。文本共享访客不会获得终端。");
          const scope = config.threadId ? `仅资源 ${JSON.stringify(config.threadId)}` : "此执行入口的资源";
          const operations = runtime ? "终端目录、画面、输入及接口支持的中断；终端画面不等于结构化历史" : "会话目录、历史、执行、重命名及生命周期管理";
          terminalMessage(`\n设备访问申请：${JSON.stringify(grant.principal)}\n范围：${scope}（${operations}）\n文件：接收聊天附件；回传所选资源工作目录或其附件目录中的文件。`);
          return (await terminal.question("允许这个用户在此聊天中访问上述本机会话？输入 yes 确认：")).trim() === "yes";
        });
        questions = answer.catch(() => {}); return answer;
      } });
    const exports = !native ? [] : config.managedRoute ? (config.managedHosts ?? []).map(route => ({ nativeHostId: route.nativeHostId!, route }))
      : config.threadId ? [] : registeredRemoteHosts(config.codexHome ? resolve(config.codexHome) : process.env.CODEX_HOME).map(nativeHostId => ({ nativeHostId, route: undefined }));
    if (exports.some(e => !e.nativeHostId || e.nativeHostId === "local") || new Set(exports.map(e => e.nativeHostId)).size !== exports.length)
      throw new Error("Connector native host exports must be distinct remote hosts");
    for (const exported of exports) {
      // Per-host journals and leases isolate identical thread IDs. All host
      // operations still call the same native backend through one binding.
      const hostStateDir = path.join(stateDir, "hosts", crypto.createHash("sha256").update(exported.nativeHostId).digest("hex"));
      fs.mkdirSync(hostStateDir, { recursive: true, mode: 0o700 });
      const child = await PeerExecutionService.create({ backend: hostScopedBackend(native!, exported.nativeHostId),
        profileId: config.profileId, label, stateDir: hostStateDir,
        codexHome: config.codexHome ? resolve(config.codexHome) : process.env.CODEX_HOME,
        nativeHostId: exported.nativeHostId, managedRoute: exported.route,
        webIDE: exported.route?.webIDE ?? (config.webIDE ? { ...config.webIDE, dataRoot: undefined, binary: "code-server" } : undefined),
        independent: true, approve: async () => false, approveOwner: confirmation => service!.confirmOwner(confirmation), inheritedDeviceGrant: grant => service!.authorizesDevice(grant) });
      hostServices.set(exported.nativeHostId, child);
    }
    service.description.hosts = exports.map(e => ({ nativeHostId: e.nativeHostId, ...(e.route ? { managedHost: e.route.hostId } : {}) }));
    client = new GatewayPeerClient({ url: config.url, allowInsecureLan: config.allowInsecureLan, ...identity, enroll: !config.tokenFile,
      ca: config.caFile ? fs.readFileSync(resolve(config.caFile)) : undefined,
      status: state => diagnostic("peer.transport.state", { status: state }),
      connected: async connection => {
        service!.attach(connection);
        for (const [host, child] of hostServices) child.attach(connection.channel(host));
        const ticket = await connection.request<{ code: string; hostId: string; managed?: boolean; enrollment?: boolean; paired?: boolean }>("peer.register", service!.description);
        if (ticket.managed) { terminalMessage(`托管 Connector 已连接：${label}；保留原 Gateway 准入和会话绑定。`); return; }
        terminalMessage(`${ticket.enrollment ? "设备待登记；完成配对前不能访问会话。" : ticket.paired ? "已连接，正在恢复已有授权，无需重复配对。" : "已连接。"}\n${ticket.paired ? "如需授权新的聊天，" : ""}请在钉钉私聊发送 /connect ${ticket.code}，或在群聊 @机器人 后发送。\n设备：${label}\n配对码有效期 5 分钟；本机确认后，在钉钉选择要绑定的会话。设备凭据由程序保存，无需分发。`);
      } });
    const shutdown = () => void stop().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
    terminal.once("SIGINT", shutdown); // readline consumes Ctrl-C while asking for confirmation.
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    client.start();
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Connector startup and cleanup failed"); }
    throw error;
  }
}
main().catch(() => { console.error("Gateway peer client failed. Check the local configuration, exported session, and device logs. Credentials are not printed."); process.exitCode = 1; });
