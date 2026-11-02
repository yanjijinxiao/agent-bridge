import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

for (const command of ["/goal", "/goal pause", "/goal set private original objective", "/goal clear"]) {
  for (const change of ["unchanged", "binding", "aba", "role", "access", "stopped"]) {
    const canReply = change === "unchanged" || command === "/goal" && change === "role";
    test(`${command}: a settled native response ${canReply ? `replies to its authorized source (${change})` : `does not reach a source changed by ${change}`}`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-goal-response-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const state = new RuntimeStateStore(resolveStatePaths(root));
      const project = state.createProject("Original", root, { hostId: "remote-original", projectKind: "remote" });
      const session = state.createSession("room", root, "Original", project.id);
      state.setSessionThread(session.id, "thread-original");
      state.setPairedSenderIds(["actor"]); state.setRole("room", "actor", "controller");
      const receiptsFile = path.join(root, "receipts.jsonl"), receipts = new InboundReceiptJournal(receiptsFile);
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const calls: Array<{ thread: string; host?: string; write: boolean }> = [], replies: string[] = [];
      // Mutation is confirmed in the native service before its response is
      // delayed. A later audience change cannot turn it into "not submitted".
      const response = async (thread: string, host?: string, write = false, guard?: () => void) => {
        guard?.(); calls.push({ thread, host, write }); entered.resolve(); await release.promise;
        return { threadId: thread, objective: "private original objective", status: "paused" as const,
          tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 };
      };
      const service = new BridgeService({ stateStore: state, inputReceipts: receipts,
        config: { ...defaultConfig(root), streamReplies: false },
        channel: createChannelClient("generic", TEXT_CAPABILITIES, {
          async sendText(input) { replies.push(input.text); return { messageId: "sent" }; }
        }),
        runner: { backendInfo() { return { id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }; },
          getGoal: (thread: string, host?: string) => response(thread, host),
          setGoal: (thread: string, _input: unknown, host?: string, guard?: () => void) => response(thread, host, true, guard),
          clearGoal: async (thread: string, host?: string, guard?: () => void) => { await response(thread, host, true, guard); }
        } as never
      });
      const message = { id: "goal-source", senderId: "actor", replyTargetId: "room", text: command, attachments: [], raw: {} };
      const pending = receipts.handle(message, () => service.handleMessage(message));
      await entered.promise;
      if (change === "binding" || change === "aba") state.setSessionThread(session.id, "thread-replacement");
      if (change === "aba") state.setSessionThread(session.id, "thread-original");
      if (change === "role") state.setRole("room", "actor", "viewer");
      if (change === "access") state.setPairedSenderIds([]);
      if (change === "stopped") service.suspendUserInputs();
      release.resolve(); await pending;
      assert.deepEqual(calls, [{ thread: "thread-original", host: "remote-original", write: command !== "/goal" }]);
      assert.equal(new InboundReceiptJournal(receiptsFile).receipt(message.id)?.phase, "handled");
      assert.equal(new InboundReceiptJournal(receiptsFile).claim(message), false);
      if (canReply) {
        assert.equal(replies.length, 1);
        assert.match(replies[0], command === "/goal clear" ? /已清除/ : /private original objective/);
      } else assert.deepEqual(replies, []);
    });
  }
}
