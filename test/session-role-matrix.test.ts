import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

test("grantor, prior and requested chat roles govern subsequent history, participation and control commands", async t => {
  const roles = ["viewer", "participant", "controller"] as const;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-matrix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const store = new RuntimeStateStore(paths);
  const project = store.createProject("Project", root);
  const replies: string[] = [];
  let reads = 0, steers = 0, inputId = 0;
  const service = new BridgeService({
    stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["grantor", "target"], streamReplies: false },
    weixin: { async sendText(input) { replies.push(input.text); return { messageId: "sent" }; } },
    runner: {
      async getHistoryPage() { reads++; return { messages: [{ role: "assistant", text: "history" }] }; },
      async inspectThread(threadId: string) { return { threadId, persistence: "active", runtimeStatus: "active", activeTurnId: "turn", activeFlags: [] }; },
      async steer(input: { threadId: string; expectedTurnId: string }) {
        steers++; return { status: "accepted", threadId: input.threadId, turnId: input.expectedTurnId };
      },
    } as never,
  });
  for (const grantor of roles) for (const prior of roles) for (const requested of roles) {
    const room = [grantor, prior, requested].join("-");
    const session = store.createSession(room, root, "matrix", project.id);
    store.setSessionThread(session.id, room);
    store.setRole(room, "grantor", grantor);
    store.setRole(room, "target", prior);
    const send = (actor: string, text: string) => service.handleMessage({ id: String(++inputId), senderId: actor, replyTargetId: room, text, raw: {} });
    await send("grantor", "/role target " + requested);
    const effective = grantor === "controller" ? requested : prior;
    assert.equal(new RuntimeStateStore(paths).roleFor(room, "target"), effective, room);
    const beforeReads = reads, beforeSteers = steers;
    await send("target", "/history 1");
    assert.equal(reads, beforeReads + 1, room);
    await send("target", "/steer continue");
    assert.equal(steers, beforeSteers + Number(effective !== "viewer"), room);
    await send("target", "/role witness controller");
    assert.equal(store.roleFor(room, "witness"), effective === "controller" ? "controller" : undefined, room);
    if (effective !== "controller") {
      for (const cmd of ["/stop", "/approve A1"]) {
        await send("target", cmd);
        assert.match(replies.at(-1)!, /需要 controller/, room + " " + cmd);
      }
    }
  }
});
