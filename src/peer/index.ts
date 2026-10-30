#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { z } from "zod";
import { CodexBackendRouter } from "../codex/runner.js";
import { readJsonFile } from "../state/json-store.js";
import { PeerExecutionService } from "./execution-service.js";
import { GatewayPeerClient } from "./transport.js";
import { acquireServiceProcessLock } from "../server/process-lock.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: npm run peer -- --config /absolute/path/peer-client.json\n\nConnects this device to Gateway. Pair the device once, then list and select Codex sessions in chat.\nOptional threadId restricts access to one existing session; otherwise no session ID is needed locally."); return;
  }
  if (args.length !== 2 || args[0] !== "--config") throw new Error("Use --config /absolute/path/peer-client.json (or --help)");
  const file = path.resolve(args[1]);
  const config = z.object({ url: z.string().url(), nodeId: z.string(), tokenFile: z.string(), caFile: z.string().optional(),
    allowInsecureLan: z.boolean().default(false), profileId: z.string().default("default"), label: z.string().min(1).max(80).optional(), threadId: z.string().min(1).optional(),
    codexHome: z.string().optional(), codexBin: z.string().default("codex"), backend: z.enum(["app-server", "exec"]).default("app-server"),
    stateDir: z.string().optional() }).strict().parse(readJsonFile(file, null));
  const resolve = (name: string) => path.resolve(path.dirname(file), name);
  const backend = new CodexBackendRouter({ backend: config.backend, appServerTransport: config.backend === "app-server" ? "daemon" : "stdio",
    codexBin: config.codexBin, codexHome: config.codexHome ? resolve(config.codexHome) : process.env.CODEX_HOME });
  let questions: Promise<unknown> = Promise.resolve();
  const stateKey = crypto.createHash("sha256").update(JSON.stringify([config.url, config.nodeId, config.profileId, config.threadId])).digest("hex").slice(0, 24);
  const stateDir = config.stateDir ? resolve(config.stateDir) : path.join(os.homedir(), ".codex-im-gateway", "peer-client", stateKey);
  const lock = acquireServiceProcessLock(stateDir);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  let client: GatewayPeerClient | undefined;
  try {
    const service = await PeerExecutionService.create({ backend, threadId: config.threadId, profileId: config.profileId, label: config.label ?? config.nodeId,
      stateDir,
      independent: config.backend === "app-server",
      approve: grant => {
        const answer = questions.then(async () => {
          if (!process.stdin.isTTY) return false;
          console.log(`\n设备访问申请：${JSON.stringify(grant.principal)}\n范围：${config.threadId ? JSON.stringify(config.threadId) : "此 Codex profile 的普通会话（列出、选择、查看历史及执行任务）"}`);
          return (await terminal.question("允许这个用户在此聊天中访问上述本机会话？输入 yes 确认：")).trim() === "yes";
        });
        questions = answer.catch(() => {}); return answer;
      } });
    client = new GatewayPeerClient({ ...config, token: fs.readFileSync(resolve(config.tokenFile), "utf8").trim(),
      ca: config.caFile ? fs.readFileSync(resolve(config.caFile)) : undefined,
      status: state => console.log(`Gateway peer: ${state}`),
      connected: async connection => {
        service.attach(connection);
        const ticket = await connection.request<{ code: string; hostId: string }>("peer.register", service.description);
        console.log(`已连接。请在钉钉私聊发送 /connect ${ticket.code}，或在群聊 @机器人 后发送。\n设备：${config.label ?? config.nodeId}\n配对码有效期 5 分钟；本机确认后，在钉钉选择要绑定的会话。`);
      } });
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      client?.close(); terminal.close(); backend.detachIndependentObservations();
      try { await backend.close(); } finally { lock.release(); }
    })();
    const shutdown = () => void stop().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
    terminal.once("SIGINT", shutdown); // readline consumes Ctrl-C while asking for confirmation.
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    client.start();
  } catch (error) { client?.close(); terminal.close(); try { await backend.close(); } finally { lock.release(); } throw error; }
}
main().catch(() => { console.error("Gateway peer client failed. Check the local configuration, exported session, and device logs. Credentials are not printed."); process.exitCode = 1; });
