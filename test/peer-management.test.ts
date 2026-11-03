import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { peerFixture, principal } from "./peer-fixture.js";
import { BridgeService } from "../src/bridge/service.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";

async function fixture(t: test.TestContext, device = true) {
  const f = await peerFixture(t, { device });
  const workspace = path.join(f.root, "device-project"); fs.mkdirSync(workspace);
  f.thread.cwd = fs.realpathSync(workspace);
  f.projects.push({ id: "device-native-project", name: "本机项目", roots: [f.thread.cwd] });
  await f.bind();
  return f;
}

test("project discovery and empty-session creation stay on the approved device and do not run a model", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.as(() => f.facade.listProjects(f.ticket.hostId))).projects, f.projects);
  const input = { projectId: f.projects[0].id, cwd: f.projects[0].roots[0], title: "专用空会话", clientUserMessageId: "create-one", assertCurrent() {} };
  const created = await f.as(() => f.facade.createThread!(input, f.ticket.hostId));
  assert.equal(created.cwd, fs.realpathSync(input.cwd)); assert.equal(created.projectId, input.projectId); assert.equal(created.title, input.title);
  assert.equal(f.runs.length, 0); assert.equal(f.management.filter(c=>c.method==="create").length, 1);
  await f.reconnect(true);
  assert.equal((await f.as(() => f.facade.createThread!(input, f.ticket.hostId))).threadId, created.threadId);
  assert.equal(f.management.filter(c=>c.method==="create").length, 1);
  await assert.rejects(f.as(() => f.facade.createThread!({ ...input, title: "changed" }, f.ticket.hostId)), /reused/);
});

test("a standalone device session uses a private device directory and rejects mixed project paths", async t => {
  const f = await fixture(t);
  const created = await f.as(() => f.facade.createThread!({ standalone: true, title: "独立测试", clientUserMessageId: "standalone-one" }, f.ticket.hostId));
  assert.ok(created.cwd?.startsWith(fs.realpathSync(path.join(f.root, "client", "workspaces"))));
  assert.equal(created.projectMembership, "none"); assert.equal(fs.statSync(created.cwd!).mode & 0o777, 0o700);
  await assert.rejects(f.as(() => f.facade.createThread!({ standalone: true, cwd: "/arbitrary", clientUserMessageId: "mixed" }, f.ticket.hostId)), /cannot select/);
  await assert.rejects(f.as(() => f.facade.createThread!({ projectId: f.projects[0].id, cwd: "/arbitrary", clientUserMessageId: "outside" }, f.ticket.hostId)));
  await assert.rejects(f.as(() => f.facade.createThread!({ projectId: "stale-project", clientUserMessageId: "stale" }, f.ticket.hostId)), /no longer/);
  assert.equal(f.management.filter(c=>c.method==="create").length, 1);
});

test("fixed-session grants retain lifecycle access to that thread without becoming device grants", async t => {
  const f = await fixture(t, false);
  assert.deepEqual((await f.as(() => f.facade.listProjects(f.ticket.hostId))).projects, []);
  await assert.rejects(f.as(() => f.facade.createThread!({ standalone: true }, f.ticket.hostId)), /固定会话/);
  await assert.rejects(f.as(() => f.facade.renameThread!("other", "wrong", f.ticket.hostId, () => {})), /granted thread/);
  await f.as(() => f.facade.renameThread!(f.thread.threadId, "改名", f.ticket.hostId, () => {}, "rename-fixed"));
  await f.as(() => f.facade.archiveThread(f.thread.threadId, f.ticket.hostId, () => {}, "archive-fixed"));
  await f.reconnect(true);
  const archived = await f.as(() => f.facade.listSessionCatalog({ persistence: "archived" }, f.ticket.hostId));
  assert.equal(archived.threads[0]?.threadId, f.thread.threadId);
  await f.as(() => f.facade.unarchiveThread(f.thread.threadId, f.ticket.hostId, () => {}, "restore-fixed"));
  assert.equal(f.thread.persistence, "active"); assert.equal(f.thread.title, "改名");
  await f.as(() => f.facade.unarchiveThread(f.thread.threadId, f.ticket.hostId, () => {}, "restore-fixed"));
  assert.equal(f.management.filter(c=>c.method==="restore").length, 1);
});

test("project aliases are canonicalized on the device and an existing project worktree can create another session", async t => {
  const f = await fixture(t), alias = path.join(f.root, "root-alias"), worktree = path.join(f.root, "existing-worktree");
  fs.symlinkSync(f.projects[0].roots[0], alias); f.projects[0].roots=[alias];
  assert.equal((await f.as(()=>f.facade.listProjects(f.ticket.hostId))).projects[0].roots[0],fs.realpathSync(alias));
  fs.mkdirSync(worktree); f.thread.cwd=fs.realpathSync(worktree); f.thread.projectId=f.projects[0].id; f.thread.projectMembership="assigned";
  const created=await f.as(()=>f.facade.createThread!({projectId:f.projects[0].id,cwd:f.thread.cwd,sourceThreadId:f.thread.threadId,clientUserMessageId:"worktree-create"},f.ticket.hostId));
  assert.equal(created.cwd,f.thread.cwd); assert.equal(created.projectId,f.projects[0].id);
  f.thread.projectId="another-project";
  await assert.rejects(f.as(()=>f.facade.createThread!({projectId:f.projects[0].id,cwd:f.thread.cwd,sourceThreadId:f.thread.threadId,clientUserMessageId:"wrong-project-worktree"},f.ticket.hostId)),/confirmed existing worktree/);
});

test("a dropped creation reply never starts another native session on retry", async t => {
  const f=await fixture(t), entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
  const original=f.backend.createThread!.bind(f.backend);
  f.backend.createThread=async input=>{const state=await original(input);entered.resolve();await release.promise;return state;};
  const input={standalone:true,clientUserMessageId:"ambiguous-create"};
  const pending=f.as(()=>f.facade.createThread!(input,f.ticket.hostId)), rejected=assert.rejects(pending);
  await entered.promise;await f.reconnect();await rejected;
  await assert.rejects(f.as(()=>f.facade.createThread!(input,f.ticket.hostId)), error => (error as Error).name === "CodexCommunicationError");
  assert.equal(f.management.filter(c=>c.method==="create").length,1);
  release.resolve();await new Promise<void>(resolve=>setImmediate(resolve));
  const recovered=await f.as(()=>f.facade.createThread!(input,f.ticket.hostId));
  assert.ok(recovered.threadId);assert.equal(f.management.filter(c=>c.method==="create").length,1);
});

test("archiving does not discard queued native work", async t => {
  const f = await fixture(t);
  f.backend.listQueuedSubmissions = async () => ({ data: [{ id: "queued-one", clientUserMessageId: "queued-source", input: [{ type: "text", text: "next task" }] }] });
  await assert.rejects(f.as(() => f.facade.archiveThread(f.thread.threadId, f.ticket.hostId, () => {}, "queued-archive")), /queued work/);
  assert.equal(f.management.length, 0);
});

test("management writes require chat authority, a live guard, an idle target and a durable journal", async t => {
  const f = await fixture(t);
  for (const who of [{...principal,actorId:"other"},{...principal,conversationId:"other"},{...principal,accountId:"other"}])
    await assert.rejects(f.as(() => f.facade.archiveThread(f.thread.threadId, f.ticket.hostId, () => {}, "forged"), who), /未获准/);
  await assert.rejects(f.facade.archiveThread(f.thread.threadId, f.ticket.hostId, () => {}, "no-actor"), /未获准/);
  await assert.rejects(f.as(() => f.facade.archiveThread(f.thread.threadId, f.ticket.hostId, () => { throw Error("binding changed"); }, "stale-binding")));
  f.thread.runtimeStatus = "active"; f.thread.activeTurnId = "active-turn";
  await assert.rejects(f.as(() => f.facade.archiveThread(f.thread.threadId, f.ticket.hostId, () => {}, "busy")), /active work/);
  f.thread.runtimeStatus = "unknown"; delete f.thread.activeTurnId;
  await assert.rejects(f.as(() => f.facade.archiveThread(f.thread.threadId, f.ticket.hostId, () => {}, "unknown")), /not confirmed/);
  f.thread.runtimeStatus = "idle";
  await assert.rejects(f.as(() => f.facade.deleteThread(f.thread.threadId, f.ticket.hostId, () => {}, "active-delete")), /already archived/);
  const original = fs.fsyncSync; fs.fsyncSync = () => { throw Error("disk unavailable"); };
  try { await assert.rejects(f.as(() => f.facade.createThread!({ standalone: true, clientUserMessageId: "no-disk" }, f.ticket.hostId))); }
  finally { fs.fsyncSync = original; }
  assert.equal(f.management.length, 0);
});

test("DingTalk selects a device project and creates a native session without running a model", async t => {
  const f = await fixture(t), paths = resolveStatePaths(path.join(f.root, "gateway-state")), store = new RuntimeStateStore(paths);
  const replies: string[] = [];
  const runner = new Proxy(f.facade, { get(target, key) {
    if (key === "listProjects") return (host?: string) => { assert.equal(host, f.ticket.hostId, "Project browsing must not depend on Gateway Codex"); return target.listProjects(host); };
    return Reflect.get(target, key);
  } });
  const service = new BridgeService({ accountId: principal.accountId, stateStore: store, runner, peer: f.registry,
    config: { ...defaultConfig(paths.root), codexBackend: "exec", allowedSenderIds: [principal.actorId], streamReplies: false },
    channel: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText(input) { replies.push(input.text); return {messageId:crypto.randomUUID()}; } }) });
  t.after(()=>service.suspendUserInputs());
  const send = (text: string) => service.handleMessage({id:crypto.randomUUID(),senderId:principal.actorId,replyTargetId:principal.conversationId,text,attachments:[],raw:{}});
  await send("/project"); assert.ok(replies.at(-1)?.includes("本机项目"), replies.at(-1));
  await send("/new C1");
  const created = store.getBoundSession(principal.conversationId)!;
  assert.ok(created?.threadId, replies.at(-1)); assert.equal(created.hostId, f.ticket.hostId); assert.equal(f.runs.length, 0);
  await send("继续这个会话"); assert.equal(f.runs.at(-1)?.threadId,created.threadId);
  await send("/leave"); assert.equal(store.getBoundSession(principal.conversationId),undefined); assert.equal(f.threads.find(t=>t.threadId===created.threadId)?.persistence,"active");
});

test("an unbound paired chat can create a standalone device session and viewers cannot create another", async t => {
  const f = await fixture(t), paths=resolveStatePaths(path.join(f.root,"gateway-state")), store=new RuntimeStateStore(paths), replies:string[]=[];
  const service=new BridgeService({accountId:principal.accountId,stateStore:store,runner:f.facade,peer:f.registry,
    config:{...defaultConfig(paths.root),allowedSenderIds:[principal.actorId],streamReplies:false},
    channel:createChannelClient("dingtalk",TEXT_CAPABILITIES,{async sendText(input){replies.push(input.text);return{messageId:crypto.randomUUID()};}})});
  t.after(()=>service.suspendUserInputs());
  const send=(text:string)=>service.handleMessage({id:crypto.randomUUID(),senderId:principal.actorId,replyTargetId:principal.conversationId,text,attachments:[],raw:{}});
  await send("/new --standalone"); const session=store.getBoundSession(principal.conversationId)!;
  assert.equal(session?.hostId,f.ticket.hostId); assert.equal(session.projectBinding,"none"); assert.equal(f.runs.length,0);
  store.setRole(principal.conversationId,principal.actorId,"viewer");
  await send("/new --standalone");
  assert.equal(f.management.length,1); assert.equal(store.getBoundSession(principal.conversationId)?.id, session.id);
  assert.ok(replies.at(-1)?.includes("participant"));
});
