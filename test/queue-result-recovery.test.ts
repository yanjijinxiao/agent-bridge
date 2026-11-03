import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountManager } from "../src/server/account-manager.js";
import { NativeQueueCoordinator } from "../src/bridge/native-queue.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths, accountStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { saveAccount } from "../src/weixin/accounts.js";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";

for (const failure of ["none", "read-failure", "retired", "other-turn"] as const)
  test(`CTRL-03.3: result action observation precedes queue recovery (${failure})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-result-race-")), paths = resolveStatePaths(root);
    saveAccount(paths, { accountId: "fixture", token: "test-only", baseUrl: "https://example.test", enabled: false });
    const store = new RuntimeStateStore(accountStatePaths(paths, "fixture"));
    const session = store.createSession("room", root, "Queue race", undefined, "session", undefined, { standalone: true });
    store.setSessionThread(session.id, "original");
    let clientId = "", manager: any, failRead = failure === "read-failure";
    const reads: string[] = [], actions: string[] = [];
    const backend: any = { backendInfo: () => ({ id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
      async warmUp() {}, close() {},
      async addQueuedSubmission(input: any) { clientId = input.clientUserMessageId; return { id: "queue", clientUserMessageId: clientId }; },
      async listQueuedSubmissions(thread: string, _cursor: unknown, host: string) {
        reads.push(thread); assert.equal(host, "local"); assert.equal(thread, "original"); return { data: [] };
      },
      async getHistoryPage() {
        if (failRead) throw Error("history offline");
        if (failure === "retired") manager.entries.delete("fixture");
        return { messages: [{ id: "user", role: "user", text: "queued task", clientUserMessageId: clientId,
          turnId: failure === "other-turn" ? "other" : "turn" }] };
      },
      async readTurnLifecycle() { return { status: "completed", source: "owner" }; }
    };
    const queue = new NativeQueueCoordinator(path.join(paths.runtimeDir, "native-submissions.json"));
    const origin = { accountId: "fixture", conversationId: "room", actorId: "actor", messageId: "im-source",
      sessionId: session.id, hostId: "local", backend: "app-server", threadId: "original" };
    // A different unresolved thread must not be consulted or block this result.
    await queue.enqueue({ ...origin, threadId: "unavailable", messageId: "unrelated" }, "unrelated", backend);
    const accepted = await queue.enqueue(origin, "queued task", backend);
    assert.equal(accepted.turnId, undefined);
    manager = new AccountManager({ paths, configProvider: () => ({ ...defaultConfig(root), taskboardEnabled: false }),
      runnerFactory: () => backend, ideProjectsProvider: () => [], channelCapabilities: () => [] });
    // Lifecycle/channel are controlled ports; production source reconciliation,
    // AccountManager result authority and durable action journal are exercised.
    manager.entries.set("fixture", { status: "running", service: { async applyRecoveredAction() { actions.push("file"); } } });
    t.after(async () => { manager.entries.clear(); await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
    const sub = { key: JSON.stringify(["fixture", session.id]), hostId: "local", threadId: "original", recipientId: "room" };
    const text = 'result\n```codex-im-gateway-actions\n' + JSON.stringify({ send: [{ type: "file", path: path.join(root, "output.txt") }],
      remember: [{ kind: "knowledge", scope: "account", title: "result-race", content: "recovered" }] }) + '\n```';
    const apply = () => manager.applyNativeResult(sub, "turn", text);
    if (failure === "read-failure") { await assert.rejects(apply()); assert.equal(actions.length, 0); failRead = false; }
    if (failure === "retired") { await assert.rejects(apply(), /binding changed/); assert.equal(actions.length, 0); }
    else {
      await apply(); await apply();
      const count = failure === "other-turn" ? 0 : 1;
      assert.equal(actions.length, count);
      assert.equal(new RuntimeStateStore(accountStatePaths(paths, "fixture")).listKnowledge().filter(x => x.title === "result-race").length, count);
    }
    assert.ok(reads.length > 0); assert.ok(reads.every(thread => thread === "original"));
  });
