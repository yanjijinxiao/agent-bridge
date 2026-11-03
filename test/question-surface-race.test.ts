import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskboardServer } from "codex-taskboard/server";
import { fakeNativeCore } from "../taskboard/test/helpers/native-backend.mjs";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) { assert.ok(Date.now() < deadline, "question surface race timed out"); await new Promise(r => setTimeout(r, 5)); }
}

for (const winner of ["im", "web"] as const) test(`INT-04.2: ${winner} wins the IM and actual Web HTTP question race without confirming the losing answer`, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "question-surface-race-")));
  const ask = Promise.withResolvers<void>(), confirm = Promise.withResolvers<void>();
  let chosen: unknown, writes = 0;
  const core = fakeNativeCore({ async onRun(input: any, entry: any) {
    await ask.promise;
    const request = { threadId: entry.threadId, turnId: entry.turnId, itemId: "question", requestId: "native-question",
      autoResolutionMs: null, questions: [{ id: "direction", header: "Direction", question: "Choose a direction" }] };
    chosen = await input.onUserInput(request); writes++;
    await confirm.promise; await input.onUserInputResult(request, "confirmed"); return "one completed task";
  } });
  const native = core.client();
  // The fixture exposes the Gateway port (host + consumer); this adapter is
  // the underlying per-host runner, whose observation signature omits both.
  const backend = new CodexAppServerGateway({ appServerBackend: { ...native,
    observeThreadInteractions: (threadId: string, observer: any) => native.observeThreadInteractions(threadId, "local", observer),
    unobserveThreadInteractions: (threadId: string) => native.unobserveThreadInteractions(threadId, "local"),
  } as never });
  const codexStatePath = path.join(root, "desktop.json");
  fs.writeFileSync(codexStatePath, JSON.stringify({ "local-projects": { project: { rootPaths: [root] } } }));
  const app = createTaskboardServer({ dataDirectory: path.join(root, "taskboard"), nativeBackend: backend, codexStatePath });
  let bridge: BridgeService | undefined;
  t.after(async () => { ask.resolve(); confirm.resolve(); bridge?.suspendUserInputs(); await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  app.database.createProject({ id: "project", name: "Project", workspacePath: root });
  const address = await app.listen({ port: 0 }), url = `http://127.0.0.1:${address.port}`;
  const thread = await app.aiChat.createThread({ projectId: "project" });
  const run = await app.aiChat.startTurn(thread.id, { message: "one question" });
  await until(() => !!app.database.getAiChatNativeReceipt(run.id)?.nativeTurnId);
  const receipt = app.database.getAiChatNativeReceipt(run.id), cards: unknown[] = [], notices: string[] = [];
  const paths = resolveStatePaths(path.join(root, "im")), store = new RuntimeStateStore(paths);
  const session = store.createSession("room", root, "Question", undefined, undefined, undefined, { standalone: true });
  store.setSessionThread(session.id, receipt.nativeThreadId);
  const userInputFilePath = path.join(root, "question-journal.json");
  bridge = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"] }, stateStore: store,
    runner: backend, userInputFilePath, channel: createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, actions: "available" }, {
      async sendText(input) { notices.push(input.text); return { messageId: "notice" }; },
      async sendActionCard(input) { cards.push(input); return { messageId: "question-card" }; },
    }) });
  await backend.observeThreadInteractions(receipt.nativeThreadId, "local", {
    onApproval: async () => undefined,
    onUserInput: envelope => bridge.requestUserInput("room", envelope.request),
    onUserInputResult: (envelope, result) => bridge.reportUserInputResult("room", envelope.request, result),
  });
  ask.resolve();
  await until(() => cards.length === 1 && app.aiChat.getThreadSnapshot(thread.id).interactions.length === 1);
  const interaction = app.aiChat.getThreadSnapshot(thread.id).interactions[0];
  const post = () => fetch(`${url}/api/local/ai/threads/${thread.id}/interactions/${interaction.id}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({ answer: { direction: { answers: ["web answer"] } } }),
  });
  const answerIm = () => bridge.handleMessage({ id: "im-answer", senderId: "actor", replyTargetId: "room", text: "/answer Q1 im answer", raw: {} });
  if (winner === "web") { assert.equal((await post()).status, 202); await until(() => writes === 1); await answerIm(); }
  else { await answerIm(); await until(() => writes === 1); assert.equal((await post()).status, 202); }
  assert.deepEqual(chosen, { direction: { answers: [`${winner} answer`] } });
  confirm.resolve(); await until(() => app.aiChat.getRun(run.id).status === "completed");
  const record = JSON.parse(fs.readFileSync(userInputFilePath, "utf8")).records[0];
  assert.equal(record.status, winner === "im" ? "confirmed" : "withdrawn");
  assert.equal(bridge.acceptedPresentationInputs().length, winner === "im" ? 1 : 0);
  assert.equal(notices.some(text => text.includes("Codex 已确认接收问题")), winner === "im");
  assert.equal((await post()).status, 409); await answerIm();
  assert.equal(writes, 1); assert.equal(core.calls.length, 1);
  assert.equal(app.aiChat.getThreadSnapshot(thread.id).interactions.length, 0);
});
