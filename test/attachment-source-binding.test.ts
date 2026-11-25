import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { BridgeService } from "../src/bridge/service.js";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

for (const action of ["ordinary-download", "queue-download", "steer-staging", "queue-staging", "ordinary-inspect", "steer-inspect", "ordinary-reference", "queue-reference", "steer-reference"] as const) {
  const scopes = {
    original: "an unchanged source reaches the intended native mutation",
    replaced: "a replaced source binding cannot retarget the prepared attachment",
    restored: "returning to the original project cannot revive a retired input",
  };
  for (const [scope, title] of Object.entries(scopes)) test(`${action}: ${title}`, async t => {
    const changeBinding = scope !== "original";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-attachment-origin-")), file = path.join(root, "fixture.txt");
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.writeFileSync(file, "attachment fixture");
    const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
    const first = store.createProject("First", root, { sourceProjectId: "project-a", ...(action.endsWith("-staging") ? { hostId: "remote", projectKind: "remote" } : {}) });
    const original = store.createSession("actor", root, "First", first.id); store.setSessionThread(original.id, "thread-a");
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const writes: Array<{ method: string; threadId: string }> = [];
    const mutation = (method: string, input: { threadId: string }) => {
      writes.push({ method, threadId: input.threadId }); throw Error("fixture reached native mutation");
    };
    const receiptsPath = path.join(root, "inbound-receipts.jsonl");
    const inputReceipts = new InboundReceiptJournal(receiptsPath);
    const service = new BridgeService({ stateStore: store, inboundDir: root, inputReceipts,
      config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: false },
      channel: { ...createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "sent" }; } }),
        async resolveReferences(message) {
          if (action.endsWith("-reference")) { entered.resolve(); await release.promise; }
          return message;
        },
        async resolveAttachments() {
          if (action.endsWith("-download")) { entered.resolve(); await release.promise; }
          return [{ kind: "file", label: "fixture.txt", path: file }];
        }
      },
      runner: {
        backendInfo() { return { id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }; },
        async inspectThread(threadId: string) { if (action.endsWith("-inspect")) { entered.resolve(); await release.promise; }
          return { threadId, persistence: "active", runtimeStatus: action.startsWith("steer-") ? "active" : "idle",
          activeTurnId: action.startsWith("steer-") ? "turn-a" : undefined, activeFlags: [] }; },
        async stageAttachments(files: Array<{ path: string }>) { entered.resolve(); await release.promise; return files.map(f => ({ ...f, path: "/remote/staged.txt" })); },
        async run(input: { threadId: string }) { return mutation("run", input); },
        async steer(input: { threadId: string }) { return mutation("steer", input); },
        async addQueuedSubmission(input: { threadId: string }) { return mutation("queue", input); }
      } as never
    });
    const text = action.startsWith("steer-") ? "/steer inspect attachment" : action.startsWith("queue-") ? "/queue inspect attachment" : "inspect attachment";
    const message = { id: "source", senderId: "actor", text, attachments: [{ kind: "file" as const, label: "fixture.txt", path: file, item: {} }], raw: {} };
    const pending = inputReceipts.handle(message, () => service.handleMessage(message));
    await entered.promise;
    if (changeBinding) {
      const second = store.createProject("Second", root, { sourceProjectId: "project-b" });
      const replacement = store.createSession("actor", root, "Second", second.id); store.setSessionThread(replacement.id, "thread-b");
      if (scope === "restored") store.activateSession(original.id);
    }
    release.resolve(); await pending.catch(() => {});
    assert.deepEqual(writes, changeBinding ? [] : [{ method: action.split("-")[0] === "ordinary" ? "run" : action.split("-")[0], threadId: "thread-a" }]);
    // Reopen the actual journal: preparing an attachment is not evidence that
    // Codex received it; once the fake mutation throws, its outcome IS unknown.
    const restarted = new InboundReceiptJournal(receiptsPath);
    assert.equal(restarted.receipt(message.id)?.phase, changeBinding ? "received" : "unconfirmed");
    assert.equal(restarted.claim(message), changeBinding);
    assert.equal(store.getBoundSession("actor")?.threadId, scope === "replaced" ? "thread-b" : "thread-a");
  });
}

test("a local command with a persisted side effect keeps its unknown receipt when reply acknowledgement is lost", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-command-origin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = store.createProject("First", root);
  const session = store.createSession("actor", root, "First", project.id);
  store.setSessionThread(session.id, "thread-a");
  const file = path.join(root, "receipts.jsonl"), inputReceipts = new InboundReceiptJournal(file);
  const service = new BridgeService({ stateStore: store, inboundDir: root, inputReceipts,
    config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: true },
    channel: createChannelClient("generic", TEXT_CAPABILITIES, {
      async sendText() { throw Error("reply acknowledgement lost"); }
    }),
    runner: { backendInfo() { return { id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }; } } as never
  });
  const message = { id: "local-command", senderId: "actor", text: "/stream off", attachments: [], raw: {} };
  await assert.rejects(inputReceipts.handle(message, () => service.handleMessage(message)));
  assert.equal(store.getSession(session.id)?.streamReplies, false);
  assert.equal(new RuntimeStateStore(resolveStatePaths(path.join(root, "state"))).getSession(session.id)?.streamReplies, false);
  const restarted = new InboundReceiptJournal(file);
  assert.equal(restarted.receipt(message.id)?.phase, "unconfirmed");
  assert.equal(restarted.claim(message), false);
});

for (const command of ["steer", "queue"] as const) {
  for (const change of ["unchanged", "role", "admission", "account-stop"] as const) {
    test(`${command} checks ${change} when the App Server handshake completes`, { timeout: 10_000 }, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-native-guard-"));
      const gate = path.join(root, "connected");
      const script = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
      const runner = new AppServerCodexRunner({ requestTimeoutMs: 4000, transport: {
        command: process.execPath, args: [script, "--initialize-gate=" + gate], mode: "remote-daemon"
      } });
      t.after(async () => { await runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
      const store = new RuntimeStateStore(resolveStatePaths(root));
      const project = store.createProject("Project", root);
      const session = store.createSession("actor", root, "Session", project.id);
      store.setSessionThread(session.id, "control-thread");
      store.setPairedSenderIds(["actor"]);
      const service = new BridgeService({
        stateStore: store, config: { ...defaultConfig(root), streamReplies: false, allowedSenderIds: [] },
        channel: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "reply" }; } }),
        runner: { backendInfo: () => ({ id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
          inspectThread: async () => ({ threadId: "control-thread", persistence: "active", runtimeStatus: "active",
            activeTurnId: "control-turn", activeFlags: [] }),
          steer: runner.steer.bind(runner), addQueuedSubmission: runner.addQueuedSubmission.bind(runner)
        } as never
      });
      const result = service.handleMessage({ senderId: "actor", id: "input", text: "/" + command + " continue", raw: {} })
        .then(() => undefined, (error: Error) => error);
      const wire = gate + ".wire";
      // appendFile creates the file before it writes the method. Wait for
      // the actual handshake record before releasing the native barrier.
      for (let i = 0; i < 500 && (!fs.existsSync(wire) || fs.statSync(wire).size === 0); i++) await delay(5);
      assert.equal(fs.readFileSync(wire, "utf8").trim(), "initialize");
      if (change === "role") store.setRole("actor", "actor", "viewer");
      if (change === "admission") service.removeSender("actor");
      if (change === "account-stop") service.suspendUserInputs();
      fs.writeFileSync(gate, "");
      const error = await result;
      const methods = fs.readFileSync(wire, "utf8").trim().split("\n");
      const writeMethod = command === "steer" ? "turn/steer" : "thread/queue/add";
      assert.equal(methods.filter(method => method === writeMethod).length, change === "unchanged" ? 1 : 0);
      assert.ok(!methods.includes("turn/start"));
      if (change === "unchanged") assert.ifError(error);
      assert.equal(store.getSession(session.id)?.threadId, "control-thread");
    });
  }
}
