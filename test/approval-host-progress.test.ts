import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import type { CodexRunnerInput } from "../src/codex/backend.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

for (const hostId of ["local", "peer:other"])
  test(`approval progress respects the complete native host identity (${hostId})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-host-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new RuntimeStateStore(resolveStatePaths(root));
    const session = store.createSession("actor", root, "Original", undefined, "session", undefined, { standalone: true });
    store.setSessionThread(session.id, "same-thread");
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const activities: string[] = [];
    const service = new BridgeService({ stateStore: store,
      config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: true },
      createTextStream: () => ({ supported: true, checkpoint: () => ({}), async progress() {}, async answer() {},
        async finalize() { return true; }, async setActivity(value: string) { activities.push(value); } }) as never,
      weixin: { async sendText() { return { messageId: "sent" }; } },
      runner: {
        isIndependentObservation: () => true,
        async inspectThread() { return { threadId: "same-thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
        async run(input: CodexRunnerInput) {
          await input.onTurnStarted?.({ threadId: "same-thread", turnId: "same-turn" });
          started.resolve(); await finish.promise;
          return { threadId: "same-thread", turnId: "same-turn", text: "done", raw: "" };
        }
      } as never });
    const send = (text: string) => service.handleMessage({ id: text, senderId: "actor", text, raw: {} });
    const running = send("start"); await started.promise;
    try {
      // A project notification can legitimately route an approval from another
      // host to this conversation; it must not alter this bound task's progress.
      const approval = service.requestApproval("actor", { kind: "command", hostId, threadId: "same-thread", turnId: "same-turn", itemId: "approval", command: "pwd" });
      await new Promise<void>(resolve => setImmediate(resolve));
      await send("/reject A1"); assert.equal(await approval, "decline");
      assert.deepEqual(activities, hostId === "local" ? ["waiting-approval"] : []);
    } finally { finish.resolve(); await running; service.suspendUserInputs(); }
  });
