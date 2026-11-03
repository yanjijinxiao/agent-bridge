import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { PeerExecutionService } from "../src/peer/execution-service.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { withPeerBackend } from "../src/peer/backend.js";
import { GatewayPeerClient, GatewayPeerServer } from "../src/peer/transport.js";
import { peerPrincipal } from "../src/peer/context.js";
// @ts-expect-error JS fixture owns a real installed native daemon and local model.
import { sharedNativeCore, message, until } from "./fixtures/shared-native-core.mjs";

test("real native Connector preserves queued source receipts across disconnect without replay", {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 40000
}, async t => {
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const core = await sharedNativeCore(t, async (_body: unknown, n: number) => { if (n === 1) await release.promise; return message(`CONTRACT_${n}`, n); });
  const native = new CodexAppServerGateway({ appServerBackend: core.runner() });
  const created = await native.createThread({ cwd: core.root, projectBinding: "none" });
  const serviceOptions = { backend: native, profileId: "real", stateDir: path.join(core.root, "connector"), independent: true, approve: async () => true };
  let service = await PeerExecutionService.create(serviceOptions);
  const registry = new PeerRegistry(path.join(core.root, "gateway-grants.json"));
  const server = await GatewayPeerServer.listen({ host: "127.0.0.1", port: 0, credentials: { test: "synthetic-real-contract-token-for-tests-only" }, accept: (id, c) => registry.accept(id, c) });
  let connected = Promise.withResolvers<{ hostId: string; code: string }>();
  const client = new GatewayPeerClient({ url: server.url, nodeId: "test", token: "synthetic-real-contract-token-for-tests-only", reconnectMs: 20,
    connected: async c => { service.attach(c); connected.resolve(await c.request("peer.register", service.description)); } });
  const facade = withPeerBackend(native, registry);
  t.after(async () => { release.resolve(); client.close(); registry.close(); await server.close(); await facade.close(); });
  client.start(); const ticket = await connected.promise;
  const principal = { accountId: "real-test", conversationId: "real-chat", actorId: "real-owner" };
  await registry.connect(ticket.code, principal, () => {});
  const as = <T>(action: () => Promise<T>) => peerPrincipal.run(principal, action);
  const input = { hostId: ticket.hostId, threadId: created.threadId, cwd: core.root, prompt: "first", clientUserMessageId: "first", assertCurrent() {} };
  const running = as(() => facade.run(input)); void running.catch(() => {});
  await Promise.race([until(() => core.calls.length === 1), running.then(() => { throw Error("Turn ended before model request"); })]);
  const queued = await as(() => facade.addQueuedSubmission!({ threadId: created.threadId, prompt: "second", clientUserMessageId: "queue-original", assertCurrent() {} }, ticket.hostId));
  assert.equal(queued.clientUserMessageId, "queue-original");
  assert.equal((await as(() => facade.listQueuedSubmissions!(created.threadId, undefined, ticket.hostId))).data[0].clientUserMessageId, "queue-original");
  connected = Promise.withResolvers(); service = await PeerExecutionService.create(serviceOptions);
  registry.close(); await connected.promise; await assert.rejects(running);
  release.resolve();
  let matched = false, queuedTurn: string | undefined;
  for (let attempt = 0; attempt < 100 && !matched; attempt++) {
    const history = await as(() => facade.getHistoryPage(created.threadId, { limit: 100 }, ticket.hostId));
    queuedTurn = history.messages.find(m => m.clientUserMessageId === "queue-original")?.turnId;
    matched = Boolean(queuedTurn);
    if (!matched) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(matched, true, "the source ID remains recoverable after loading the device journal again");
  // Native history records acceptance before the model request is dispatched.
  // Wait for the owner-confirmed end, not merely the input appearing in history.
  let completed = false;
  for (let attempt = 0; attempt < 100 && !completed; attempt++) {
    const observed = await as(() => facade.readTurnLifecycle!(created.threadId, queuedTurn!, ticket.hostId));
    completed = observed.status === "completed" && observed.source !== "unknown";
    if (!completed) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(completed, true, "the native owner confirms the queued turn finished");
  assert.equal(core.calls.length, 2, "the queued prompt was consumed exactly once");
});
