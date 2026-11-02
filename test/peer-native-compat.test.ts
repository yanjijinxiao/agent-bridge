import assert from "node:assert/strict";
import test from "node:test";
import { CodexBackendCapabilityError, CodexRunAdmissionError } from "../src/codex/backend.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import type { CodexPublicActivity } from "../src/codex/public-item.js";
import { withPeerBackend } from "../src/peer/backend.js";
import { PeerError } from "../src/peer/rpc.js";
import { peerFixture, principal } from "./peer-fixture.js";
import path from "node:path";
import { AccountManager } from "../src/server/account-manager.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

test("Gateway restart retains a persisted peer follow binding before device registration", async t => {
  const f = await peerFixture(t); await f.bind();
  const store = new RuntimeStateStore(resolveStatePaths(path.join(f.root, "account-state")));
  const session = store.createSession(principal.conversationId, f.thread.cwd!, "Persisted device task", undefined, "session", undefined,
    { standalone: true, hostId: f.ticket.hostId });
  store.setSessionThread(session.id, f.thread.threadId);
  const offline = withPeerBackend(f.backend, new PeerRegistry(path.join(f.root, "server", "grants.json")));
  const context = { entries: new Map([[principal.accountId, { status: "running", store, client: {} }]]),
    runner: offline, configProvider: () => ({ codexBackend: "app-server", streamReplies: false }), isSessionResponding: () => false };
  const subscriptions = Reflect.apply((AccountManager.prototype as any).threadSubscriptions, context, []);
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].enabled, true);
  assert.equal(subscriptions[0].hostId, f.ticket.hostId);
  assert.equal(subscriptions[0].threadId, f.thread.threadId);
  await assert.rejects(f.as(() => offline.run(f.input())), e => e instanceof CodexCommunicationError && e.submission === "not-submitted");
  assert.equal(f.runs.length, 0);
});

for (const reason of ["active", "handoff"] as const) test(`native ${reason} admission remains not submitted across peer RPC`, async t => {
  const f = await peerFixture(t); await f.bind();
  f.run = async () => { throw new CodexRunAdmissionError(reason, f.thread.threadId); };
  await assert.rejects(f.as(() => f.facade.run(f.input())), e => e instanceof CodexRunAdmissionError
    && e.reason === reason && e.threadId === f.thread.threadId && e.submission === "not-submitted");
  f.run = async input => {
    await input.onTurnStarted?.({ threadId: f.thread.threadId, turnId: "retry" });
    return { text: "retried safely", threadId: f.thread.threadId, turnId: "retry", raw: "" };
  };
  assert.equal((await f.as(() => f.facade.run(f.input()))).text, "retried safely");
  assert.equal(f.runs.length, 2);
});

test("an accepted peer receipt cannot be downgraded by a later admission error", async t => {
  const f = await peerFixture(t); await f.bind();
  f.run = async input => {
    await input.onTurnStarted?.({ threadId: f.thread.threadId, turnId: "accepted" });
    throw new CodexRunAdmissionError("active", f.thread.threadId);
  };
  for (let n = 0; n < 2; n++) await assert.rejects(f.as(() => f.facade.run(f.input())), e => e instanceof CodexCommunicationError
    && e.submission === "accepted" && e.turnId === "accepted");
  assert.equal(f.runs.length, 1);
});

test("unmapped native ports never fall through to the Gateway core for a peer host", async t => {
  const f = await peerFixture(t); await f.bind();
  const methods = new Set(["interruptTurn", "listSkills", "listMcpServers", "observeThreadInteractions",
    "unobserveThreadInteractions", "interactionSubscriptionReady", "serverIdentity"]);
  let localCalls = 0;
  const local = new Proxy(f.backend, { get(target, key) {
    if (methods.has(String(key))) return () => { localCalls++; throw Error("Gateway core must not be used"); };
    return Reflect.get(target, key);
  } });
  const facade = withPeerBackend(local, f.registry), host = f.ticket.hostId, id = f.thread.threadId;
  const unsupported = (e: unknown) => e instanceof PeerError && e.code === "unsupported" || e instanceof CodexBackendCapabilityError;
  const attempts = [
    () => facade.interruptTurn!(id, "turn", host),
    () => facade.listSkills!(f.thread.cwd!, host),
    () => facade.listMcpServers!(id, host),
    () => facade.observeThreadInteractions!(id, host, {} as never),
    () => facade.serverIdentity!(host)
  ];
  for (const attempt of attempts) await assert.rejects(f.as(attempt), unsupported);
  assert.equal(facade.interactionSubscriptionReady!(id, host), false);
  await facade.unobserveThreadInteractions!(id, host);
  assert.equal(facade.backendInfo(host).capabilities.skills, false);
  assert.equal(facade.backendInfo(host).capabilities.mcpServers, false);
  assert.equal(localCalls, 0);
  // Ordinary local/SSH calls retain the complete new native port signatures.
  let args: unknown[] = [];
  local.listMcpServers = async (...input: unknown[]) => { args = input; return []; };
  const untrapped = withPeerBackend(f.backend, f.registry);
  await untrapped.listMcpServers!("local-thread", "ssh-host");
  assert.deepEqual(args, ["local-thread", "ssh-host"]);
});

test("model-specific native limits reach the device without a Gateway host identity", async t => {
  const f = await peerFixture(t); await f.bind(); const calls: unknown[][] = [];
  f.backend.getAccountRateLimits = async (...args: unknown[]) => { calls.push(args); return { planType: "device-plan" }; };
  await f.as(() => f.facade.getAccountRateLimits(f.ticket.hostId, "deepseek-v4.1-flash-1017"));
  await f.as(() => f.facade.getAccountRateLimits(f.ticket.hostId));
  assert.deepEqual(calls, [[undefined, "deepseek-v4.1-flash-1017"], [undefined, undefined]]);
});

test("native project roots and public item callbacks survive peer execution", async t => {
  const f = await peerFixture(t); await f.bind(); const seen: CodexPublicActivity[] = [];
  const item: CodexPublicActivity = { type: "file_change", role: "activity", content: "example.ts", data: { files: ["example.ts"] } };
  f.run = async input => {
    assert.deepEqual(input.projectRoots, [f.thread.cwd]);
    await input.onTurnStarted?.({ threadId: f.thread.threadId, turnId: "native-turn" });
    await input.onItem?.(item);
    return { text: "ok", threadId: f.thread.threadId, turnId: "native-turn", raw: "" };
  };
  await f.as(() => f.facade.run(f.input({ projectRoots: [f.thread.cwd!], onItem: item => { seen.push(item); } })));
  assert.deepEqual(seen, [item]);
  for (const extra of [{ imagePaths: ["/gateway/image.png"] }, { nativeSettings: {
    sandbox: "danger-full-access" as const, approvalPolicy: "never" as const,
    approvalsReviewer: "user" as const, runtimeWorkspaceRoots: ["/gateway"]
  } }]) await assert.rejects(f.as(() => f.facade.run(f.input(extra))), /Connector 尚未开放/);
  assert.equal(f.runs.length, 1);
});

test("native activity reads use the selected device thread and the exact chat grant", async t => {
  const f = await peerFixture(t); await f.bind(); let reads = 0;
  const item: CodexPublicActivity = { type: "agent_message", role: "assistant", content: "device-only", data: {} };
  f.backend.readTurnActivities = async (id, turn, host) => {
    reads++; assert.equal(id, f.thread.threadId); assert.equal(turn, "turn"); assert.equal(host, undefined); return [item];
  };
  const facade = withPeerBackend(new Proxy(f.backend, { get(target, key) {
    if (key === "readTurnActivities") return () => { throw Error("Gateway-local activity query"); };
    return Reflect.get(target, key);
  } }), f.registry);
  assert.deepEqual(await f.as(() => facade.readTurnActivities!(f.thread.threadId, "turn", f.ticket.hostId)), [item]);
  await assert.rejects(f.as(() => facade.readTurnActivities!("other-thread", "turn", f.ticket.hostId)), /selected thread/);
  await assert.rejects(f.as(() => facade.readTurnActivities!(f.thread.threadId, "turn", f.ticket.hostId), { ...principal, actorId: "other" }), /未获准/);
  assert.equal(reads, 1);
});

test("unified App Server facade exposes empty thread lifecycle and preserves live write guards", async t => {
  const f = await peerFixture(t); const calls: string[] = [];
  const native = new Proxy(f.backend, { get(target, key) {
    if (key === "id") return "app-server";
    if (key === "capabilities") return f.backend.backendInfo().capabilities;
    if (key === "renameThread") return async (id: string, title: string, guard: () => void) => {
      await Promise.resolve(); guard(); calls.push("rename"); return { ...f.thread, title };
    };
    if (key === "archiveThread") return async (_id: string, guard: () => void) => {
      await Promise.resolve(); guard(); calls.push("archive");
    };
    return Reflect.get(target, key);
  } });
  const gateway = new CodexAppServerGateway({ appServerBackend: native as never, appServerTransport: "stdio" });
  t.after(() => gateway.close());
  const created = await gateway.createThread({ cwd: f.thread.cwd, projectBinding: "none" });
  assert.equal(created.persistence, "active"); assert.equal(f.runs.length, 0);
  for (const method of ["rename", "archive"] as const) {
    let current = true;
    const guard = () => { if (!current) throw Error("binding changed"); };
    const work = method === "rename" ? gateway.renameThread(created.threadId, "new title", undefined, guard)
      : gateway.archiveThread(created.threadId, undefined, guard);
    current = false; await assert.rejects(work, /binding changed/);
  }
  assert.deepEqual(calls, []);
});
