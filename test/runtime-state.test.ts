import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

function createStore(t: test.TestContext): RuntimeStateStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new RuntimeStateStore(resolveStatePaths(root));
}

for (const standalone of [true, false]) test(`legacy project drift preserves the explicit ${standalone ? "independent" : "project"} session binding`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-binding-context-")), paths = resolveStatePaths(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(paths), p = store.createProject("Correct project", "/work/correct"), other = store.createProject("Unrelated", "/work/unrelated");
  const session = store.createSession("chat", "/work/correct", "Original session", standalone ? undefined : p.id, "session", undefined, { standalone });
  store.setSessionThread(session.id, "original-native-thread"); store.recordBindingHumanActivity("chat");
  const before = store.snapshot, legacy = structuredClone(before); legacy.activeProjectIds.chat = other.id;
  fs.writeFileSync(paths.statePath, JSON.stringify(legacy));
  const restored = new RuntimeStateStore(paths);
  assert.equal(restored.getBoundSession("chat")?.id, session.id); assert.equal(restored.getBoundSession("chat")?.threadId, "original-native-thread");
  assert.equal(restored.getActiveProject("chat")?.id, standalone ? undefined : p.id);
  assert.deepEqual(restored.snapshot.activeSessionIds, before.activeSessionIds);
  assert.deepEqual(restored.snapshot.bindingActivity, before.bindingActivity);
  assert.deepEqual(restored.snapshot.detachedSessionSenders, before.detachedSessionSenders);
  assert.equal(restored.listSessions().length, 1);
  restored.reconcileThreadProject("original-native-thread", "local", undefined, "/work/correct");
  assert.equal(restored.getActiveProject("chat"), undefined); assert.equal(restored.getBoundSession("chat")?.id, session.id);
});

test("explicit project switching ends an incompatible edge and cannot revive it on a later project switch", t => {
  const store = createStore(t), first = store.createProject("First", "/work/first"), next = store.createProject("Next", "/work/next");
  const session = store.createSession("chat", first.workspace, "Bound", first.id);
  store.activateProject("chat", next.id);
  assert.equal(store.getBoundSession("chat"), undefined); assert.equal(store.getActiveSession("chat"), undefined);
  assert.equal(store.getSession(session.id)?.follow, false); assert.equal(store.getActiveProject("chat")?.id, next.id);
  store.activateProject("chat", first.id);
  assert.equal(store.getBoundSession("chat"), undefined); assert.equal(store.listSessions().length, 1);
});

test("project selection retains a compatible QA edge while retiring an incompatible inactive normal slot", t => {
  const store = createStore(t), p = store.createProject("Normal project", "/work/normal"), q = store.createProject("QA project", "/work/qa");
  const normal = store.createSession("chat", p.workspace, "Normal", p.id);
  const qa = store.createSession("chat", q.workspace, "QA", q.id, "qa");
  store.setInteractionMode("chat", "qa"); store.activateProject("chat", q.id);
  assert.equal(store.getBoundSession("chat")?.id, qa.id); assert.equal(store.getActiveSession("chat"), undefined);
  assert.equal(store.getSession(normal.id)?.follow, false);
  store.setInteractionMode("chat", "session");
  assert.equal(store.getBoundSession("chat"), undefined); assert.equal(store.getActiveProject("chat")?.id, q.id);
});

test("legacy detached receipts are never repaired into active bindings", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-detached-context-")), paths = resolveStatePaths(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(paths), p = store.createProject("Project", "/work/project");
  const session = store.createSession("chat", "/work/independent", "Standalone", undefined, "session", undefined, { standalone: true });
  store.leaveSession("chat"); const disk = store.snapshot;
  disk.activeSessionIds.chat = session.id; disk.activeProjectIds.chat = p.id;
  fs.writeFileSync(paths.statePath, JSON.stringify(disk));
  const restored = new RuntimeStateStore(paths);
  assert.equal(restored.getBoundSession("chat"), undefined); assert.equal(restored.isSessionDetached("chat"), true);
  assert.equal(restored.getSession(session.id)?.follow, false);
});

test("Taskboard selects a new binding without rewriting the previous session", t => {
  const store = createStore(t);
  const project = store.createProject("Project", "/work/project");
  const previous = store.createSession("chat", project.workspace, "Original", project.id);
  store.setSessionThread(previous.id, "original-thread");
  const next = store.bindProjectThread("chat", project.id, "task-thread", "Task");
  assert.notEqual(next.id, previous.id);
  assert.equal(store.getSession(previous.id)?.threadId, "original-thread");
  assert.equal(store.getActiveSession("chat")?.threadId, "task-thread");
  assert.equal(store.bindProjectThread("chat", project.id, "original-thread", "Original").id, previous.id);
  assert.equal(store.listSessions().length, 2);
});

test("keeps a channel actor separate from its conversation scope", (t) => {
  const store = createStore(t);

  store.rememberChannelIdentity("ou_pending", "oc_chat", false);

  assert.equal(store.getLastActiveActorId(), "ou_pending");
  assert.equal(store.getLastActiveSenderId(), "oc_chat");
  assert.equal(store.getLastAuthorizedSenderId(), undefined);
  assert.deepEqual(store.listPairedSenderIds(), []);

  store.setPairedSenderIds(["ou_pending"]);
  store.rememberChannelIdentity("ou_pending", "oc_chat", true);
  assert.equal(store.getLastAuthorizedActorId(), "ou_pending");
  assert.equal(store.getLastAuthorizedSenderId(), "oc_chat");
  assert.equal(store.getAuthorizedConversation("ou_pending"), "oc_chat");
  assert.equal(store.getAuthorizedConversation("ou_other"), undefined);
});

test("uses the matching legacy authorized identity until an actor link is persisted", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
  fs.writeFileSync(paths.statePath, JSON.stringify({
    pairedSenderIds: ["oc_legacy_room"],
    lastAuthorizedActorId: "ou_legacy_owner",
    lastAuthorizedSenderId: "oc_legacy_room"
  }));

  const store = new RuntimeStateStore(paths);

  assert.equal(store.getAuthorizedConversation("ou_legacy_owner"), "oc_legacy_room");
  assert.equal(store.getAuthorizedConversation("ou_other"), undefined);
});

test("creates and activates a managed session for a sender", (t) => {
  const store = createStore(t);
  const first = store.ensureActiveSession("alice@im.wechat", "/work/one");
  const same = store.ensureActiveSession("alice@im.wechat", "/work/two");

  assert.equal(same.id, first.id);
  assert.equal(store.getWorkspace("alice@im.wechat"), path.resolve("/work/one"));
  assert.equal(store.listSessions().length, 1);
});

test("preserves Codex Desktop routing metadata on a remote project", (t) => {
  const store = createStore(t);
  const project = store.createProject("Remote", "/home/admin/project", {
    sourceProjectId: "desktop-project-id",
    projectKind: "remote",
    hostId: "remote-ssh-discovered:devbox"
  });
  const session = store.createSession("alice@im.wechat", project.workspace, "Remote session", project.id);

  assert.deepEqual({
    sourceProjectId: store.getProject(project.id)?.sourceProjectId,
    projectKind: store.getProject(project.id)?.projectKind,
    hostId: store.getProject(project.id)?.hostId,
    sessionProjectId: session.projectId
  }, {
    sourceProjectId: "desktop-project-id",
    projectKind: "remote",
    hostId: "remote-ssh-discovered:devbox",
    sessionProjectId: project.id
  });
});

test("backfills Codex Desktop routing metadata on an existing project", (t) => {
  const store = createStore(t);
  const project = store.createProject("Bridge", "/work/bridge");

  const updated = store.updateProjectMetadata(project.id, {
    sourceProjectId: "desktop-project-id",
    projectKind: "local"
  });

  assert.equal(updated.sourceProjectId, "desktop-project-id");
  assert.equal(updated.projectKind, "local");
});

test("supports create, rename, switch, reset, and delete", (t) => {
  const store = createStore(t);
  const first = store.createSession("alice@im.wechat", "/work/one", "第一项");
  store.setThread("alice@im.wechat", "thread-one");
  const second = store.createSession("alice@im.wechat", "/work/two", "第二项");

  assert.equal(store.getActiveSession("alice@im.wechat")?.id, second.id);
  store.renameSession(second.id, "发布准备");
  assert.equal(store.getActiveSession("alice@im.wechat")?.title, "发布准备");

  store.activateSession(first.id);
  assert.equal(store.getThread("alice@im.wechat"), "thread-one");
  store.resetSession(first.id);
  assert.equal(store.getThread("alice@im.wechat"), undefined);

  store.deleteSession(first.id);
  assert.equal(store.getActiveSession("alice@im.wechat"), undefined);
  assert.equal(store.isSessionDetached("alice@im.wechat"), true);
  assert.equal(store.listSessions().length, 1);
});

test("persists a prompt preview without changing the session activity time", (t) => {
  const store = createStore(t);
  const session = store.createSession("alice@im.wechat", "/work/one", "历史会话");

  store.setSessionPromptPreview(session.id, "  分析   项目方案  ");

  const updated = store.getSession(session.id);
  assert.equal(updated?.lastPromptPreview, "分析 项目方案");
  assert.equal(updated?.updatedAt, session.updatedAt);
});

test("replaces a generated Bridge session title with the first clean user preview", (t) => {
  const store = createStore(t);
  const session = store.createSession("alice@im.wechat", "/work/one");

  store.setSessionPromptPreview(session.id, "本机装的云壳是什么？");

  assert.equal(store.getSession(session.id)?.title, "本机装的云壳是什么？");
});

test("keeps sessions for different senders independent", (t) => {
  const store = createStore(t);
  const alice = store.createSession("alice@im.wechat", "/alice", "Alice");
  const bob = store.createSession("bob@im.wechat", "/bob", "Bob");
  store.activateSession(alice.id);
  store.setThread("alice@im.wechat", "thread-alice");
  store.activateSession(bob.id);
  store.setThread("bob@im.wechat", "thread-bob");

  assert.equal(store.getThread("alice@im.wechat"), "thread-alice");
  assert.equal(store.getThread("bob@im.wechat"), "thread-bob");
  assert.equal(store.getWorkspace("alice@im.wechat"), path.resolve("/alice"));
  assert.equal(store.getWorkspace("bob@im.wechat"), path.resolve("/bob"));
});

test("manages projects and keeps sessions attached to their project", (t) => {
  const store = createStore(t);

  // Given an account-local project
  const project = store.createProject("嘉兴AI社区", "/work/jiaxing");

  // When a task is created inside it
  const session = store.createSession("alice@im.wechat", project.workspace, "整理创业想法", project.id);

  // Then project metadata and task ownership persist together
  assert.equal(store.listProjects()[0]?.name, "嘉兴AI社区");
  assert.equal(store.getSession(session.id)?.projectId, project.id);
  assert.equal(store.renameProject(project.id, "嘉兴 AI 社区").name, "嘉兴 AI 社区");
});

test("keeps project selection, interaction mode, and llm-wiki Q&A sessions independent", (t) => {
  const store = createStore(t);
  const project = store.createProject("产品研发", "/work/product");
  const knowledgeBase = store.createKnowledgeBase("产品 Wiki", "/knowledge/product", {
    engineRoot: "/tools/llm-wiki",
    stateDir: "/knowledge/state"
  });
  store.bindProjectKnowledgeBase(project.id, knowledgeBase.id);

  store.activateProject("alice@im.wechat", project.id);
  store.setInteractionMode("alice@im.wechat", "qa");
  const qa = store.createSession(
    "alice@im.wechat",
    project.workspace,
    "问答 · 产品 Wiki",
    project.id,
    "qa",
    knowledgeBase.id
  );
  const chat = store.createSession("alice@im.wechat", project.workspace, "实现功能", project.id);

  assert.equal(store.getActiveProject("alice@im.wechat")?.id, project.id);
  assert.equal(store.getInteractionMode("alice@im.wechat"), "qa");
  assert.equal(store.getActiveQaSession("alice@im.wechat")?.id, qa.id);
  assert.equal(store.getActiveSession("alice@im.wechat")?.id, chat.id);
  assert.equal(store.listProjects()[0]?.knowledgeBaseId, knowledgeBase.id);
  assert.equal(store.listKnowledgeBases()[0]?.rootPath, path.resolve("/knowledge/product"));

  assert.throws(() => store.deleteKnowledgeBase(knowledgeBase.id), /still bound/);
  store.bindProjectKnowledgeBase(project.id);
  assert.equal(store.getInteractionMode("alice@im.wechat"), "session");
  store.deleteKnowledgeBase(knowledgeBase.id);
  assert.equal(store.listKnowledgeBases().length, 0);
});

test("persists deduplicated project completion notification targets", (t) => {
  const store = createStore(t);
  const project = store.createProject("通知项目", "/work/notifications");

  store.setProjectNotifications(project.id, [
    { accountId: "wecom-bot", recipientId: "engineering", enabled: true },
    { accountId: "wecom-bot", recipientId: "engineering", enabled: false },
    { accountId: "feishu-app", recipientId: "oc_chat", enabled: true }
  ]);

  assert.deepEqual(store.listProjects()[0].notifications, [
    { accountId: "wecom-bot", recipientId: "engineering", enabled: false },
    { accountId: "feishu-app", recipientId: "oc_chat", enabled: true }
  ]);
});

test("prevents deleting a project that still owns sessions", (t) => {
  const store = createStore(t);
  const project = store.createProject("内容运营", "/work/content");
  store.createSession("alice@im.wechat", project.workspace, "首篇小红书", project.id);

  assert.throws(() => store.deleteProject(project.id), /still has sessions/);
});

test("migrates existing session workspaces into account-local projects", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-project-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const original = new RuntimeStateStore(paths);
  const session = original.createSession("alice@im.wechat", "/work/legacy", "旧任务");

  const reloaded = new RuntimeStateStore(paths);
  const project = reloaded.listProjects()[0];
  assert.equal(project?.workspace, path.resolve("/work/legacy"));
  assert.equal(reloaded.getSession(session.id)?.projectId, project?.id);
});

for (const projectBinding of [undefined, "none", "unknown"] as const) test(`retires legacy execution overrides on load without changing native bindings (${projectBinding ?? "project"})`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-settings-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root), store = new RuntimeStateStore(paths);
  const first = store.createSession("actor", "/work", "Existing");
  store.setSessionThread(first.id, "native-thread");
  const legacy = JSON.parse(fs.readFileSync(paths.statePath, "utf8"));
  Object.assign(legacy.sessions[0], { projectBinding, model: "stale-model", effort: "high", collaborationMode: "plan", streamReplies: false });
  fs.writeFileSync(paths.statePath, JSON.stringify(legacy));
  const restored = new RuntimeStateStore(paths).getSession(first.id)!;
  assert.equal(restored.threadId, "native-thread");
  assert.equal(restored.model, undefined); assert.equal(restored.effort, undefined); assert.equal(restored.collaborationMode, undefined);
  assert.equal(restored.streamReplies, false);
  assert.equal(JSON.parse(fs.readFileSync(paths.statePath, "utf8")).sessions[0].model, undefined);
});

test("runtime state saves presentation preferences and rejects new execution overrides", t => {
  const store = createStore(t), session = store.createSession("actor", "/work");
  assert.throws(() => store.updateSessionRuntime(session.id, { model: "model" }), /App Server/);
  assert.throws(() => store.setEffortOverride("actor", "high"), /App Server/);
  assert.throws(() => store.setSessionCollaborationMode(session.id, "plan"), /App Server/);
  store.updateSessionRuntime(session.id, { streamReplies: true });
  assert.equal(store.getSession(session.id)?.streamReplies, true);
  store.updateSessionRuntime(session.id, { model: null, effort: null, streamReplies: null });
  assert.equal(store.getSession(session.id)?.streamReplies, undefined);
});

test("retired Gateway memory fields migrate away without changing bindings or llm-wiki", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-memory-removal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root), store = new RuntimeStateStore(paths);
  const project = store.createProject("Project", root);
  const session = store.createSession("actor", root, "Session", project.id);
  store.setSessionThread(session.id, "thread");
  store.createKnowledgeBase("Wiki", root);
  const expected = store.snapshot;
  fs.writeFileSync(paths.statePath, JSON.stringify({ ...expected,
    knowledge: [{ content: "retired other-user preference" }], knowledgeEnabled: true }));
  const migrated = new RuntimeStateStore(paths);
  assert.deepEqual(migrated.snapshot, expected);
  const saved = fs.readFileSync(paths.statePath, "utf8");
  assert.doesNotMatch(saved, /retired other-user preference|knowledgeEnabled|"knowledge":/);
  assert.equal(new RuntimeStateStore(paths).getBoundSession("actor")?.threadId, "thread");
  assert.equal(migrated.listKnowledgeBases().length, 1);
  assert.equal(fs.readFileSync(paths.statePath, "utf8"), saved, "migration is idempotent");
});

test("persistently claims inbound message ids once and bounds the history", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-dedupe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const store = new RuntimeStateStore(paths);

  assert.equal(store.claimProcessedMessage("message-one"), true);
  assert.equal(store.claimProcessedMessage("message-one"), false);
  assert.equal(new RuntimeStateStore(paths).claimProcessedMessage("message-one"), false);

  for (let index = 0; index < 1_005; index += 1) {
    store.claimProcessedMessage(`message-${index + 2}`);
  }
  assert.equal(store.snapshot.processedMessageIds.length, 1_000);
  assert.equal(store.snapshot.processedMessageIds.includes("message-one"), false);
});

test("stores the latest WeChat sync key across monitor restarts", (t) => {
  const store = createStore(t);

  assert.equal(store.getSyncKey(), undefined);
  store.setSyncKey("sync-next");
  assert.equal(store.getSyncKey(), "sync-next");
});


test("provider identity keys stay ordinary data across save, reload and normal context selection",t=>{
  const store=createStore(t);
  for(const identity of ['__proto__','constructor','toString','ordinary']) {
    store.rememberContextToken(identity,`context:${identity}`);
    assert.equal(store.getContextToken(identity),`context:${identity}`);
    store.setInteractionMode(identity,'qa');assert.equal(store.getInteractionMode(identity),'qa');
    store.setRole(identity,identity,'viewer');assert.equal(store.roleFor(identity,identity),'viewer');
  }
  store.refresh();
  for(const identity of ['__proto__','constructor','toString','ordinary'])assert.equal(store.getContextToken(identity),`context:${identity}`);
});

test("runtime failed disk commit restores the sole live owner's roles, binding and settings",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-commit-fail-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const paths=resolveStatePaths(root),store=new RuntimeStateStore(paths),project=store.createProject('Project','/work/project');
  const session=store.createSession('chat',project.workspace,'Original',project.id);store.setRole('chat','actor','viewer');
  const before=store.snapshot, disk=fs.readFileSync(paths.statePath,'utf8'),rename=fs.renameSync;
  fs.renameSync=(source,target)=>{if(target===paths.statePath)throw Object.assign(Error('Isolated full disk'),{code:'ENOSPC'});return rename(source,target);};
  try {
    for(const write of [()=>store.setRole('chat','actor','controller'),()=>store.leaveSession('chat'),()=>store.setSessionFollow(session.id,false)]){
      assert.throws(write,/full disk/);assert.deepEqual(store.snapshot,before);assert.equal(fs.readFileSync(paths.statePath,'utf8'),disk);
    }
  }finally{fs.renameSync=rename;}
  store.leaveSession('chat');assert.equal(store.getBoundSession('chat'),undefined);
});
