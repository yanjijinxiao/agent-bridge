import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { peerFixture, principal } from "./peer-fixture.js";
import { peerNativeHost } from "../src/peer/registry.js";
import { BridgeService } from "../src/bridge/service.js";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { parsePrompt } from "../src/bridge/format.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";

const remote = "remote-ssh-discovered:registered-host";
// Exercise the IM preparation boundary, not a manually pre-populated file RPC.
// One real Connector socket multiplexes both targets; native inference is fake.
for (const managed of [true, false]) for (const child of [false, true]) {
  for (const kind of ["text", "image", "file"] as const) {
    test(`IM ${kind} reaches selected Connector (${managed ? "managed" : "personal"}/${child ? "remote" : "local"})`, async t => {
      const f = await peerFixture(t, { device: true, managedHost: managed ? "local" : undefined, nativeHost: remote });
      if (!managed) await f.bind();
      f.thread.cwd = f.root;
      const hostId = child ? managed ? remote : peerNativeHost(f.ticket.hostId, remote) : managed ? "local" : f.ticket.hostId;
      f.backend.stageAttachments = async (files, options) => { assert.equal(options.hostId, remote); return files; };
      const paths = resolveStatePaths(path.join(f.root, "bridge")), store = new RuntimeStateStore(paths);
      const session = store.createSession(principal.conversationId, f.root, "Input", undefined, "session", undefined, { standalone: true, hostId });
      store.setSessionThread(session.id, f.thread.threadId);
      const journal = new InboundReceiptJournal(path.join(f.root, "receipts.jsonl"));
      const file = path.join(f.root, "gateway-inbound.bin"), bytes = Buffer.from("attachment bytes from Gateway");
      fs.writeFileSync(file, bytes);
      let stagingCalls = 0;
      const runner = new Proxy(f.facade, { get(target, key) {
        if (key === "stageAttachments") return async (...args: Parameters<NonNullable<typeof target.stageAttachments>>) => {
          stagingCalls++;
          const staged = await target.stageAttachments!(...args);
          assert.equal(args[1].accountId, principal.accountId);
          assert.equal(args[1].conversationId, principal.conversationId);
          assert.equal(args[1].threadId, f.thread.threadId);
          assert.equal(args[1].hostId, hostId);
          return staged;
        };
        return Reflect.get(target, key);
      } });
      const service = new BridgeService({ accountId: principal.accountId, stateStore: store, runner, peer: f.registry, inputReceipts: journal, inboundDir: f.root,
        config: { ...defaultConfig(paths.root), allowedSenderIds: [principal.actorId], streamReplies: false },
        channel: createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, inbound: { ...TEXT_CAPABILITIES.inbound, image: "available", file: "available" } }, {
          async sendText() { return { messageId: "reply" }; },
          async resolveAttachments() { assert.notEqual(kind, "text"); return [{ kind: kind as "image" | "file", path: file, label: "source.bin" }]; }
        }) });
      t.after(() => service.suspendUserInputs());
      const message = { id: "source", senderId: principal.actorId, replyTargetId: principal.conversationId,
        conversationKind: "group" as const, text: "inspect input", raw: {},
        attachments: kind === "text" ? [] : [{ kind, label: "source.bin", item: {} }] };
      await journal.handle(message, () => service.handleMessage(message));
      assert.equal(f.runs.length, 1);
      const input = f.runs[0], attachments = parsePrompt(input.prompt).attachments;
      assert.equal(input.threadId, f.thread.threadId);
      assert.equal(input.hostId ?? "local", child ? remote : "local");
      assert.equal(stagingCalls, kind === "text" ? 0 : 1);
      assert.equal(attachments.length, kind === "text" ? 0 : 1);
      if (kind !== "text") {
        assert.notEqual(attachments[0].path, file, "Gateway filesystem paths must not leak into Connector input");
        assert.deepEqual(fs.readFileSync(attachments[0].path!), bytes);
      }
      assert.equal(journal.receipt(message.id)?.phase, "handled");
      assert.equal(journal.receipt(message.id)?.turnId, "native-turn");
      assert.equal(store.getBoundSession(principal.conversationId)?.hostId, hostId);
      assert.deepEqual(f.stops, []);
    });
  }
}
