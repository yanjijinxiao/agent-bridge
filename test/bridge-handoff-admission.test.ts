import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { ForwardingDeferredError } from "../src/bridge/forwarding-error.js";
import { CodexRunAdmissionError, type CodexRunnerInput } from "../src/codex/backend.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

for (const accepted of [false, true]) test(`Bridge rejects a competing start promptly while the original input is ${accepted ? "accepted" : "in handoff"}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-bridge-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const project = store.createProject("Fixture", root);
  const session = store.createSession("actor", root, "Fixture", project.id);
  store.setSessionThread(session.id, "thread");
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const statuses: boolean[] = [], activities: string[] = [];
  let streams = 0;
  let starts = 0;
  const service = new BridgeService({ stateStore: store,
    config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: true },
    onTurnStatus: ({ active }) => statuses.push(active),
    createTextStream() {
      const id = streams++;
      return { supported: true, checkpoint: () => ({}), async progress() {}, async answer() {},
        async finalize() { return true; }, async setActivity(activity: string) { activities.push(`${id}:${activity}`); }
      } as never;
    },
    weixin: { async sendText() { return { messageId: "sent" }; } },
    runner: {
      isIndependentObservation() { return true; },
      // Deliberately stale preflight: native start is the final acceptance authority.
      async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
      async run(input: CodexRunnerInput) {
        if (++starts > 1) throw new CodexRunAdmissionError("active", "thread");
        if (accepted) await input.onTurnStarted?.({ threadId: "thread", turnId: "turn" });
        started.resolve(); await finish.promise;
        return { threadId: "thread", turnId: "turn", text: "done", raw: "" };
      }
    } as never
  });
  const send = (id: string) => service.handleMessage({ id, senderId: "actor", text: id, raw: {} });
  const first = send("first"); await started.promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const second = send("second").then(() => undefined, error => error);
    const outcome = await Promise.race([second, new Promise(resolve => { timer = setTimeout(() => resolve("still waiting for whole turn"), 150); })]);
    if (accepted) assert.ok(outcome instanceof CodexRunAdmissionError, String(outcome));
    else assert.ok(outcome instanceof ForwardingDeferredError, String(outcome));
    assert.equal(starts, accepted ? 2 : 1);
    if (accepted) {
      assert.equal(service.hasRestartBlockingWork(), false, "accepted independent turn does not lock restart");
      const question = service.requestUserInput("actor", { threadId: "thread", turnId: "turn", itemId: "item", requestId: "question",
        questions: [{ id: "location", header: "Location", question: "Where?" }], autoResolutionMs: null });
      await new Promise<void>(resolve => setImmediate(resolve));
      await send("/skip Q1"); await question;
      assert.deepEqual({ statuses, activities }, { statuses: [true], activities: ["0:waiting-input"] },
        "a rejected competing start cannot mark the original task idle or detach its question progress");
    }
  } finally {
    if (timer) clearTimeout(timer);
    finish.resolve(); await first;
  }
});
