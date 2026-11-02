import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { CodexTurnExecutionError, type CodexRunnerInput } from "../src/codex/backend.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-buffer-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  let store = new RuntimeStateStore(paths), seq = 0;
  const project = store.createProject("Fixture", root), session = store.createSession("actor", root, "Fixture", project.id);
  store.setSessionThread(session.id, "thread");
  const inputs: CodexRunnerInput[] = [], replies: string[] = [];
  let preparationFails = false, mode: "normal" | "unknown" | "accepted-failure" = "normal";
  const runner = {
    async inspectThread() {
      if (preparationFails) { preparationFails = false; throw Error("app-server disconnected before submission"); }
      return { threadId: "thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] };
    },
    async run(input: CodexRunnerInput) {
      inputs.push(input);
      if (mode === "unknown") throw new CodexCommunicationError("submission", "turn/start", "thread");
      await input.onTurnStarted?.({ threadId: "thread", turnId: "turn" });
      if (mode === "accepted-failure") throw new CodexTurnExecutionError("failed", "fixture execution failed");
      return { threadId: "thread", turnId: "turn", text: "done", raw: "" };
    }
  };
  const build = () => new BridgeService({ stateStore: store,
    config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: false },
    weixin: { async sendText(input) { replies.push(input.text); return { messageId: "sent" }; } }, runner: runner as never });
  let service = build();
  return { inputs, replies,
    send(text: string) { return service.handleMessage({ id: String(++seq), senderId: "actor", text, raw: {} }); },
    restart() { store = new RuntimeStateStore(paths); service = build(); },
    failPreparation() { preparationFails = true; }, setMode(value: typeof mode) { mode = value; }
  };
}

test("collecting prompt text survives a Gateway restart and is submitted once", async t => {
  const f = fixture(t);
  await f.send("/prompt start"); await f.send("first fragment");
  f.restart(); await f.send("second fragment"); await f.send("/prompt done");
  assert.equal(f.inputs.length, 1);
  assert.match(f.inputs[0].prompt, /first fragment\n\nsecond fragment/);
  await f.send("/prompt done"); assert.equal(f.inputs.length, 1);
});

test("a Taskboard view of the same bound native session does not invalidate collecting prompt text", async t => {
  const f = fixture(t);
  await f.send("/prompt start"); await f.send("same target fragment");
  await f.send("/task list");
  f.restart(); await f.send("/prompt done");
  assert.equal(f.inputs.length, 1); assert.match(f.inputs[0].prompt, /same target fragment/);
});

test("prompt done preparation failure preserves the complete buffer across restart", async t => {
  const f = fixture(t);
  await f.send("/prompt start"); await f.send("preserve this fragment");
  f.failPreparation(); await assert.rejects(f.send("/prompt done"));
  assert.equal(f.inputs.length, 0);
  f.restart(); await f.send("/prompt done");
  assert.equal(f.inputs.length, 1); assert.match(f.inputs[0].prompt, /preserve this fragment/);
});

test("an unconfirmed buffer submission stays held across restart and cannot be replayed", async t => {
  const f = fixture(t);
  await f.send("/prompt start"); await f.send("unknown receipt fragment");
  f.setMode("unknown"); await assert.rejects(f.send("/prompt done"), CodexCommunicationError);
  f.restart(); await assert.rejects(f.send("/prompt done"), /回执|确认|已尝试/);
  assert.equal(f.inputs.length, 1);
});

test("native acceptance consumes a buffer even when the accepted task later fails", async t => {
  const f = fixture(t);
  await f.send("/prompt start"); await f.send("old accepted fragment");
  f.setMode("accepted-failure"); await assert.rejects(f.send("/prompt done"), CodexTurnExecutionError);
  f.restart(); f.setMode("normal");
  await f.send("/prompt start"); await f.send("new fragment"); await f.send("/prompt done");
  assert.equal(f.inputs.length, 2);
  assert.match(f.inputs[1].prompt, /new fragment/); assert.doesNotMatch(f.inputs[1].prompt, /old accepted fragment/);
});
