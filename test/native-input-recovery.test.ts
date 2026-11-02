import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { findNativeInputReceipts } from "../src/bridge/native-input-recovery.js";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { ForwardingInbox } from "../src/bridge/forwarding-inbox.js";
import { TurnSubmission } from "../src/bridge/turn-submission.js";
import { AccountManager } from "../src/server/account-manager.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import type { CodexHistoryPage, CodexHistoryMessage } from "../src/codex/backend.js";

const scope = { hostId: "original-host", threadId: "original-thread" };
const user = (clientUserMessageId = "exact", turnId = "turn"): CodexHistoryMessage => ({ id: "message", role: "user", text: "same body", clientUserMessageId, turnId });
const source = { id: "source-id", senderId: "actor", replyTargetId: "room", text: "ordinary input", attachments: [], raw: {} };
const settle = async () => { for (let n = 0; n < 6; n++) await new Promise<void>(resolve => setImmediate(resolve)); };

test("acceptance observation uses exact client IDs across complete pages on the original host/thread", async () => {
  const reads: unknown[] = [];
  const matches = await findNativeInputReceipts({ async getHistoryPage(thread, input, host) {
    reads.push({ thread, input, host });
    return input?.cursor ? { messages: [user()] } : { messages: [user("other"), { ...user(), role: "assistant" }], nextCursor: "older" };
  } }, scope, new Set(["exact"]));
  assert.deepEqual([...matches], [["exact", "turn"]]);
  assert.deepEqual(reads, [undefined, "older"].map(cursor => ({ thread: scope.threadId, host: scope.hostId,
    input: { cursor, limit: 100, sortDirection: "desc" } })));
});

test("same text, missing IDs/turns and cross-turn duplicate IDs do not confirm acceptance", async () => {
  for (const messages of [[user("different")], [{ ...user(), clientUserMessageId: undefined }],
    [user(), user("exact", "second-turn")], [user(), { ...user(), turnId: undefined }]]) {
    const result = await findNativeInputReceipts({ async getHistoryPage() { return { messages }; } }, scope, new Set(["exact"]));
    assert.equal(result.size, 0);
  }
  const repeated = await findNativeInputReceipts({ async getHistoryPage() { return { messages: [user(), user()] }; } }, scope, new Set(["exact"]));
  assert.equal(repeated.get("exact"), "turn");
});

test("an early matching page cannot confirm before a later error, repeated cursor or scan limit", async () => {
  let pages = 0;
  await assert.rejects(findNativeInputReceipts({ async getHistoryPage() {
    if (pages++) throw Error("offline"); return { messages: [user()], nextCursor: "more" };
  } }, scope, new Set(["exact"])), /offline/);
  await assert.rejects(findNativeInputReceipts({ async getHistoryPage() { return { messages: [user()], nextCursor: "loop" }; } }, scope, new Set(["exact"])), /cursor/);
  await assert.rejects(findNativeInputReceipts({ async getHistoryPage() { return { messages: [user()], nextCursor: "more" }; } }, scope, new Set(["exact"]), { maxPages: 1 }), /budget/);
});

test("bounded receipt reads retire without confirming a late native response", async () => {
  const pending = Promise.withResolvers<CodexHistoryPage>();
  const read = findNativeInputReceipts({ getHistoryPage: () => pending.promise }, scope, new Set(["exact"]), { timeoutMs: 15 });
  await assert.rejects(read, /timed out/); pending.resolve({ messages: [user()] }); await settle();
});

function journalFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-native-recovery-")), file = path.join(root, "receipts.jsonl");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let cleaned = 0;
  const journal = new InboundReceiptJournal(file, [], { onAccepted: () => cleaned++ });
  return { root, file, journal, get cleaned() { return cleaned; } };
}
async function unknown(journal: InboundReceiptJournal) {
  await assert.rejects(journal.handle(source, async () => {
    journal.capture()!.submitting({ ...scope, sessionId: "session", nativeInput: true }); throw Error("lost native receipt");
  }), /lost native receipt/);
  return journal.receipt(source.id)!;
}

test("recovered acceptance is durable before cleanup and never reopens a claim", async t => {
  const f = journalFixture(t), expected = await unknown(f.journal);
  assert.equal(f.journal.recoverAccepted(expected, { ...scope, turnId: "turn" }), true);
  assert.equal(f.cleaned, 1);
  const restarted = new InboundReceiptJournal(f.file);
  assert.equal(restarted.receipt(source.id)?.phase, "accepted"); assert.equal(restarted.receipt(source.id)?.turnId, "turn");
  assert.equal(restarted.claim(source), false);
  assert.equal(f.journal.recoverAccepted(expected, { ...scope, turnId: "turn" }), false); assert.equal(f.cleaned, 1);
});

test("recovery rejects wrong scope, live handoffs and stale journal versions", async t => {
  const f = journalFixture(t), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const active = f.journal.handle(source, async () => {
    f.journal.submitting({ ...scope, sessionId: "session" }); entered.resolve(); await finish.promise; throw Error("unknown");
  });
  await entered.promise; const live = f.journal.receipt(source.id)!;
  assert.equal(f.journal.recoverAccepted(live, { ...scope, turnId: "turn" }), false);
  finish.resolve(); await assert.rejects(active);
  assert.equal(f.journal.recoverAccepted(live, { ...scope, turnId: "turn" }), false);
  const expected = f.journal.receipt(source.id)!;
  assert.equal(f.journal.recoverAccepted(expected, { ...scope, hostId: "another", turnId: "turn" }), false);
  assert.equal(f.journal.recoverAccepted(expected, { ...scope, threadId: "another", turnId: "turn" }), false);
  assert.equal(f.cleaned, 0); assert.equal(f.journal.receipt(source.id)?.phase, "unconfirmed");
});

test("recovery fsync failure retains the unknown receipt and saved source, then safely retries", async t => {
  const f = journalFixture(t), expected = await unknown(f.journal), sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error("disk unavailable"); };
  try { assert.throws(() => f.journal.recoverAccepted(expected, { ...scope, turnId: "turn" }), /disk unavailable/); }
  finally { fs.fsyncSync = sync; }
  assert.equal(f.cleaned, 0); assert.deepEqual(f.journal.receipt(source.id), expected);
  const restarted = new InboundReceiptJournal(f.file);
  assert.equal(restarted.receipt(source.id)?.phase, "unconfirmed");
  assert.equal(restarted.recoverAccepted(expected, { ...scope, turnId: "turn" }), true);
});

test("recovered output obligations survive restart and settle only for their exact durable receipt", async t => {
  const f = journalFixture(t), expected = await unknown(f.journal);
  f.journal.recoverAccepted(expected, { ...scope, turnId: "turn" });
  const restarted = new InboundReceiptJournal(f.file), recovered = restarted.receipt(source.id)!;
  assert.equal(recovered.recoveredNativeInput, true);
  restarted.recoveredResultDelivered({ ...recovered, turnId: "another" });
  assert.equal(restarted.receipt(source.id)?.phase, "accepted");
  restarted.recoveredResultDelivered(recovered); restarted.recoveredResultDelivered(recovered);
  assert.equal(new InboundReceiptJournal(f.file).receipt(source.id)?.phase, "handled");
});

test("new-thread identity must be durable before turn/start can submit any native input", async t => {
  const f = journalFixture(t); let inputs = 0; const sync = fs.fsyncSync;
  await assert.rejects(f.journal.handle(source, async () => {
    const turn = new TurnSubmission(f.journal, "session");
    await turn.run({ async run(input) {
      fs.fsyncSync = () => { throw Error("thread identity disk failure"); };
      try { await input.onThreadCreated?.("new-thread"); } finally { fs.fsyncSync = sync; }
      inputs++; return { threadId: "new-thread", turnId: "turn", text: "unexpected", raw: "" };
    } }, { cwd: f.root, hostId: scope.hostId, prompt: "work" });
  }));
  assert.equal(inputs, 0); assert.equal(new InboundReceiptJournal(f.file).receipt(source.id)?.threadId, undefined);
});

async function managerFixture(t: test.TestContext, options: { command?: boolean; legacy?: boolean } = {}) {
  const f = journalFixture(t), paths = resolveStatePaths(path.join(f.root, "gateway"));
  saveAccount(paths, { accountId: "fixture", token: "synthetic", baseUrl: "https://example.test", enabled: false });
  const statePaths = accountStatePaths(paths, "fixture"), store = new RuntimeStateStore(statePaths);
  const session = store.createSession("room", f.root, "Original", undefined, "session", undefined, { standalone: true });
  store.setSessionThread(session.id, scope.threadId);
  const receiptFile = path.join(paths.runtimeDir, "fixture", "inbound-receipts.jsonl"), journal = new InboundReceiptJournal(receiptFile);
  const message = { ...source, text: options.command ? "/queue do work" : source.text };
  const inbox = new ForwardingInbox({ filePath: path.join(paths.runtimeDir, "fixture", "forwarding-inbox.json"), receipts: journal,
    target: () => ({ sessionId: session.id, ...scope, workspace: f.root, mode: "session", roots: [] }),
    canDispatch: () => false, automatic: () => true, dispatch: async () => assert.fail("no replay"), notice: async () => {} });
  inbox.claim(message);
  await assert.rejects(journal.handle(message, async () => {
    journal.capture()!.submitting({ ...scope, sessionId: session.id, ...(!options.legacy ? { nativeInput: true as const } : {}) }); throw Error("lost receipt");
  }));
  const expected = journal.receipt(source.id)!, entered = Promise.withResolvers<void>(), response = Promise.withResolvers<CodexHistoryPage>();
  let reads = 0, writes = 0;
  const manager = new AccountManager({ paths, configProvider: () => ({ ...defaultConfig(f.root), allowedSenderIds: ["actor"], taskboardEnabled: false }),
    ideProjectsProvider: () => [], channelCapabilities: () => [],
    runnerFactory: () => ({ async warmUp() {}, async listProjects() { return { projects: [] }; }, async getRuntimeInfo() { return {}; },
      async getHistoryPage(thread: string, _input: unknown, host: string) {
        assert.equal(thread, scope.threadId); assert.equal(host, scope.hostId); reads++; entered.resolve(); return response.promise;
      }, async run() { writes++; assert.fail("recovery must not run input"); }, close() {} }) as never,
    codexSessionMonitorFactory: () => ({ start() {}, stop() {} }) as never,
    codexDesktopRequestMonitorFactory: () => ({ start() {}, stop() {}, setFollowedThreads() {} }) as never,
    adapterFactory: () => ({ client: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText() { return { messageId: "notice" }; } }),
      async monitor(input) { input.onStatus?.({ state: "connected" }); await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true })); } }) });
  t.after(async () => { response.resolve({ messages: [] }); await manager.stopAll(); });
  await manager.startAccount("fixture", false);
  const ownerStore = (manager as unknown as { stores: Map<string, RuntimeStateStore> }).stores.get("fixture")!;
  return { manager, store: ownerStore, session, receiptFile, expected, entered, response, get reads() { return reads; }, get writes() { return writes; } };
}

test("a retired account cannot commit a late native receipt and readonly recovery does not block release", async t => {
  const f = await managerFixture(t); await f.entered.promise;
  const owner = crypto.randomUUID();
  assert.equal(f.manager.prepareRelease(owner).prepared, true); assert.equal(f.manager.cancelRelease(owner), true);
  await f.manager.stopAccount("fixture", false);
  f.response.resolve({ messages: [user(f.expected.clientUserMessageId)] }); await settle();
  assert.equal(new InboundReceiptJournal(f.receiptFile).receipt(source.id)?.phase, "unconfirmed"); assert.equal(f.writes, 0);
});

test("legacy ordinary inbox sources recover but legacy queue/control messages remain unknown", async t => {
  const ordinary = await managerFixture(t, { legacy: true }); await ordinary.entered.promise;
  ordinary.response.resolve({ messages: [user(ordinary.expected.clientUserMessageId)] }); await settle();
  assert.equal(new InboundReceiptJournal(ordinary.receiptFile).receipt(source.id)?.phase, "accepted");
  const command = await managerFixture(t, { legacy: true, command: true }); await settle();
  assert.equal(command.reads, 0); assert.equal(command.writes, 0);
  assert.equal(new InboundReceiptJournal(command.receiptFile).receipt(source.id)?.phase, "unconfirmed");
});

test("a changed binding never becomes the native receipt lookup target", async t => {
  const f = await managerFixture(t); await f.entered.promise;
  f.store.setSessionThread(f.session.id, "new-thread");
  f.response.resolve({ messages: [user(f.expected.clientUserMessageId)] }); await settle();
  const restored = new InboundReceiptJournal(f.receiptFile).receipt(source.id)!;
  assert.equal(restored.threadId, scope.threadId); assert.equal(restored.phase, "accepted");
  assert.equal(f.store.getSession(f.session.id)?.threadId, "new-thread"); assert.equal(f.writes, 0);
});

test("a recovered old result waits for the current turn without replaying unrelated history or replacing active progress", async t => {
  const f = journalFixture(t), output: string[] = []; let active = true, obligations = ["old"], settled = 0;
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "room", managed: false,
    client: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText(input) { output.push(input.text); return { messageId: String(output.length) }; } }) };
  const hub = new ThreadEventHub({ filePath: path.join(f.root, "follow.json"), subscriptions: () => [sub],
    recoveredInputTurns: () => obligations, onRecoveredInputDelivered: (_sub, turn) => {
      if (!obligations.includes(turn)) return;
      assert.equal(turn, "old"); settled++; obligations = [];
    }, backend: () => ({ async readThreadSnapshot() { return {
      state: { threadId: "thread", persistence: "active", runtimeStatus: active ? "active" : "idle", activeFlags: [], ...(active ? { activeTurnId: "new" } : {}) },
      turns: [
        { id: "unrelated", status: "completed", messages: [{ id: "foreign", role: "assistant", text: "UNRELATED_HISTORY" }] },
        { id: "old", status: "completed", messages: [{ id: "answer-old", role: "assistant", text: "RECOVERED_ANSWER" }] },
        { id: "new", status: active ? "inProgress" : "completed", messages: active ? [] : [{ id: "answer-new", role: "assistant", text: "CURRENT_ANSWER" }] }
      ]
    }; } }) });
  t.after(() => hub.stop());
  await hub.refresh(); assert.equal(output.includes("RECOVERED_ANSWER"), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "follow.json"), "utf8")).binding.turnId, "new");
  active = false; await hub.refresh(); await hub.refresh(); await hub.refresh();
  assert.equal(output.filter(text => text === "RECOVERED_ANSWER").length, 1);
  assert.equal(output.filter(text => text === "CURRENT_ANSWER").length, 1);
  assert.equal(output.some(text => text.includes("UNRELATED_HISTORY")), false); assert.equal(settled, 1);
});
