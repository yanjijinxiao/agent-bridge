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
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

for (const action of ["ordinary-download", "queue-download", "steer-staging", "queue-staging", "ordinary-inspect", "steer-inspect", "ordinary-reference", "queue-reference", "steer-reference"] as const) {
  for (const changeBinding of [false, true]) test(`${action}: ${changeBinding ? "a replaced source binding cannot retarget the prepared attachment" : "an unchanged source reaches the intended native mutation"}`, async t => {
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
    }
    release.resolve(); await pending.catch(() => {});
    assert.deepEqual(writes, changeBinding ? [] : [{ method: action.split("-")[0] === "ordinary" ? "run" : action.split("-")[0], threadId: "thread-a" }]);
    // Reopen the actual journal: preparing an attachment is not evidence that
    // Codex received it; once the fake mutation throws, its outcome IS unknown.
    const restarted = new InboundReceiptJournal(receiptsPath);
    assert.equal(restarted.receipt(message.id)?.phase, changeBinding ? "received" : "unconfirmed");
    assert.equal(restarted.claim(message), changeBinding);
    if (changeBinding) assert.equal(store.getBoundSession("actor")?.threadId, "thread-b");
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
