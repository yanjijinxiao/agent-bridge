import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import type { CodexThreadSnapshot } from "../src/codex/backend.js";

for (const receipt of ["error", "timeout"] as const) for (const proof of ["active", "terminal", "partial", "binding-change"] as const) {
  test(`DEL-08.13: receipt ${receipt} keeps provenance ${proof} independent from result authority`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "follow-receipt-repair-")), filePath = path.join(root, "state.json");
    const started = new Date(Date.now() - 600000).toISOString();
    fs.writeFileSync(filePath, JSON.stringify({ binding: { eventVersion: 2, deliveryVersion: 1, hostId: "local", threadId: "thread",
      turnId: "main", checkpointTurnId: "main", startedAt: started, sequence: 0, initialized: true,
      completed: ["main", "foreign-child"], baseline: [], delivered: [], checkpoint: {
        streamId: "old-card", messageId: "old-card", startedAt: Date.parse(started), progressEntries: [], thought: "", answerPreview: "",
        finished: true, terminal: { text: "OLD_PRESENTATION", error: false }
      } } }));
    const frames: Array<{ messageId: string; text: string; finalize?: boolean }> = [];
    const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "chat", managed: false,
      client: { resumableTextStream: true, async sendText() { throw Error("No unrelated notice"); },
        async startTextStream(input) { frames.push({ messageId: "current-card", text: input.text }); return { messageId: "current-card" }; },
        async updateTextStream(input) { frames.push(input); } } };
    const snapshot: CodexThreadSnapshot = { state: { threadId: "thread", persistence: "active", runtimeStatus: "active", activeFlags: [], activeTurnId: "main" },
      turns: [{ id: "main", status: "inProgress", startedAt: started, messages: [{ id: "progress", role: "assistant", kind: "progress", text: "ROOT_PROGRESS" }] }] };
    let release!: () => void, receiptReads = 0, resultEffects = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const hub = new ThreadEventHub({ filePath, readTimeoutMs: 30, subscriptions: () => [sub],
      onInputObservation() { receiptReads++; return receipt === "timeout" ? new Promise<void>(() => {}) : Promise.reject(Error("old receipt unavailable")); },
      applyResult: async () => { resultEffects++; return undefined; }, onRecoveredInputDelivered() { resultEffects++; },
      backend: () => ({ async readThreadSnapshot() { return structuredClone(snapshot); }, async readThreadProvenance() {
        await gate;
        return { threadId: "thread", complete: proof !== "partial", turns: [
          { id: "main", status: proof === "terminal" ? "completed" : "inProgress" }
        ] } as any;
      } }) });
    t.after(async () => { release(); await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    await hub.synchronize("binding");
    assert.equal(frames.length, 0, "an active snapshot alone cannot undo acknowledged completion");
    if (proof === "binding-change") sub.threadId = "replacement";
    release();
    if (proof === "active") {
      const deadline = Date.now() + 2000;
      while (!frames.some(frame => frame.messageId === "current-card" && frame.text.includes("ROOT_PROGRESS")) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(frames.some(frame => frame.messageId === "current-card" && frame.text.includes("ROOT_PROGRESS")),
        "complete matching native provenance restores progress despite old receipt failure");
      const state = JSON.parse(fs.readFileSync(filePath, "utf8")).binding;
      assert.equal(state.completed.includes("main"), false);
      assert.equal(state.provenanceVersion, 3);
      assert.ok(state.inputRecoveryFailure, "progress repair does not resolve the unrelated input receipt");
      assert.equal(hub.status("binding").status, "synced");
    } else {
      for (let n = 0; n < 12; n++) await new Promise<void>(resolve => setImmediate(resolve));
      await hub.stop();
      assert.equal(frames.length, 0, "terminal, incomplete or detached evidence cannot reopen an acknowledged card");
      assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).binding.completed.includes("main"), true);
    }
    assert.equal(receiptReads, 1);
    assert.equal(resultEffects, 0, "read-only progress repair never releases result side effects");
  });
}
