import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BridgeService } from "../src/bridge/service.js";
import { ChannelUserInputController } from "../src/bridge/user-input-controller.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("Bridge protects approval notice delivery, then permits restart while the native request awaits a human", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-approval-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gate = Promise.withResolvers<void>(); t.after(() => gate.resolve());
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const service = new BridgeService({ config: defaultConfig(root), stateStore: store,
    runner: {} as never, channel: createChannelClient("generic", TEXT_CAPABILITIES, {
      async sendText() { await gate.promise; return { messageId: "notice" }; }
    }) }); t.after(() => service.suspendUserInputs());
  const approval = service.requestApproval("room", { kind: "command", threadId: "thread", turnId: "turn", itemId: "item" });
  t.after(() => { (service as any).approvals.declineAll("room"); });
  assert.equal(service.hasRestartBlockingWork(), true, "actual outbound notice is protected");
  gate.resolve(); await tick();
  assert.equal(service.listApprovals().length, 1, "the original request remains actionable");
  assert.equal(service.hasRestartBlockingWork(), false, "waiting for a human is not live transfer");
  (service as any).approvals.declineAll("room"); await approval;
});

for (const kind of ["sync", "async"] as const) test(`${kind} questions protect sends, not human waiting, partial answers or durable native uncertainty`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-question-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let delivery = Promise.withResolvers<void>(); t.after(() => delivery.resolve());
  const controller = new ChannelUserInputController(async () => { await delivery.promise; return { messageId: "card" }; }, undefined,
    { filePath: path.join(root, "questions.json"), sendNotice: async () => { await delivery.promise; } });
  t.after(() => controller.close());
  const request = { kind, threadId: "thread", turnId: "turn", itemId: "item", requestId: 1, autoResolutionMs: null,
    questions: [{ id: "one", header: "One", question: "First?" }, { id: "two", header: "Two", question: "Second?" }] };
  const pending = controller.request("room", request);
  assert.equal(controller.hasRestartBlockingWork(), true, "initial card transfer is protected");
  delivery.resolve(); await tick();
  assert.equal(controller.hasRestartBlockingWork(), false, "waiting for a human never protects native execution");
  controller.answer("room", "Q1 first"); await tick();
  assert.equal(controller.hasRestartBlockingWork(), false, "a durable partial answer can be restored while waiting for its sibling");
  controller.answer("room", "Q2 second"); await pending; await tick();
  assert.equal(controller.hasRestartBlockingWork(), false, "native answer receipt waiting is distinct from transport flush");
  delivery = Promise.withResolvers<void>();
  const notice = controller.reportResult("room", request, "confirmed");
  await tick();
  assert.equal(controller.hasRestartBlockingWork(), true, "native resolution notice delivery is protected");
  delivery.resolve(); await notice;
  assert.equal(controller.hasRestartBlockingWork(), false);
});

test("an expired start RPC cannot permanently gate restart after a native completion arrived before its receipt", async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 50, transport: { command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url))], mode: "daemon-proxy" } });
  t.after(() => runner.close());
  await assert.rejects(runner.run({ cwd: "/tmp", prompt: "delayed-turn-receipt" }), { submission: "unconfirmed" });
  assert.equal(runner.hasRestartBlockingWork(), false, "unknown start identity is retained for reconciliation, not an infinite restart latch");
});
