// This child owns only the disposable paths passed by its parent. SIGKILL at
// these barriers prevents graceful shutdown from flushing a pending cursor.
import fs from "node:fs";
import path from "node:path";
import { monitorWeixin } from "../../src/weixin/monitor.ts";
import { RuntimeStateStore } from "../../src/state/runtime-state.ts";
import { resolveStatePaths } from "../../src/state/paths.ts";
import { InboundReceiptJournal } from "../../src/bridge/inbound-receipts.ts";

const [root, barrier] = process.argv.slice(2);
const store = new RuntimeStateStore(resolveStatePaths(root));
const journal = new InboundReceiptJournal(path.join(root, "receipts.jsonl"));
const controller = new AbortController();
const record = (file, value) => fs.appendFileSync(path.join(root, file), value + "\n");
function interrupt(point) {
  if (point === barrier) process.kill(process.pid, "SIGKILL");
}
await monitorWeixin({
  signal: controller.signal,
  initialSyncKey: store.getSyncKey(),
  client: {
    async getUpdates(cursor) {
      record("reads", cursor ?? "initial");
      interrupt("read");
      if (cursor === "batch-1") {
        await new Promise(resolve => setImmediate(resolve));
        controller.abort();
        return { msgs: [] };
      }
      return { next_sync_key: "batch-1", msgs: ["a", "b"].map(id => ({
        message_id: id, from_user_id: "owner", text: id,
      })) };
    },
  },
  claimMessage(message) {
    if (message.id === "b") interrupt("mid-batch");
    return journal.claim(message);
  },
  onMessage(message) {
    return journal.handle(message, async () => record("delivered", message.id));
  },
  onSyncKey(key) {
    interrupt("before-save");
    store.setSyncKey(key);
    interrupt("after-save");
  },
});
