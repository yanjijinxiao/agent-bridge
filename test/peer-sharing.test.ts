import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { peerFixture, principal } from "./peer-fixture.js";
import { PeerSharingAuthority } from "../src/peer/sharing-authority.js";
import { SharedWorkspacePortal } from "../src/peer/workspace-portal.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { BridgeService } from "../src/bridge/service.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import type { PeerPrincipal } from "../src/peer/context.js";

const visitor = { ...principal, actorId: "visitor", conversationId: "visitor-room" };
async function fixture(t: test.TestContext, approve = true) {
  const confirmations: any[] = [];
  const f = await peerFixture(t, { device: true, approveOwner: async c => { confirmations.push(c); return approve; } });
  const workspace = path.join(f.root, "shared-project"); fs.mkdirSync(workspace); f.thread.cwd = fs.realpathSync(workspace);
  fs.writeFileSync(path.join(workspace, "hello.ts"), "export const answer = 42;\n");
  await f.bind(); const target = { hostId: f.ticket.hostId, threadId: f.thread.threadId };
  const share = (arg: string, who = principal) => f.registry.sharing.command(who, "share", arg, target, () => {});
  const join = (code: string, who = visitor) => f.registry.sharing.command(who, "join", code, undefined, () => {});
  return Object.assign(f, { workspace: f.thread.cwd, target, confirmations, share, join,
    async invite(who = visitor) {
      const text = (await share("invite")).text, code = /SH-[A-F0-9]{32}/.exec(text)![0];
      await join(code, who); const status = await f.registry.sharingCall(target.hostId, "status", target, principal, () => {});
      return { code, id: status.requests.find((q: any) => q.principal.actorId === who.actorId && q.principal.conversationId === who.conversationId).id };
    },
    async status() { return f.registry.sharingCall(target.hostId, "status", target, principal, () => {}); }
  });
}

test("new native activity reads recheck a delegated grant after the device await", async t => {
  const f = await fixture(t); await f.share("claim");
  const invitation = await f.invite(); await f.share(`approve ${invitation.id}`);
  const grant = f.registry.grantsFor(visitor)[0];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.backend.readTurnActivities = async () => {
    entered.resolve(); await release.promise;
    return [{ type: "agent_message", role: "assistant", content: "revoked private result", data: {} }];
  };
  const work = f.as(() => f.facade.readTurnActivities!(f.thread.threadId, "turn", f.target.hostId), visitor);
  const rejected = assert.rejects(work, /未授权|已撤销|已失效|未继续投递/);
  try { await entered.promise; await f.share(`revoke ${grant.id}`); }
  finally { release.resolve(); }
  await rejected;
});

test("only device confirmation creates an owner; a chat controller cannot claim implicitly", async t => {
  const f = await fixture(t, false);
  await assert.rejects(f.share("invite"), /未授权/);
  await assert.rejects(f.share("claim --ide"), /本机未确认/);
  assert.equal(f.confirmations.length, 1); assert.equal(f.confirmations[0].workspace, f.workspace);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.root, "client", "grants.json"), "utf8"));
  assert.equal(persisted.version, 2); assert.equal(Array.isArray(persisted), false, "old array-only clients must reject private-policy state instead of bypassing it");
  await assert.rejects(f.share("invite"), /未授权/);
});

test("an owner approves a scoped visitor without giving device-wide or redelegation rights", async t => {
  const f = await fixture(t); await f.share("claim --ide");
  const invitation = await f.invite();
  assert.equal(f.registry.grantsFor(visitor).length, 0, "knowledge of an invitation is not authorization");
  await f.share(`approve ${invitation.id} --hours 1`);
  const result = await f.join(invitation.code); assert.deepEqual(result.bind, f.target);
  const grant = f.registry.grantsFor(visitor)[0]; assert.equal(grant.scope, undefined); assert.equal(grant.threadId, f.thread.threadId);
  assert.equal(grant.delegation?.version, 2);
  assert.deepEqual(grant.delegation?.permissions, []);
  assert.equal((await f.as(()=>f.facade.getHistory(f.thread.threadId,f.target.hostId),visitor)).length,0);
  f.threads.push({ ...f.thread, threadId: "private-other", title: "never disclose" });
  const catalog = await f.as(()=>f.facade.listSessionCatalog({},f.target.hostId),visitor);
  assert.deepEqual(catalog.threads.map(t=>t.threadId),[f.thread.threadId]);
  await assert.rejects(f.as(()=>f.facade.inspectThread("private-other",f.target.hostId),visitor), /未授权|未获准/);
  await assert.rejects(f.as(()=>f.facade.createThread!({standalone:true},f.target.hostId),visitor), /未授权/);
  await assert.rejects(f.share("claim",visitor), /未授权/);
  await assert.rejects(f.share("invite",visitor), /未授权/);
  assert.equal(f.runs.length,0);
  for (const forged of [{...visitor,conversationId:"other-room"},{...visitor,actorId:"other"},{...visitor,accountId:"other-bot"}])
    await assert.rejects(f.as(()=>f.facade.getHistory(f.thread.threadId,f.target.hostId),forged), /未获准/);
});

test("ownership and grants survive restart; revoked browser and execution grants never revive", async t => {
  const f=await fixture(t);await f.share("claim --ide");const invite=await f.invite();await f.share(`approve ${invite.id} --ide read`);
  const grant=f.registry.grantsFor(visitor)[0];await f.reconnect(true);
  assert.equal((await f.as(()=>f.facade.run(f.input()),visitor)).text,"来自设备的回答");
  await f.share(`revoke ${grant.id}`);assert.equal(f.registry.grantsFor(visitor).length,0);
  await assert.rejects(f.serverConnection.request("execution.call",{grant,method:"getHistory",args:[f.thread.threadId]}), /本机确认|approved/);
  await f.reconnect(true);
  await assert.rejects(f.serverConnection.request("execution.call",{grant,method:"getHistory",args:[f.thread.threadId]}), /本机确认|approved/);
  const disk=fs.readFileSync(path.join(f.root,"client","sharing.json"),"utf8");assert.doesNotMatch(disk,/export const answer/);
  assert.equal(fs.statSync(path.join(f.root,"client","sharing.json")).mode&0o777,0o600);
});

test("claiming a private session prevents another device-paired controller from reading or running it", async t => {
  const f=await fixture(t);await f.share("claim --ide");
  const ticket=await f.reconnect();await f.registry.connect(ticket.code,visitor,()=>{});
  await assert.rejects(f.as(()=>f.facade.inspectThread(f.thread.threadId,f.target.hostId),visitor),/未授权/);
  await assert.rejects(f.as(()=>f.facade.run(f.input()),visitor),/未授权/);
  const catalog=await f.as(()=>f.facade.listSessionCatalog({},f.target.hostId),visitor);
  assert.equal(catalog.threads.length,0);assert.equal(f.runs.length,0);
  const invitation=await f.invite();await f.share(`approve ${invitation.id} --ide read`);
  assert.equal((await f.as(()=>f.facade.listSessionCatalog({},f.target.hostId),visitor)).threads[0].threadId,f.thread.threadId);
  assert.deepEqual(await f.as(()=>f.facade.getHistory(f.thread.threadId,f.target.hostId),visitor),[]);
  assert.match((await f.registry.sharingCall(f.target.hostId,"workspace.read",{...f.target,path:"hello.ts"},visitor,()=>{})).text,/answer = 42/);
});

test("a grant is rechecked after async preflight, and removing it does not start native work", async t => {
  const f=await fixture(t);await f.share("claim");const invite=await f.invite();await f.share(`approve ${invite.id}`);
  const grant=f.registry.grantsFor(visitor)[0], entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(), original=f.backend.inspectThread.bind(f.backend);
  let block=true;
  f.backend.inspectThread=async id=>{if(block){block=false;entered.resolve();await release.promise;}return original(id);};
  const pending=f.as(()=>f.facade.run(f.input()),visitor), rejected=assert.rejects(pending);
  await entered.promise;await f.share(`revoke ${grant.id}`);release.resolve();await rejected;
  assert.equal(f.runs.length,0);
});

test("the device enforces grant expiry and directory changes independently of Gateway roles", async t => {
  const f=await fixture(t);await f.share("claim --ide");const invite=await f.invite();await f.share(`approve ${invite.id} --ide write --hours 1`);
  const grant=f.registry.grantsFor(visitor)[0];let now=Date.now();
  const authority=new PeerSharingAuthority(path.join(f.root,"client","sharing.json"),f.backend,async()=>false,()=>now);
  assert.equal(authority.valid(grant),true);now=grant.delegation!.expiresAt;
  assert.equal(authority.valid(grant),false);await assert.rejects(authority.verify(grant,"run",[f.input()]));
  const elsewhere=path.join(f.root,"elsewhere");fs.mkdirSync(elsewhere);f.thread.cwd=elsewhere;
  await assert.rejects(f.as(()=>f.facade.getHistory(f.thread.threadId,f.target.hostId),visitor));
  await assert.rejects(f.registry.sharingCall(f.target.hostId,"workspace.read",{...f.target,path:"hello.ts"},visitor,()=>{}));
});

test("resource revocation suppresses callbacks and results without changing the native task", async t => {
  const f=await fixture(t);await f.share("claim");
  const invite=await f.invite();await f.share(`approve ${invite.id}`);
  const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  f.run=async input=>{input.assertCurrent?.();await input.onTurnStarted?.({threadId:f.thread.threadId,turnId:"accepted"});started.resolve();await release.promise;await input.onDelta?.("must not deliver after revocation");return{text:"must not deliver",threadId:f.thread.threadId,turnId:"accepted",raw:""};};
  const deltas:string[]=[],pending=f.as(()=>f.facade.run(f.input({clientUserMessageId:"revoke-running",onDelta:t=>{deltas.push(t);}})),visitor),rejected=assert.rejects(pending);
  await started.promise;await f.share(`revoke ${f.registry.grantsFor(visitor)[0].id}`);release.resolve();await rejected;
  assert.deepEqual(deltas,[]);assert.equal(f.runs.length,1,"revoking does not launch or replay any native task");
});

test("moving ownership requires a fresh device confirmation and invalidates all former delegations", async t => {
  const f=await fixture(t);await f.share("claim --ide");const invitation=await f.invite();await f.share(`approve ${invitation.id} --ide read`);
  const oldGrant=f.registry.grantsFor(visitor)[0],newOwner={...principal,actorId:"new-owner"},ticket=await f.reconnect();
  await f.registry.connect(ticket.code,newOwner,()=>{});
  await f.share("claim --ide",newOwner);assert.equal(f.confirmations.length,2);
  assert.equal(f.registry.grantsFor(visitor).length,0);
  await assert.rejects(f.share("invite"),/未授权/);
  await assert.rejects(f.serverConnection.request("execution.call",{grant:oldGrant,method:"getHistory",args:[f.thread.threadId]}));
});

test("read-only workspace access rejects writes, traversal, symlinks, hard links and credentials", async t => {
  const f=await fixture(t);await f.share("claim --ide");const invite=await f.invite();await f.share(`approve ${invite.id} --ide read`);
  const call=(method:string,input:object)=>f.registry.sharingCall(f.target.hostId,method,{...f.target,...input},visitor,()=>{});
  const original=await call("workspace.read",{path:"hello.ts"});assert.match(original.text,/answer = 42/);
  await assert.rejects(call("workspace.write",{path:"hello.ts",hash:original.hash,text:"bad"}));
  const outside=path.join(f.root,"private.txt");fs.writeFileSync(outside,"private");fs.symlinkSync(outside,path.join(f.workspace,"escape"));fs.linkSync(outside,path.join(f.workspace,"hard"));fs.writeFileSync(path.join(f.workspace,".env"),"SECRET=not-a-real-secret");
  for(const p of ["../private.txt","/private.txt","escape","hard",".env","a/../../private.txt"])
    await assert.rejects(call("workspace.read",{path:p}));
  assert.equal(fs.readFileSync(outside,"utf8"),"private");assert.deepEqual((await call("workspace.list",{path:""})).entries.map((e:any)=>e.name),["hello.ts"]);
});

test("workspace editing requires its own grant and compares the current file version", async t => {
  const f=await fixture(t);await f.share("claim --ide");const invite=await f.invite();await f.share(`approve ${invite.id} --ide write`);
  const call=(method:string,input:object)=>f.registry.sharingCall(f.target.hostId,method,{...f.target,...input},visitor,()=>{});
  const first=await call("workspace.read",{path:"hello.ts"});
  await call("workspace.write",{path:"hello.ts",hash:first.hash,text:"export const answer = 43;\n"});
  await assert.rejects(call("workspace.write",{path:"hello.ts",hash:first.hash,text:"stale overwrite"}));
  assert.equal(fs.readFileSync(path.join(f.workspace,"hello.ts"),"utf8"),"export const answer = 43;\n");
  await assert.rejects(f.serverConnection.request("sharing.call",{grant:f.registry.grantsFor(visitor)[0],method:"workspace.terminal",input:{...f.target}}));
});

test("sharing a session does not implicitly share the workspace", async t => {
  const f=await fixture(t);await f.share("claim");const invite=await f.invite();
  await assert.rejects(f.share(`approve ${invite.id} --ide read`), /本机确认共享目录/);
  await f.share(`approve ${invite.id}`);
  await assert.rejects(f.registry.sharingCall(f.target.hostId,"workspace.list",{...f.target,path:""},visitor,()=>{}));
});

test("file transfer remains an explicit resource grant and session management uses existing operation guards", async t => {
  const f=await fixture(t);await f.share("claim --ide");const invite=await f.invite();
  await f.share(`approve ${invite.id} --files --hours 2`);
  const grant=f.registry.grantsFor(visitor)[0];assert.ok(grant.delegation!.permissions.includes("files"));assert.deepEqual(grant.delegation!.permissions,["files"]);
  await f.as(()=>f.facade.renameThread!(f.thread.threadId,"delegated rename",f.target.hostId,()=>{},"scoped-rename"),visitor);
  assert.equal(f.thread.title,"delegated rename");
  const scope={accountId:visitor.accountId,conversationId:visitor.conversationId,threadId:f.thread.threadId};
  const lease:any=await f.as(()=>f.registry.invokeFile(f.target.hostId,"fileDownloadBegin",{threadId:f.thread.threadId,path:path.join(f.workspace,"hello.ts"),maxBytes:1024},scope),visitor);
  assert.ok(lease.id);await f.as(()=>f.registry.invokeFile(f.target.hostId,"fileClose",{id:lease.id},scope),visitor);
  await assert.rejects(f.share("invite",visitor));
});

test("a copied Web IDE URL/code, wrong chat, CSRF and revoked cookies cannot authorize workspace access", async t => {
  const f=await fixture(t);await f.share("claim --ide");const invite=await f.invite();await f.share(`approve ${invite.id} --ide read`);
  const options={host:"127.0.0.1",port:0,publicOrigin:"http://127.0.0.1:0",stateFile:path.join(f.root,"portal.json")};
  let portal=new SharedWorkspacePortal(f.registry,options);await portal.listen();options.publicOrigin=portal.address();t.after(()=>portal.close());
  const url=await f.registry.sharing.ide(visitor,f.target,()=>{}), page=await fetch(url), html=await page.text(), proof=page.headers.get("set-cookie")!.split(";")[0];
  const code=/code="(\d{6})"/.exec(html)![1], csrf=JSON.parse(/let csrf=("[^"]+")/.exec(html)![1]);
  assert.equal(html.includes(f.workspace),false);assert.match(html,/frame|共享工作区/);
  assert.match(html, /data-copy-field data-copy-purpose="reply"/);
  assert.ok(html.includes(`/share browser ${code}</textarea>`));
  assert.match(html, /data-copy-button/);
  const api=async(body:object,cookie=proof,token=csrf,origin=options.publicOrigin)=>fetch(url+"/api",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","X-Workspace-CSRF":token,Cookie:cookie,Connection:"close"},body:JSON.stringify(body)});
  assert.equal((await api({operation:"exchange"})).status,403);
  await assert.rejects(portal.approve({...visitor,conversationId:"wrong"},code));
  await portal.approve(visitor,code);
  assert.equal((await api({operation:"exchange"},"shared-proof=wrong-proof")).status,403);
  const exchanged=await api({operation:"exchange"});assert.equal(exchanged.status,200);
  const cookie=exchanged.headers.get("set-cookie")!.split(";")[0], token=(await exchanged.json()).csrf;
  assert.equal((await api({operation:"read",path:"hello.ts"},cookie,token,"http://evil.invalid")).status,403);
  assert.equal((await api({operation:"read",path:"hello.ts"},cookie,"wrong-csrf")).status,403);
  assert.equal((await api({operation:"read",path:"hello.ts"},cookie,token)).status,200);
  assert.equal((await api({operation:"write",path:"hello.ts",text:"denied",hash:"a".repeat(64)},cookie,token)).status,403);
  const duration = Number(/Max-Age=(\d+)/.exec(exchanged.headers.get("set-cookie")!)![1]);
  assert.ok(duration > 0 && duration <= 86400, "browser lease never outlives the resource grant");
  // Reload the persisted entry, proof/session primitive, and cookies at the same origin.
  options.port = Number(new URL(options.publicOrigin).port);
  await portal.close(); portal = new SharedWorkspacePortal(f.registry, options); await portal.listen();
  assert.equal((await api({operation:"read",path:"hello.ts"},cookie,token)).status,200);
  assert.equal(exchanged.headers.get("set-cookie")!.includes(token),false,"CSRF is not the cookie credential");
  await f.share(`revoke ${f.registry.grantsFor(visitor)[0].id}`);
  assert.equal((await api({operation:"read",path:"hello.ts"},cookie,token)).status,403);
});

test("a resource-only visitor uses DingTalk without global admission, cannot reach local resources, and leaves without revoking", async t => {
  const f=await fixture(t);await f.share("claim --ide");const invite=await f.invite();await f.share(`approve ${invite.id}`);
  const paths=resolveStatePaths(path.join(f.root,"bridge-state")),store=new RuntimeStateStore(paths),replies:string[]=[];
  const localList=f.facade.listSessionCatalog.bind(f.facade);
  const runner=new Proxy(f.facade,{get(target,key){if(key==="listSessionCatalog")return(input:any,host:string)=>{assert.ok(host?.startsWith("peer:"),"resource-only visitors cannot query local storage");return localList(input,host);};return Reflect.get(target,key);}});
  const bridge=new BridgeService({accountId:principal.accountId,stateStore:store,runner,peer:f.registry,config:{...defaultConfig(paths.root),allowedSenderIds:[principal.actorId],streamReplies:false},
    channel:createChannelClient("dingtalk",TEXT_CAPABILITIES,{async sendText(input){replies.push(input.text);return{messageId:crypto.randomUUID()};}})});
  t.after(()=>bridge.suspendUserInputs());
  const send=(text:string)=>bridge.handleMessage({id:crypto.randomUUID(),senderId:visitor.actorId,replyTargetId:visitor.conversationId,conversationKind:"direct",text,attachments:[],raw:{}});
  await send(`/join ${invite.code}`);assert.equal(store.getBoundSession(visitor.conversationId)?.threadId,f.thread.threadId,replies.at(-1));
  await send("/sessions all");assert.ok(replies.some(r=>r.includes("Local existing task")));
  await send("/project");assert.match(replies.at(-1)!,/不能操作 Gateway/);
  await send("/session anything --host local");assert.match(replies.at(-1)!,/不能操作 Gateway/);
  await send("继续测试");assert.equal(f.runs.length,1,replies.at(-1));
  store.setRole(visitor.conversationId,"*","viewer");
  await send("群角色限制仍生效");assert.equal(f.runs.length,1);
  await send("/leave");assert.equal(store.getBoundSession(visitor.conversationId),undefined);assert.equal(f.registry.grantsFor(visitor).length,1);
  await send("继续");assert.equal(f.runs.length,1);
});


test("shared visitors use the existing chat roles for inputs, approvals, stops and management", async t => {
  const f = await fixture(t);
  await f.share("claim");
  const invite = await f.invite();
  await f.share(`approve ${invite.id}`);
  const grant = structuredClone(f.registry.grantsFor(visitor)[0]);
  const paths = resolveStatePaths(path.join(f.root, "role-state")), store = new RuntimeStateStore(paths), replies: string[] = [];
  const bridge = new BridgeService({ accountId: principal.accountId, stateStore: store, runner: f.facade, peer: f.registry,
    config: { ...defaultConfig(paths.root), allowedSenderIds: [principal.actorId], streamReplies: false },
    channel: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText(input) {
      replies.push(input.text); return { messageId: crypto.randomUUID() };
    } }) });
  t.after(() => bridge.suspendUserInputs());
  const send = (text: string, actorId = visitor.actorId) => bridge.handleMessage({ id: crypto.randomUUID(), senderId: actorId,
    replyTargetId: visitor.conversationId, conversationKind: "direct", text, attachments: [], raw: {} });
  await send(`/join ${invite.code}`);
  await send("/role"); assert.match(replies.at(-1)!, /你的权限：participant/);
  await send(`/role ${visitor.actorId} controller`);
  assert.equal(store.roleFor(visitor.conversationId, visitor.actorId), undefined, "admission cannot self-promote");
  assert.match(replies.at(-1)!, /controller/);
  await send("/session rename denied"); await send("/stop");
  assert.equal(f.management.length, 0); assert.equal(f.stops.length, 0);
  await send("participant can chat"); assert.equal(f.runs.length, 1);

  // Set roles through the main command path, not a separate sharing role API.
  await send(`/role ${visitor.actorId} viewer`, principal.actorId);
  await send("/role"); assert.match(replies.at(-1)!, /你的权限：viewer/);
  await send("/history"); assert.doesNotMatch(replies.at(-1)!, /需要.*权限/);
  for (const text of ["viewer cannot chat", "/stop", "/session rename denied", "/approve A1"])
    await send(text);
  assert.equal(f.runs.length, 1); assert.equal(f.management.length, 0); assert.equal(f.stops.length, 0);

  await send(`/role ${visitor.actorId} participant`, principal.actorId);
  let decision: unknown;
  f.run = async input => {
    await input.onTurnStarted?.({ threadId: f.thread.threadId, turnId: "role-approval-turn" });
    const request = { kind: "command" as const, threadId: f.thread.threadId, turnId: "role-approval-turn", itemId: "role-approval", command: "pwd" };
    decision = await input.onApproval?.(request);
    await input.onApprovalResult?.(request, "confirmed");
    return { text: "approved through main roles", threadId: f.thread.threadId, turnId: "role-approval-turn", raw: "" };
  };
  const pending = send("request native approval");
  for (let i = 0; i < 100 && bridge.listApprovals().length === 0; i++) await delay(10);
  const approval = bridge.listApprovals()[0]; assert.ok(approval, "native approval reaches the existing controller");
  await send(`/approve ${approval.id}`);
  assert.equal(decision, undefined, "participant cannot decide a native approval");
  assert.equal(bridge.listApprovals().length, 1);
  await send(`/role ${visitor.actorId} controller`, principal.actorId);
  await send(`/approve ${approval.id}`); await pending;
  assert.equal(decision, "accept");
  await send("/session rename main-role-controlled");
  assert.equal(f.thread.title, "main-role-controlled");
  await send("/stop"); assert.deepEqual(f.stops, [f.thread.threadId]);
  assert.deepEqual(f.registry.grantsFor(visitor), [grant], "chat role changes never mutate the resource grant");
  await assert.rejects(f.share("invite", visitor), /未授权/, "controller still cannot re-share someone else's session");
});

test("legacy delegated grants require reapproval without losing owners or device pairings", async t => {
  const f = await fixture(t);
  await f.share("claim --ide");
  const invite = await f.invite(); await f.share(`approve ${invite.id} --ide read`);
  const current = f.registry.grantsFor(visitor)[0];
  const legacy = structuredClone(current) as any;
  delete legacy.delegation.version;
  legacy.delegation.permissions = ["read", "ide-read"];
  const serverFile = path.join(f.root, "server", "grants.json"), clientFile = path.join(f.root, "client", "sharing.json");
  for (const file of [serverFile, clientFile]) {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.grants = state.grants.map((g: any) => g.id === current.id ? legacy : g);
    fs.writeFileSync(file, JSON.stringify(state));
  }
  const reloaded = new PeerRegistry(serverFile); t.after(() => reloaded.close());
  assert.equal(reloaded.grantsFor(visitor).length, 0);
  assert.equal(reloaded.sharing.admitted(visitor), false);
  assert.equal(reloaded.grantsFor(principal).length, 1, "device pairing survives");
  assert.throws(() => reloaded.addSharedGrant(legacy), /重新批准/);
  await f.reconnect(true);
  assert.equal((await f.status()).resource.owner.actorId, principal.actorId);
  assert.equal((await f.status()).grants.length, 0, "old read grant is not displayed as usable access");
  await assert.rejects(f.serverConnection.request("execution.call", { grant: legacy, method: "getHistory", args: [f.thread.threadId] }));
  await assert.rejects(f.serverConnection.request("execution.call", { grant: current, method: "getHistory", args: [f.thread.threadId] }),
    "adding a version to an old grant cannot authorize it on the device");
  const response = await f.join(invite.code); assert.equal(response.bind, undefined);
  const request = (await f.status()).requests[0]; assert.notEqual(request.id, invite.id);
  await f.share(`approve ${request.id}`);
  assert.equal((await f.join(invite.code)).bind?.threadId, f.thread.threadId);
  assert.equal(f.registry.grantsFor(visitor).at(-1)?.delegation?.version, 2);
  assert.equal(f.confirmations.length, 1, "unchanged ownership needs no new device confirmation");
});

test("old sharing commands and capability versions cannot silently grant broader access", async t => {
  const f = await fixture(t); await f.share("claim"); const invite = await f.invite();
  for (const suffix of ["read", "chat", "control", "--manage"])
    assert.match((await f.share(`approve ${invite.id} ${suffix}`)).text, /用法/);
  assert.equal(f.registry.grantsFor(visitor).length, 0);
  assert.equal((await f.status()).requests.length, 1);
  f.registry.description(f.target.hostId).sharing = { version: 1 };
  await assert.rejects(f.share(`approve ${invite.id}`), /更新 Connector/);
  assert.deepEqual(await f.as(() => f.facade.getHistory(f.thread.threadId, f.target.hostId)), [],
    "ordinary paired device operations remain compatible");
});
