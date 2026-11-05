import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";

test("history defaults to 20 public messages and more consumes the remaining snapshot without repeats", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-history-density-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const session = store.createSession("alice", root, "History");
  store.setSessionThread(session.id, "thread");
  const texts: string[] = [], cursors: (string | undefined)[] = [];
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["alice"] }, stateStore: store,
    weixin: { async sendText(x) { texts.push(x.text); return { messageId: "m" }; } },
    runner: { async getHistoryPage(_id: string, input: { cursor?: string }) {
      cursors.push(input.cursor);
      const end = input.cursor ? Number(input.cursor) : 30, start = end - 10;
      return { messages: Array.from({ length: 10 }, (_, i) => ({ id: `h${start + i}`, role: "user", text: `history-entry-${start + i};` })),
        ...(start > 0 ? { nextCursor: String(start) } : {}) };
    } } as never });
  await service.handleMessage({ id: "h1", senderId: "alice", text: "/history", raw: {} });
  const first = texts.join("\n"); texts.length = 0;
  assert.match(first, /最近 20 条/);
  assert.deepEqual([...first.matchAll(/history-entry-(\d+);/g)].map(m => Number(m[1])), Array.from({ length: 20 }, (_, i) => i + 10));
  await service.handleMessage({ id: "h2", senderId: "alice", text: "/history more", raw: {} });
  const second = texts.join("\n");
  assert.match(second, /更早的 10 条/);
  assert.deepEqual([...second.matchAll(/history-entry-(\d+);/g)].map(m => Number(m[1])), Array.from({ length: 10 }, (_, i) => i));
  assert.deepEqual(cursors, [undefined, "20", "10"]);
});

test("queue listing shows 50 recent receipts and only cancellation choices for those visible rows", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-queue-density-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const texts: string[] = [];
  const rows = Array.from({ length: 51 }, (_, i) => ({ queuedSubmissionId: `receipt-${String(i).padStart(3, "0")}`, status: "queued", actorId: "alice", threadId: "thread" }));
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["alice"] },
    accountId: "bot", stateStore: new RuntimeStateStore(resolveStatePaths(root)), runner: {} as never,
    nativeQueue: { async reconcile() {}, list(account: string, chat: string) { assert.equal(account, "bot"); assert.equal(chat, "alice"); return rows; } } as never,
    weixin: { async sendText(x) { texts.push(x.text); return { messageId: "m" }; } } });
  await service.handleMessage({ id: "q1", senderId: "alice", text: "/queue", raw: {} });
  const text = texts.join("\n");
  assert.match(text, /显示最近 50 条，共 51 条回执/);
  assert.doesNotMatch(text, /receipt-000/);
  assert.equal([...text.matchAll(/receipt-\d{3} · queued/g)].length, 50);
  assert.equal([...text.matchAll(/\/queue cancel receipt-\d{3}/g)].length, 50);
});
