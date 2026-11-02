import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TaskboardDatabase } from "../server/database.mjs";
import { AiChatService } from "../server/ai-chat.mjs";
import { fakeNativeCore } from "./helpers/native-backend.mjs";

async function waitFor(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("Timed out waiting for native fixture");
}
async function createFixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-native-"));
  const workspace = await realpath(directory), codexStatePath = path.join(directory, "codex-state.json");
  await writeFile(codexStatePath, JSON.stringify({ "local-projects": { project: { rootPaths: [workspace] } } }));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "project", name: "Project", workspacePath: workspace });
  const core = fakeNativeCore(options), backend = core.client();
  const service = new AiChatService({ database, nativeBackend: backend, codexStatePath,
    manageTaskboardSkillPath: "/fixture/manage-taskboard/SKILL.md" });
  return { directory, workspace, databasePath, database, service, core, backend,
    async close() { await this.service.close(); await backend.close(); this.database.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("native turns retain selected cwd, exact continuation id, chosen permissions and visible item identity", async t => {
  const f = await createFixture(); t.after(() => f.close());
  const catalog = await f.service.getCatalog("project");
  assert.equal(catalog.skills[0].path, "/fixture/real-skill/SKILL.md");
  const thread = await f.service.createThread({ projectId: "project", reasoningEffort: "high" });
  const first = await f.service.startTurn(thread.id, { message: "HIDDEN_SENTINEL \uFFFC first", skillIds: ["real-skill"] });
  await waitFor(() => f.service.getRun(first.id).status !== "running");
  const second = await f.service.startTurn(thread.id, { message: "second" });
  await waitFor(() => f.service.getRun(second.id).status !== "running");
  assert.equal(f.core.calls.length, 2);
  assert.equal(f.core.calls[0].cwd, f.workspace);
  assert.equal(f.core.calls[0].threadId, undefined);
  assert.equal(f.core.calls[1].threadId, f.service.getThread(thread.id).codexThreadId);
  assert.deepEqual(f.core.calls[0].nativeSettings, { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review", runtimeWorkspaceRoots: [f.workspace] });
  assert.equal(f.core.calls[0].model, "gpt-real"); assert.equal(f.core.calls[0].effort, "high");
  assert.match(f.core.calls[0].prompt, /\[\$real-skill\]\(\/fixture\/real-skill\/SKILL.md\)/);
  const events = f.service.getThreadSnapshot(thread.id).events;
  assert.equal(events.filter(event => event.role === "assistant").length, 2, "live item plus history reconciliation is one item per turn");
  assert.equal(events.filter(event => event.role === "user")[0].content, "HIDDEN_SENTINEL \uFFFC first");
});

test("same-thread admission locks while different native threads run concurrently and explicit stop targets one exact turn", async t => {
  const holds = new Map();
  const f = await createFixture({ onRun(input) { if (!input.prompt.includes("WAIT")) return "Done"; const hold = Promise.withResolvers(); holds.set(input.clientUserMessageId, hold); return hold.promise; } });
  t.after(() => { for (const hold of holds.values()) hold.resolve("Done"); return f.close(); });
  const a = await f.service.createThread({ projectId: "project" }), b = await f.service.createThread({ projectId: "project" });
  const ra = await f.service.startTurn(a.id, { message: "WAIT A" }), rb = await f.service.startTurn(b.id, { message: "WAIT B" });
  await waitFor(() => f.core.calls.length === 2);
  await assert.rejects(f.service.startTurn(a.id, { message: "duplicate" }), error => error.code === "THREAD_BUSY");
  const receipt = f.database.getAiChatNativeReceipt(ra.id);
  await f.service.interrupt(ra.id); await waitFor(() => f.service.getRun(ra.id).status === "interrupted");
  assert.deepEqual(f.core.interrupts, [{ threadId: receipt.nativeThreadId, turnId: receipt.nativeTurnId }]);
  assert.equal(f.service.getRun(rb.id).status, "running");
  holds.get(f.database.getAiChatNativeReceipt(rb.id).clientUserMessageId).resolve("B done");
  await waitFor(() => f.service.getRun(rb.id).status === "completed");
});

test("native failure is terminal while an uncertain accepted observation stays unreplayed", async t => {
  for (const uncertain of [false, true]) {
    const f = await createFixture({ onRun() { throw Object.assign(new Error("Isolated failure"), uncertain
      ? { name: "CodexCommunicationError", submission: "accepted" }
      : { name: "CodexTurnExecutionError", status: "failed" }); } });
    try {
      const thread = await f.service.createThread({ projectId: "project" });
      const run = await f.service.startTurn(thread.id, { message: "execute once" });
      await waitFor(() => f.service.getRun(run.id).error);
      assert.equal(f.service.getRun(run.id).status, uncertain ? "running" : "failed");
      if (uncertain) assert.equal(f.service.getRun(run.id).handoff, "reconciling");
      f.service.recover(); await new Promise(r => setTimeout(r, 10));
      assert.equal(f.core.calls.length, 1);
    } finally { await f.close(); }
  }
});

test("a failed durable user-event transaction sends no native input and leaves no running claim", async t => {
  const f = await createFixture(); t.after(() => f.close());
  const thread = await f.service.createThread({ projectId: "project" });
  f.database.setAutomationRun("project", { threadId: thread.id, dirty: true });
  f.database.insertAiChatEvent = () => { throw new Error("Isolated disk failure"); };
  await assert.rejects(f.service.startTurn(thread.id, { message: "must be durable before native write" }), /disk failure/);
  assert.equal(f.core.calls.length, 0);
  assert.equal(f.database.listAiChatRuns(thread.id).length, 0);
  assert.equal(f.database.getAutomationRun("project").runId, null);
  assert.equal(f.service.getThread(thread.id).status, "idle");
});

test("native questions are scoped to their run and secret answers never enter SQLite events", async t => {
  const request = { threadId: "", turnId: "", itemId: "question", requestId: 7,
    questions: [{ id: "secret", header: "Local field", question: "Isolated secret value", isSecret: true }] };
  let received;
  const f = await createFixture({ async onRun(input, entry) {
    Object.assign(request, { threadId: entry.threadId, turnId: entry.turnId });
    received = await input.onUserInput(request);
    await input.onUserInputResult(request, "confirmed");
    return "Answered";
  } });
  t.after(() => f.close());
  const thread = await f.service.createThread({ projectId: "project" });
  const run = await f.service.startTurn(thread.id, { message: "ask once" });
  await waitFor(() => f.service.getThreadSnapshot(thread.id).interactions.length);
  const interaction = f.service.getThreadSnapshot(thread.id).interactions[0];
  assert.equal(interaction.questions[0].isSecret, true);
  const other = await f.service.createThread({ projectId: "project" });
  assert.throws(() => f.service.answerInteraction(other.id, interaction.id, { secret: { answers: ["SECRET_VALUE"] } }), /变化/);
  f.service.pauseForRestart();
  assert.throws(() => f.service.answerInteraction(thread.id, interaction.id, { secret: { answers: ["SECRET_VALUE"] } }), /paused/);
  await assert.rejects(f.service.interrupt(run.id), /paused/);
  f.service.resumeAfterCancelledRestart();
  f.service.answerInteraction(thread.id, interaction.id, { secret: { answers: ["SECRET_VALUE"] } });
  await waitFor(() => f.service.getRun(run.id).status === "completed");
  assert.deepEqual(received, { secret: { answers: ["SECRET_VALUE"] } });
  assert.equal(JSON.stringify(f.database.listAiChatEvents(thread.id)).includes("SECRET_VALUE"), false);
  assert.equal(f.service.getThreadSnapshot(thread.id).interactions.length, 0);
});

test("an uncertain approval flush rereads its pending request without automatically resending the old decision", async t => {
  const decisions = [], refreshed = Promise.withResolvers(); let second;
  const request = { threadId: "", turnId: "", itemId: "approval", nativeKey: "original-request",
    options: [{ id: "accept", label: "允许一次" }, { id: "decline", label: "拒绝" }] };
  const f = await createFixture({ async onRun(input, entry) {
    Object.assign(request, { threadId: entry.threadId, turnId: entry.turnId });
    decisions.push(await input.onApproval(request));
    input.onApprovalResult(request, "failed");
    await refreshed.promise;
    decisions.push(await second);
    input.onApprovalResult(request, "confirmed");
    return "Done";
  } });
  t.after(() => f.close());
  const observe = f.backend.observeThreadInteractions.bind(f.backend);
  f.backend.observeThreadInteractions = async (...args) => {
    await observe(...args);
    if (decisions.length === 1) { second = args[2].onApproval({ request }); refreshed.resolve(); }
  };
  const thread = await f.service.createThread({ projectId: "project" });
  const run = await f.service.startTurn(thread.id, { message: "ask once" });
  await waitFor(() => f.service.getThreadSnapshot(thread.id).interactions.length);
  const id = f.service.getThreadSnapshot(thread.id).interactions[0].id;
  f.service.answerInteraction(thread.id, id, "accept");
  await waitFor(() => f.service.getThreadSnapshot(thread.id).interactions.some(item => !item.submitted));
  assert.deepEqual(decisions, ["accept"], "a fresh pending request must await another explicit answer");
  f.service.answerInteraction(thread.id, id, "decline");
  await waitFor(() => f.service.getRun(run.id).status === "completed");
  assert.deepEqual(decisions, ["accept", "decline"]);
  assert.equal(f.core.calls.length, 1);
});

test("attachments survive a detached observer and cleanup follows the confirmed native terminal event", async t => {
  const release = Promise.withResolvers(); const f = await createFixture({ onRun: () => release.promise });
  t.after(() => { release.resolve("done"); return f.close(); });
  const thread = await f.service.createThread({ projectId: "project" });
  const run = await f.service.startTurn(thread.id, { message: "selected image", attachments: [{ filename: "image.png", contentType: "image/png", size: 3, data: Buffer.from("png") }] });
  await waitFor(() => f.core.calls.length === 1);
  const image = f.core.calls[0].imagePaths[0]; await access(image);
  await f.service.close(); await f.backend.close();
  await access(image); assert.equal(f.service.getRun(run.id).status, "running");
  const backend = f.core.client();
  f.service = new AiChatService({ database: f.database, nativeBackend: backend, codexStatePath: path.join(f.directory, "codex-state.json") });
  f.service.recover(); release.resolve("done");
  await waitFor(() => f.service.getRun(run.id).status === "completed");
  await waitFor(async () => { try { await access(image); return false; } catch { return true; } });
  await backend.close();
});

test("startTurn revalidates the latest danger sandbox and persisted model settings", async () => {
  const fixture = await createFixture();
  try {
    for (const scenario of [
      {
        changes: { sandbox: "danger-full-access" },
        expectedCode: "DANGER_CONFIRMATION_REQUIRED",
      },
      {
        changes: { model: "retired-model" },
        expectedCode: "INVALID_MODEL",
      },
      {
        changes: { reasoningEffort: "ultra" },
        expectedCode: "INVALID_REASONING_EFFORT",
      },
    ]) {
      const thread = await fixture.service.createThread({ projectId: "project" });
      const originalGetCatalog = fixture.service.getCatalog.bind(fixture.service);
      let releaseCatalog;
      let catalogRequested = false;
      const catalogGate = new Promise((resolve) => {
        releaseCatalog = resolve;
      });
      fixture.service.getCatalog = async (...args) => {
        catalogRequested = true;
        await catalogGate;
        return originalGetCatalog(...args);
      };

      const pending = fixture.service.startTurn(thread.id, { message: "must not spawn" });
      await waitFor(() => catalogRequested);
      fixture.database.updateAiChatThread(thread.id, scenario.changes);
      releaseCatalog();
      await assert.rejects(pending, (error) => error.code === scenario.expectedCode);
      assert.equal(fixture.database.listAiChatRuns(thread.id).length, 0);
      fixture.service.getCatalog = originalGetCatalog;
    }
  } finally {
    await fixture.close();
  }
});

test("settings changed during attachment preparation govern the process that is actually spawned", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project", sandbox: "danger-full-access" });
    const readThread = fixture.database.getAiChatThread.bind(fixture.database);
    let reads = 0;
    fixture.database.getAiChatThread = id => {
      const value = readThread(id);
      if (id === thread.id && ++reads === 2) queueMicrotask(() => {
        fixture.database.updateAiChatThread(id, { sandbox: "read-only" });
      });
      return value;
    };
    const run = await fixture.service.startTurn(thread.id, { message: "use current permission", dangerFullAccessConfirmed: true });
    await waitFor(() => fixture.service.getRun(run.id).status !== "running");
    const captures = fixture.core.calls;
    assert.equal(captures.length, 1);
    assert.equal(captures[0].nativeSettings.sandbox === "danger-full-access", false, "the old broad permission must not survive an asynchronous preparation boundary");
    assert.equal(captures[0].nativeSettings.approvalsReviewer, "user");
  } finally { await fixture.close(); }
});

test("startup marks abandoned runs interrupted while preserving the Codex thread id", async () => {
  const fixture = await createFixture();
  const thread = await fixture.service.createThread({ projectId: "project" });
  fixture.database.database.prepare(
    "UPDATE ai_chat_threads SET codex_thread_id = ?, status = 'running' WHERE id = ?",
  ).run("preserved-session", thread.id);
  fixture.database.database.prepare(`
    INSERT INTO ai_chat_runs (
      id, thread_id, status, exit_code, error, started_at, finished_at
    ) VALUES ('abandoned', ?, 'running', NULL, NULL, ?, NULL)
  `).run(thread.id, new Date().toISOString());
  await fixture.service.close();
  fixture.database.close();
  fixture.database = new TaskboardDatabase(fixture.databasePath);
  const restarted = new AiChatService({
    database: fixture.database,
    nativeBackend: fixture.core.client(),
    codexStatePath: path.join(fixture.directory, "codex-state.json"),
    manageTaskboardSkillPath: "/fixture/manage-taskboard/SKILL.md",
  });
  fixture.service = restarted;
  try {
    assert.equal(restarted.getRun("abandoned").status, "interrupted");
    assert.equal(restarted.getThread(thread.id).codexThreadId, "preserved-session");
  } finally {
    await fixture.close();
  }
});


test("HTTP operation identities retain the original thread/turn across completion and restart without replay", async t => {
  const release = Promise.withResolvers(), f = await createFixture({ onRun: () => release.promise });
  t.after(() => { release.resolve("done"); return f.close(); });
  const create = { projectId:"project", clientRequestId:randomUUID() };
  const [one,two] = await Promise.all([f.service.createThread(create), f.service.createThread(create)]);
  assert.equal(one.id,two.id); assert.equal(f.database.listAiChatThreads().length,1);
  const input = {message:"one actual native input",clientRequestId:randomUUID()};
  const [first,duplicate] = await Promise.all([f.service.startTurn(one.id,input),f.service.startTurn(one.id,input)]);
  assert.equal(first.id,duplicate.id);
  await waitFor(()=>f.core.calls.length===1);
  assert.equal(f.core.calls[0].clientUserMessageId,input.clientRequestId);
  assert.equal(f.service.getSubmission(input.clientRequestId).run.id,first.id);
  release.resolve("done"); await waitFor(()=>f.service.getRun(first.id).status==='completed');
  assert.equal((await f.service.startTurn(one.id,input)).id,first.id);
  assert.equal(f.core.calls.length,1);
  await f.service.close(); f.database.close();
  f.database=new TaskboardDatabase(f.databasePath);
  f.service=new AiChatService({database:f.database,nativeBackend:f.backend,codexStatePath:path.join(f.directory,"codex-state.json")});
  assert.equal((await f.service.startTurn(one.id,input)).id,first.id);
  assert.equal(f.core.calls.length,1);
  assert.equal(f.service.getSubmission(randomUUID()).status,"unknown");
  await assert.rejects(f.service.startTurn(one.id,{...input,message:"changed body"}), e=>e.code==='REQUEST_ID_CONFLICT');
  await assert.rejects(f.service.createThread({...create,title:"changed title"}), e=>e.code==='REQUEST_ID_CONFLICT');
  f.service.deleteThread(one.id);
  assert.equal(f.service.getSubmission(input.clientRequestId).status,"retired");
  await assert.rejects(f.service.startTurn(one.id,input), e=>e.code==='REQUEST_RETIRED');
  await assert.rejects(f.service.createThread(create), e=>e.code==='REQUEST_RETIRED');
  assert.equal(f.core.calls.length,1);
});

test("submission identity binds scope, kind and attachment bytes, and a failed receipt transaction creates no turn", async t => {
  const f=await createFixture();t.after(()=>f.close());
  const thread=await f.service.createThread({projectId:'project'}), other=await f.service.createThread({projectId:'project'});
  const input={message:'attached',clientRequestId:randomUUID(),attachments:[{filename:'a.txt',contentType:'text/plain',size:3,data:Buffer.from('one')}]};
  const first=await f.service.startTurn(thread.id,input);await waitFor(()=>f.service.getRun(first.id).status==='completed');
  await assert.rejects(f.service.startTurn(other.id,input), e=>e.code==='REQUEST_ID_CONFLICT');
  await assert.rejects(f.service.createThread({projectId:'project',clientRequestId:input.clientRequestId}), e=>e.code==='REQUEST_ID_CONFLICT');
  await assert.rejects(f.service.startTurn(thread.id,{...input,attachments:[{...input.attachments[0],data:Buffer.from('two')}]}),e=>e.code==='REQUEST_ID_CONFLICT');
  const save=f.database.saveAiChatSubmission;f.database.saveAiChatSubmission=()=>{throw Error('Isolated receipt write failure');};
  const failedId=randomUUID(), previousEvents=f.database.listAiChatEvents(thread.id).length;
  await assert.rejects(f.service.startTurn(thread.id,{message:'not committed',clientRequestId:failedId}),/receipt write failure/);
  await assert.rejects(f.service.createThread({projectId:'project',clientRequestId:randomUUID()}),/receipt write failure/);
  f.database.saveAiChatSubmission=save;
  assert.equal(f.database.listAiChatThreads().length,2);assert.equal(f.database.listAiChatRuns(thread.id).length,1);
  assert.equal(f.database.listAiChatEvents(thread.id).length,previousEvents);assert.equal(f.core.calls.length,1);
  assert.equal(f.service.getSubmission(failedId).status,'unknown');
});
