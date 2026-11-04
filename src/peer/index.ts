#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { z } from "zod";
import { CodexBackendRouter } from "../codex/runner.js";
import { readJsonFile } from "../state/json-store.js";
import { withConnectorProjects } from "./project-catalog.js";
import { PeerExecutionService } from "./execution-service.js";
import { GatewayPeerClient } from "./transport.js";
import { acquireServiceProcessLock } from "../server/process-lock.js";
import { peerIDEConfigSchema } from "./ide-service.js";
import { deviceIdSchema, loadPeerIdentity } from "./credentials.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: npm run peer -- --config /absolute/path/peer-client.json\n\nConnects this device to Gateway. Pair the device once, then list and select Codex sessions in chat.\nOptional threadId restricts access to one existing session; otherwise no session ID is needed locally."); return;
  }
  if (args.length !== 2 || args[0] !== "--config") throw new Error("Use --config /absolute/path/peer-client.json (or --help)");
  const file = path.resolve(args[1]);
  const config = z.object({ url: z.string().url(), nodeId: deviceIdSchema.optional(), tokenFile: z.string().min(1).optional(), caFile: z.string().optional(),
    allowInsecureLan: z.boolean().default(false), profileId: z.string().default("default"), label: z.string().min(1).max(80).optional(), threadId: z.string().min(1).optional(),
    codexHome: z.string().optional(), codexBin: z.string().default("codex"), backend: z.literal("app-server").default("app-server"),
    appServerTransport: z.enum(["daemon", "stdio"]).default("daemon"),
    webIDE: peerIDEConfigSchema.optional(),
    stateDir: z.string().optional() }).strict().refine(value => Boolean(value.nodeId) === Boolean(value.tokenFile),
      "旧凭据必须同时保留 nodeId 和 tokenFile；新设备请同时省略，由 Connector 自动生成身份").parse(readJsonFile(file, null));
  const resolve = (name: string) => path.resolve(path.dirname(file), name);
  const backend = withConnectorProjects(new CodexBackendRouter({ backend: config.backend, appServerTransport: config.appServerTransport,
    codexBin: config.codexBin, codexHome: config.codexHome ? resolve(config.codexHome) : process.env.CODEX_HOME }), config.codexHome ? resolve(config.codexHome) : process.env.CODEX_HOME);
  let questions: Promise<unknown> = Promise.resolve();
  const stateKey = crypto.createHash("sha256").update(JSON.stringify([config.url, config.nodeId, config.profileId, config.threadId])).digest("hex").slice(0, 24);
  const stateDir = config.stateDir ? resolve(config.stateDir) : path.join(os.homedir(), ".codex-im-gateway", "peer-client", stateKey);
  const lock = acquireServiceProcessLock(stateDir);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  let client: GatewayPeerClient | undefined;
  let service: PeerExecutionService | undefined;
  try {
    const identity = config.tokenFile ? { nodeId: config.nodeId!, token: fs.readFileSync(resolve(config.tokenFile), "utf8").trim() }
      : loadPeerIdentity(stateDir, config.url);
    const label = config.label ?? os.hostname();
    service = await PeerExecutionService.create({ backend, threadId: config.threadId, profileId: config.profileId, label,
      stateDir, webIDE: config.webIDE,
      independent: config.appServerTransport === "daemon",
      approveOwner: confirmation => {
        const answer = questions.then(async () => {
          if (!process.stdin.isTTY) return false;
          console.log(`\n所有权确认：${JSON.stringify(confirmation.principal)}\n会话：${confirmation.threadId}\n${confirmation.workspace ? `目录：${confirmation.workspace}\n此人可授权他人在浏览器读取或编辑该目录已有文本文件，不开放终端。` : "仅会话所有权；未开放工作目录。"}\n所有者可批准、限时开放和撤销他人的会话访问。已有 owner 改变时撤销原共享。`);
          return (await terminal.question("确认这个账号拥有上述资源并可授权别人？输入 yes：")).trim() === "yes";
        });
        questions = answer.catch(() => {}); return answer;
      },
      approve: grant => {
        const answer = questions.then(async () => {
          if (!process.stdin.isTTY) return false;
          if (config.webIDE?.enabled) console.log("完整 Web IDE 已在本机启用：本人浏览器可使用文件、Git 和终端，权限等同于运行 Connector 的系统用户；目录列表不是系统沙箱。文本共享访客不会获得终端。");
          console.log(`\n设备访问申请：${JSON.stringify(grant.principal)}\n范围：${config.threadId ? `仅会话 ${JSON.stringify(config.threadId)}（历史、执行、重命名及生命周期管理）` : "此 Codex profile 的普通会话（列出、选择、查看历史、执行、新建、重命名及生命周期管理）"}\n文件：接收聊天附件；回传所选会话工作目录或其附件目录中的文件。`);
          return (await terminal.question("允许这个用户在此聊天中访问上述本机会话？输入 yes 确认：")).trim() === "yes";
        });
        questions = answer.catch(() => {}); return answer;
      } });
    client = new GatewayPeerClient({ ...config, ...identity, enroll: !config.tokenFile,
      ca: config.caFile ? fs.readFileSync(resolve(config.caFile)) : undefined,
      status: state => console.log(`Gateway peer: ${state}`),
      connected: async connection => {
        service!.attach(connection);
        const ticket = await connection.request<{ code: string; hostId: string; enrollment?: boolean; paired?: boolean }>("peer.register", service!.description);
        console.log(`${ticket.enrollment ? "设备待登记；完成配对前不能访问会话。" : ticket.paired ? "已连接，正在恢复已有授权，无需重复配对。" : "已连接。"}\n${ticket.paired ? "如需授权新的聊天，" : ""}请在钉钉私聊发送 /connect ${ticket.code}，或在群聊 @机器人 后发送。\n设备：${label}\n配对码有效期 5 分钟；本机确认后，在钉钉选择要绑定的会话。设备凭据由程序保存，无需分发。`);
      } });
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      client?.close(); terminal.close(); backend.detachIndependentObservations();
      await service!.close();
      try { await backend.close(); } finally { lock.release(); }
    })();
    const shutdown = () => void stop().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
    terminal.once("SIGINT", shutdown); // readline consumes Ctrl-C while asking for confirmation.
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    client.start();
  } catch (error) { client?.close(); terminal.close(); await service?.close(); try { await backend.close(); } finally { lock.release(); } throw error; }
}
main().catch(() => { console.error("Gateway peer client failed. Check the local configuration, exported session, and device logs. Credentials are not printed."); process.exitCode = 1; });
