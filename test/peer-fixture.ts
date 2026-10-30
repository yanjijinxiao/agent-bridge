import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { APP_SERVER_BACKEND_CAPABILITIES, type CodexBridgeBackend, type CodexRunnerInput, type CodexThreadState } from "../src/codex/backend.js";
import { PeerExecutionService, type PeerExecutionOptions } from "../src/peer/execution-service.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { withPeerBackend } from "../src/peer/backend.js";
import { GatewayPeerClient, GatewayPeerServer } from "../src/peer/transport.js";
import { peerPrincipal, type PeerPrincipal } from "../src/peer/context.js";
import type { PeerConnection } from "../src/peer/rpc.js";

export const principal: PeerPrincipal = { accountId: "bot-one", conversationId: "room-one", actorId: "owner" };
export const token = "synthetic-device-credential-for-tests-only";
export async function peerFixture(t: TestContext, options: Partial<Pick<PeerExecutionOptions, "approve" | "independent">> & { device?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-peer-"));
  const thread: CodexThreadState = { threadId: "existing-native", cwd: "/device-only/workspace", title: "Local existing task",
    persistence: "active", runtimeStatus: "idle", activeFlags: [], projectMembership: "none" };
  const runs: CodexRunnerInput[] = [], stops: string[] = [];
  const threads = [thread];
  let run: (input: CodexRunnerInput) => Promise<any> = async input => {
    input.assertCurrent?.();
    await input.onTurnStarted?.({ threadId: input.threadId!, turnId: "native-turn" });
    return { text: "来自设备的回答", threadId: input.threadId, turnId: "native-turn", raw: "provider-private-body" };
  };
  const backend = {
    backendInfo: () => ({ id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
    async inspectThread(id: string) { return { ...(threads.find(row => row.threadId === id) ?? { threadId: id, persistence: "missing", runtimeStatus: "unknown", activeFlags: [] }) }; },
    async readThreadSnapshot(id: string) { return { state: await this.inspectThread(id), turns: [] }; },
    async getHistory() { return []; }, async getHistoryPage() { return { messages: [] }; },
    async readTurnLifecycle() { return { status: "unknown", source: "unknown" }; },
    async getRuntimeInfo() { return { model: "deepseek-v4.1-flash-1017", effort: "medium" }; },
    async listModels() { return [{ model: "deepseek-v4.1-flash-1017", displayName: "DeepSeek", description: "Device default", isDefault: true, supportedEfforts: [] }]; },
    async getAccountRateLimits() { return { planType: "device-plan", limitName: "device-only-limit" }; },
    async run(input: CodexRunnerInput) { runs.push(input); return run(input); },
    async steer(input: any) { input.assertCurrent?.(); return { status: "accepted", threadId: thread.threadId, turnId: "native-turn" }; },
    async submitThreadMessage(input: any) { input.assertCurrent?.(); return { status: "accepted", threadId: thread.threadId, turnId: "native-turn" }; },
    async stop(id: string, _host?: string, guard?: () => void) { guard?.(); stops.push(id); return { stopped: true, threadId: id }; },
    async listSessionCatalog() { return { backend: "app-server", source: "app-server-storage", threads: options.device ? structuredClone(threads) : [], hostIds: ["local"], complete: true, warnings: [] }; },
    async listProjects() { return { backend: "app-server", projects: [] }; }, async warmUp() {},
    hasInFlightWork: () => false, hasRestartBlockingWork: () => false, isIndependentObservation: () => false,
    async close() {}
  } as unknown as CodexBridgeBackend;
  const registry = new PeerRegistry(path.join(root, "server", "grants.json"));
  let service = await PeerExecutionService.create({ backend, threadId: options.device ? undefined : thread.threadId, label: "我的笔记本", profileId: "work", stateDir: path.join(root, "client"),
    independent: options.independent ?? true, approve: options.approve ?? (async () => true) });
  let serverConnection!: PeerConnection, clientConnection!: PeerConnection;
  const server = await GatewayPeerServer.listen({ host: "127.0.0.1", port: 0, credentials: { laptop: token },
    accept: (id, connection) => { serverConnection = connection; registry.accept(id, connection); } });
  let next = Promise.withResolvers<{ hostId: string; code: string; expiresAt: number }>();
  const client = new GatewayPeerClient({ url: server.url, nodeId: "laptop", token, reconnectMs: 10,
    connected: async connection => {
      clientConnection = connection; service.attach(connection);
      next.resolve(await connection.request("peer.register", service.description));
    } });
  client.start();
  const ticket = await next.promise;
  // Gateway-local execution is a trap: remote routing must never execute here.
  const local = new Proxy(backend, { get(target, key) {
    if (key === "run" || key === "stop" || key === "steer" || key === "submitThreadMessage") return () => { throw Error("Gateway-local write"); };
    return Reflect.get(target, key);
  } });
  const facade = withPeerBackend(local, registry);
  t.after(async () => { client.close(); registry.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, backend, facade, registry, server, client, ticket, thread, threads, runs, stops,
    get serverConnection() { return serverConnection; }, get clientConnection() { return clientConnection; },
    set run(value: typeof run) { run = value; },
    bind: (who = principal, guard = () => {}) => registry.connect(ticket.code, who, guard),
    as: <T>(action: () => T, who = principal) => peerPrincipal.run(who, action),
    input: (extra: Partial<CodexRunnerInput> = {}): CodexRunnerInput => ({ prompt: "继续任务", cwd: thread.cwd!, threadId: thread.threadId,
      hostId: ticket.hostId, clientUserMessageId: "source-one", assertCurrent() {}, ...extra }),
    async reconnect(reloadService = false) {
      if (reloadService) service = await PeerExecutionService.create({ backend, threadId: options.device ? undefined : thread.threadId, label: "我的笔记本", profileId: "work", stateDir: path.join(root, "client"),
        independent: true, approve: options.approve ?? (async () => true) });
      next = Promise.withResolvers(); serverConnection.close(); return next.promise;
    }
  };
}
