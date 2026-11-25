import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { InboundMediaTooLargeError } from "../src/channels/errors.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

for (const channel of ["dingtalk", "weixin", "wecom", "feishu"] as const) {
  test(channel + " keeps attachment failure, missing quoted content and direct file delivery distinguishable", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "im-media-failure-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = new RuntimeStateStore(resolveStatePaths(root));
    const project = state.createProject("Source", root), session = state.createSession("actor", root, "Thread", project.id);
    state.setSessionThread(session.id, "thread");
    const marker = "fixture-private-download-value";
    const file = path.join(root, "original.txt");
    fs.writeFileSync(file, "fixture bytes");
    const logs: string[] = [], replies: string[] = [], prepared: string[] = [], native: string[] = [];
    t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
    const journalPath = path.join(root, "receipts.jsonl");
    const receipts = new InboundReceiptJournal(journalPath);
    const bridge = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: false },
      inboundDir: root, stateStore: state, inputReceipts: receipts,
      onAttachmentsPrepared(id) { prepared.push(id); },
      channel: createChannelClient(channel, { ...TEXT_CAPABILITIES, inbound: { ...TEXT_CAPABILITIES.inbound, file: "available" } }, {
        async sendText(message) { replies.push(message.text); return { messageId: "sent" }; },
        async resolveAttachments(message) {
          if (message.id === "timeout") throw Error("download timeout at " + marker);
          if (message.id === "storage") throw Object.assign(Error("cannot save " + marker), { code: "ENOSPC" });
          if (message.id === "size") throw new InboundMediaTooLargeError(1024, 1025);
          return message.attachments.map(item => ({ ...item, path: file }));
        },
      }), runner: {
        async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
        async run(input: { prompt: string }) { native.push(input.prompt); return { threadId: "thread", turnId: "turn", text: "done", raw: "" }; },
      } as never });
    for (const id of ["timeout", "storage", "size", "direct", "quote-id", "quote-filename"]) {
      const quoted = id.startsWith("quote");
      const message = { id, senderId: "actor", text: "inspect", raw: {},
        attachments: quoted ? [] : [{ kind: "file" as const, label: "original.txt", item: {} }],
        ...(quoted ? { references: [{ messageId: "previous", type: "file", availability: "metadata-only" as const,
          text: id === "quote-filename" ? "original.txt" : undefined, attachments: [] }] } : {}) };
      const runs = native.length;
      if (id === "timeout" || id === "storage") {
        await assert.rejects(receipts.handle(message, () => bridge.handleMessage(message)), /暂缓|尚未转存/);
        assert.equal(new InboundReceiptJournal(journalPath).receipt(id)?.phase, "received");
        assert.equal(native.length, runs); assert.ok(!prepared.includes(id));
      } else {
        await receipts.handle(message, () => bridge.handleMessage(message));
        if (id === "size") { assert.match(replies.at(-1)!, /上限/); assert.equal(native.length, runs); }
        else {
          assert.ok(prepared.includes(id)); assert.equal(native.length, runs + 1);
          if (quoted) { assert.match(native.at(-1)!, /未取得原始内容|不能声称已读取/); }
          else { assert.ok(native.at(-1)!.includes("original.txt")); }
        }
      }
    }
    assert.ok(logs.some(line => line.includes("attachment download failed")));
    assert.ok(!logs.join(" ").includes(marker), "per-source diagnostics must not expose file download credentials");
  });
}
