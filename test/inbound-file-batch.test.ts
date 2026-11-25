import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DingTalkCardRouting } from "../src/channels/dingtalk-card-routing.js";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk.js";
import { PinnedNetworkLifecycleTransport } from "../src/channels/network-family.js";
import { downloadInboundAttachments } from "../src/weixin/media.js";

for (const channel of ["dingtalk", "weixin"] as const) {
  for (const fault of ["stalled", "partial-write", "oversize", "success"] as const) {
    test(channel + " inbound batch preserves only owned complete files on " + fault, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-file-batch-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const dir = channel === "weixin" ? path.join(root, "actor") : root;
      fs.mkdirSync(dir, { recursive: true });
      const existing = path.join(dir, "old.txt");
      fs.writeFileSync(existing, "keep");

      let downloads = 0;
      const fetchResource = async () => {
        ++downloads;
        if (downloads === 2 && fault === "stalled") return new Promise<Response>(() => {});
        return new Response(downloads === 2 && fault === "oversize" ? "over-limit" : "body");
      };
      if (fault === "stalled") {
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        t.mock.method(AbortSignal, "timeout", (ms: number) => timeout(Math.min(ms, 80)));
      }
      if (fault === "partial-write") {
        const write = fs.writeFileSync;
        let allocations = 0;
        t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
          if (++allocations === 2) {
            write(args[0], "part");
            throw Object.assign(Error("simulated full disk"), { code: "ENOSPC" });
          }
          return write(...args);
        });
      }
      const cardRouting = new DingTalkCardRouting("client");
      cardRouting.remember("room", "2", "actor", "robot");
      const ding = new DingTalkChannelAdapter({
        channel: "dingtalk", accountId: "test", clientId: "client", clientSecret: "fixture", enabled: true, savedAt: ""
      }, {
        apiTransport: new PinnedNetworkLifecycleTransport("ipv4", fetchResource),
        streamClient: { async getAccessToken() { return "test"; } } as never,
        cardRouting, inboundDir: root, maxInboundBytes: 6
      });
      const attachments = ["one", "two"].map(name => ({
        kind: "file" as const, label: name + ".txt",
        item: { downloadUrl: "https://test.invalid/" + name, file_item: { media: { full_url: "https://test.invalid/" + name } } }
      }));
      const run = () => channel === "dingtalk"
        ? ding.resolveAttachments({ id: "batch", senderId: "actor", replyTargetId: "room", raw: {}, text: "", attachments })
        : downloadInboundAttachments({ rootDir: root, senderId: "actor", messageId: "batch", maxBytes: 6, fetch: fetchResource, attachments });
      const watchdog = setTimeout(() => {}, 2500);
      try {
        if (fault === "success") {
          const files = await run();
          assert.deepEqual(files.map(f => fs.readFileSync(f.path!, "utf8")), ["body", "body"]);
          assert.ok(files.every(f => (fs.statSync(f.path!).mode & 0o777) === 0o600));
        } else {
          await assert.rejects(run());
          assert.deepEqual(fs.readdirSync(dir), ["old.txt"]);
        }
        assert.equal(downloads, 2);
        assert.equal(fs.readFileSync(existing, "utf8"), "keep");
      } finally {
        clearTimeout(watchdog);
      }
    });
  }
}
