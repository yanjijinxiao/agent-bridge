import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

const settle = async () => { for (let n = 0; n < 5; n++) await new Promise<void>(r => setImmediate(r)); };

for (const kind of ["approval", "question"] as const) for (const change of ["none", "binding", "account"] as const) {
  test(`${kind} notice waiting for activity retains its ${change === "none" ? "unchanged source" : `original ${change} scope`}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-interaction-source-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new RuntimeStateStore(resolveStatePaths(root));
    const project = store.createProject("Fixture", root);
    const session = store.createSession("actor", root, "Fixture", project.id); store.setSessionThread(session.id, "thread-a");
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), notices: string[] = [];
    const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"] }, stateStore: store,
      runner: {} as never, channel: createChannelClient("generic", TEXT_CAPABILITIES, {
        async sendText(input) { notices.push(input.text); return { messageId: "notice" }; }
      }) });
    t.after(() => { release.resolve(); (service as any).approvals.declineAll("actor"); service.suspendUserInputs(); });
    (service as any).activePresentations.set(session.id, { threadId: "thread-a", turnId: "turn-a", hostId: "local",
      stream: { async setActivity() { entered.resolve(); await release.promise; } } });
    const pending = kind === "approval"
      ? service.requestApproval("actor", { kind: "command", threadId: "thread-a", turnId: "turn-a", itemId: "approval" })
      : service.requestUserInput("actor", { threadId: "thread-a", turnId: "turn-a", itemId: "question", requestId: 1,
        questions: [{ id: "choice", header: "Fixture", question: "Continue fixture?" }] });
    const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await entered.promise;
    if (change === "binding") {
      const replacement = store.createSession("actor", root, "Replacement", project.id); store.setSessionThread(replacement.id, "thread-b");
    } else if (change === "account") service.suspendUserInputs();
    release.resolve(); await settle();
    assert.equal(notices.length, change === "none" ? 1 : 0, "a retired route must not receive a newly delivered native question");
    if (change === "none") {
      if (kind === "approval") service.decideApproval("actor", service.listApprovals()[0].id, "accept", service.listApprovals()[0].version);
      else (service as any).userInputs.answer("actor", "Q1 fixture answer");
      const result = await outcome;
      assert.equal(result.error, undefined);
      if (kind === "approval") assert.equal(result.value, "accept");
      else assert.deepEqual(result.value, { choice: { answers: ["fixture answer"] } });
    } else {
      const result = await outcome;
      if (kind === "approval") assert.ok(result.error instanceof CodexCommunicationError, "unavailable delivery is an observation error, never an automatic native decision");
      else assert.equal(result.value, undefined);
    }
  });
}
