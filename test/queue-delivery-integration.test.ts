import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { NativeQueueCoordinator } from "../src/bridge/native-queue.js";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { APP_SERVER_BACKEND_CAPABILITIES, type CodexThreadSnapshot, type CodexQueueAddInput, type CodexQueuedRunInput, type CodexRunResult } from "../src/codex/backend.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { AccountManager } from "../src/server/account-manager.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { defaultConfig } from "../src/state/config.js";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { saveAccount } from "../src/weixin/accounts.js";

type Outcome = "completed" | "failed" | "interrupted";

async function fixture(t: test.TestContext, status: Outcome, newer: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-queue-delivery-")), paths = resolveStatePaths(root);
  const accountId = "fixture", threadId = "thread", oldTurn = "old-turn";
  saveAccount(paths, { accountId, token: "isolated-fixture", baseUrl: "https://example.test", enabled: true, savedAt: "" });
  const store = new RuntimeStateStore(accountStatePaths(paths, accountId));
  const session = store.createSession("room", root, "Task", undefined, "session", undefined, { standalone: true });
  store.setSessionThread(session.id, threadId);
  const starts: Array<{ streamId?: string; text: string }> = [], updates: Array<{ messageId: string; text: string; finalize?: boolean }> = [], texts: string[] = [];
  const client = createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, progress: "available", resumableProgress: true }, {
    async sendText(input) { texts.push(input.text); return { messageId: `text-${texts.length}` }; },
    async startTextStream(input) { starts.push(input); return { messageId: input.streamId! }; },
    async updateTextStream(input) { updates.push(input); }
  });
  let adds = 0, nativeStarts = 0;
  let liveRun: ((input: CodexQueuedRunInput) => Promise<CodexRunResult>) | undefined;
  const activity: boolean[] = [], accepted: Array<string | undefined> = [];
  let queued: Array<{ id: string; clientUserMessageId: string; input: { type: "text"; text: string }[] }> = [];
  const snapshot: CodexThreadSnapshot = {
    state: { threadId, persistence: "active", runtimeStatus: newer ? "active" : "idle", activeFlags: [],
      ...(newer ? { activeTurnId: "new-turn" } : {}) },
    turns: [{ id: oldTurn, status, messages: [{ id: "old-result", role: "assistant", text: "OLD_RESULT" }] },
      ...(newer ? [{ id: "new-turn", status: "inProgress" as const,
        messages: [{ id: "current-progress", role: "assistant" as const, kind: "progress" as const, text: "CURRENT_PROGRESS" }] }] : [])]
  };
  let clientId = "";
  // Native API, channel transport and unrelated monitors are explicit test
  // ports. Manager callbacks, facade, Bridge, Hub and journals stay production.
  const native = {
    id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES,
    async warmUp() {}, close() {},
    async inspectThread() { return structuredClone(snapshot.state); },
    async readThreadSnapshot() { return structuredClone(snapshot); },
    async listProjects() { return { backend: "app-server", projects: [] }; },
    async getHistoryPage() { return { messages: [{ id: "original-user-message", role: "user" as const, text: "queued input", clientUserMessageId: clientId, turnId: oldTurn }] }; },
    async getHistory() { return []; },
    async addQueuedSubmission(input: CodexQueueAddInput) {
      adds++; clientId = input.clientUserMessageId;
      const item = { id: "queued", clientUserMessageId: clientId, input: [{ type: "text" as const, text: input.prompt }] };
      queued.push(item); return item;
    },
    async listQueuedSubmissions() { return { data: structuredClone(queued) }; },
    async deleteQueuedSubmission() { assert.fail("recovery cannot delete input"); },
    async runQueuedSubmission(input: CodexQueuedRunInput) {
      nativeStarts++; if (liveRun) return liveRun(input);
      assert.fail("terminal recovery must use the facade's read-only path");
    },
    async run() { nativeStarts++; assert.fail("recovery cannot create a replacement turn"); }
  };
  const queueFile = path.join(paths.runtimeDir, "native-submissions.json");
  const admission = new CodexAppServerGateway({ appServerBackend: native as never });
  t.after(() => admission.close());
  const queue = new NativeQueueCoordinator(queueFile);
  await queue.enqueue({ accountId, conversationId: "room", actorId: "actor", messageId: "original-input",
    sessionId: session.id, hostId: "local", backend: "app-server", threadId }, "queued input", admission);
  queued = [];
  // Deliver through the real Hub, leaving queue settlement for a later owner.
  const followFile = path.join(paths.runtimeDir, "thread-subscriptions.json"), key = JSON.stringify([accountId, session.id]);
  const sub: ThreadSubscription = { key, hostId: "local", threadId, recipientId: "room", client, managed: true };
  const hub = new ThreadEventHub({ filePath: followFile, subscriptions: () => [sub], backend: () => native });
  t.after(() => hub.stop());
  const oldStream = await hub.prepareManagedStream(sub, oldTurn); await oldStream.progress("OLD_PROGRESS");
  await hub.capacityTerminal({ hostId: "local", threadId, turnId: oldTurn }, "OLD_RESULT", status);
  assert.ok(JSON.parse(fs.readFileSync(followFile, "utf8"))[key].completed.includes(oldTurn));
  assert.ok(updates.some(item => item.finalize && item.text.includes("OLD_RESULT")));
  if (newer) {
    const next = await hub.prepareManagedStream(sub, "new-turn"); await next.progress("CURRENT_PROGRESS");
  }
  await hub.stop();
  const before = JSON.parse(fs.readFileSync(followFile, "utf8"))[key];
  const counts = () => ({ starts: starts.length, updates: updates.length, texts: texts.length });
  const beforeCounts = counts();
  const managers: AccountManager[] = [];
  t.after(async () => { for (const manager of managers) await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  async function owner() {
    let service!: BridgeService;
    const gateway = new CodexAppServerGateway({ appServerBackend: native as never });
    const monitor = () => ({ start() {}, stop() {}, setFollowedThreads() {} }) as never;
    const manager = new AccountManager({ paths,
      configProvider: () => ({ ...defaultConfig(root), allowedSenderIds: ["actor"] }),
      runnerFactory: () => gateway,
      codexSessionMonitorFactory: monitor, codexDesktopRequestMonitorFactory: monitor,
      adapterFactory: () => ({ client, async monitor(options) {
        options.onStatus?.({ state: "connected" });
        await new Promise<void>(resolve => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      } }),
      bridgeFactory: input => {
        service = new BridgeService({ ...input,
          onTurnStatus(event) { activity.push(event.active); input.onTurnStatus?.(event); },
          onTurnStarted(session, turnId, status) { accepted.push(status); return input.onTurnStarted?.(session, turnId, status); }
        }); return service;
      }
    });
    managers.push(manager); await manager.startAccount(accountId, false);
    return { manager, service };
  }
  return { owner, counts, beforeCounts, before, queueFile, followFile, key, session, activity, accepted, updates,
    ownerStillRunning() {
      snapshot.state.runtimeStatus = "active"; snapshot.state.activeTurnId = oldTurn;
      snapshot.turns[0].status = "inProgress";
    },
    async queueLiveInput() {
      const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      await new NativeQueueCoordinator(queueFile).enqueue({ accountId, conversationId: "room", actorId: "actor", messageId: "live-input",
        sessionId: session.id, hostId: "local", backend: "app-server", threadId }, "next queued input", admission);
      liveRun = async input => {
        input.onQueueStarting?.(); queued = [];
        snapshot.state.runtimeStatus = "active"; snapshot.state.activeTurnId = "live-turn";
        snapshot.turns.push({ id: "live-turn", status: "inProgress", messages: [] });
        await input.onTurnStarted?.({ threadId, turnId: "live-turn", status: "inProgress" });
        await input.onProgress?.("LIVE_PROGRESS"); started.resolve();
        await release.promise;
        snapshot.state.runtimeStatus = "idle"; delete snapshot.state.activeTurnId;
        snapshot.turns.at(-1)!.status = "completed";
        return { threadId, turnId: "live-turn", text: "LIVE_RESULT", raw: "" };
      };
      return { started: started.promise, finish: () => release.resolve() };
    },
    get adds() { return adds; }, get nativeStarts() { return nativeStarts; } };
}

for (const status of ["completed", "failed", "interrupted"] as const) for (const newer of [false, true]) {
  test(`CTRL-03.3: ${status} queue recovery preserves acknowledged cards across AccountManager reconstruction (newer=${newer})`, async t => {
    const f = await fixture(t, status, newer);
    for (let generation = 0; generation < 2; generation++) {
      const { manager, service } = await f.owner();
      await service.recoverNativeQueue(); await service.recoverNativeQueue();
      const receipt = new NativeQueueCoordinator(f.queueFile).list("fixture")[0];
      assert.equal(receipt.status, "completed"); assert.equal(receipt.delivered, true); assert.equal(receipt.turnId, "old-turn");
      assert.deepEqual(f.counts(), f.beforeCounts, "no progress creation, old final replay or text fallback");
      const current = JSON.parse(fs.readFileSync(f.followFile, "utf8"))[f.key];
      assert.equal(current.turnId, f.before.turnId); assert.equal(current.checkpointTurnId, f.before.checkpointTurnId);
      assert.deepEqual(current.checkpoint, f.before.checkpoint, "late recovery cannot change the newer card or the completed original");
      assert.equal(manager.listSessions().find(s => s.id === f.session.id)?.responding, false);
      assert.deepEqual(f.activity, [], "terminal identity never transiently marks the task active");
      assert.deepEqual(f.accepted, [status], "the second owner uses durable settlement rather than announcing acceptance again");
      await manager.stopAll();
    }
    assert.equal(f.adds, 1); assert.equal(f.nativeStarts, 0);
  });
}

test("CTRL-03.3: a conflicting live native owner is not settled or reopened from a historical delivery receipt", async t => {
  const f = await fixture(t, "completed", false); f.ownerStillRunning();
  for (let generation = 0; generation < 2; generation++) {
    const { manager, service } = await f.owner(); await service.recoverNativeQueue();
    const receipt = new NativeQueueCoordinator(f.queueFile).list("fixture")[0];
    assert.equal(receipt.status, "running"); assert.equal(receipt.delivered, undefined);
    assert.deepEqual(f.counts(), f.beforeCounts); assert.deepEqual(f.activity, []); assert.deepEqual(f.accepted, []);
    await manager.stopAll();
  }
  assert.equal(f.adds, 1); assert.equal(f.nativeStarts, 0);
});

test("CTRL-03.3: a genuinely pending queue item still creates one live card and delivers its own final through AccountManager", async t => {
  const f = await fixture(t, "completed", false);
  const initial = await f.owner(); await initial.service.recoverNativeQueue(); await initial.manager.stopAll();
  const live = await f.queueLiveInput(), { manager, service } = await f.owner();
  const running = service.recoverNativeQueue();
  try {
    await Promise.race([live.started, running.then(() => { throw Error("queue dispatch ended before native acceptance"); })]);
    assert.equal(f.counts().starts, f.beforeCounts.starts + 1);
    assert.equal(manager.listSessions().find(s => s.id === f.session.id)?.responding, true);
    assert.deepEqual(f.activity, [true]);
  } finally { live.finish(); }
  await running;
  assert.deepEqual(f.activity, [true, false]); assert.deepEqual(f.accepted, ["completed", "inProgress"]);
  assert.equal(manager.listSessions().find(s => s.id === f.session.id)?.responding, false);
  assert.equal(f.updates.filter(item => item.finalize && item.text.includes("LIVE_RESULT")).length, 1);
  const counts = f.counts(); await service.recoverNativeQueue(); assert.deepEqual(f.counts(), counts);
  assert.equal(f.adds, 2); assert.equal(f.nativeStarts, 1);
  const receipts = new NativeQueueCoordinator(f.queueFile).list("fixture");
  assert.equal(receipts.length, 2); assert.ok(receipts.every(item => item.delivered));
});
