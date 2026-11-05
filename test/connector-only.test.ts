import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { peerFixture, principal } from "./peer-fixture.js";
import { connectorOnlyBackend } from "../src/peer/backend.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { managedGrant, matchesManagedGrant, validateManagedRoutes } from "../src/peer/managed-route.js";
import { ConnectorSelection } from "../src/bridge/connector-selection.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { ConnectorIDEHostTransport } from "../src/peer/ide-transport.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";
import type { CodexHistoryMessage } from "../src/codex/backend.js";

test("connector-only refuses unconfigured hosts without creating or falling back to a native core", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connector-only-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new PeerRegistry(path.join(root, "grants.json")), b = connectorOnlyBackend(registry);
  for (const host of [undefined, "local", "remote-ssh-discovered:example.invalid"]) {
    await assert.rejects(async () => b.inspectThread("existing", host), CodexCommunicationError);
    await assert.rejects(async () => b.listProjects(host), CodexCommunicationError);
    await assert.rejects(async () => b.run({ hostId: host, cwd: root, prompt: "must not run" }), CodexCommunicationError);
  }
  assert.equal(b.hasInFlightWork!(), false); await b.close();
});

for (const hostId of ["local", "remote-ssh-discovered:old-machine"]) {
  test(`managed ${hostId} preserves logical binding identity, real source and complete native interface`, async t => {
    const f = await peerFixture(t, { managedHost: hostId, device: true });
    assert.equal(f.ticket.hostId, hostId); assert.equal(f.registry.isRouted(hostId), true);
    assert.equal(f.registry.isPeer(hostId), false); assert.deepEqual(f.registry.hosts(principal), []);
    await f.as(async () => {
      assert.equal((await f.facade.inspectThread(f.thread.threadId, hostId)).threadId, f.thread.threadId);
      const result = await f.facade.run(f.input()); assert.equal(result.turnId, "native-turn");
    });
    assert.equal(f.runs.length, 1); assert.match(f.runs[0].clientUserMessageId!, /^peer-/);
    assert.deepEqual(f.stops, []);
  });
}

test("managed deployment authorization cannot be borrowed through the physical peer ID or personal pairing", async t => {
  const f = await peerFixture(t, { managedHost: "local", device: true });
  await assert.rejects(f.as(() => f.facade.inspectThread(f.thread.threadId, "peer:laptop:work")), /未获准/);
  assert.equal(await f.serverConnection.request("binding.approve", managedGrant(f.managed!, principal)), false);
  const valid = managedGrant(f.managed!, principal);
  assert.equal(matchesManagedGrant(f.managed, valid), true);
  for (const bad of [{ ...valid, id: crypto.randomUUID() }, { ...valid, hostId: "another" }, { ...valid, scope: undefined, threadId: f.thread.threadId }])
    await assert.rejects(f.serverConnection.request("execution.call", { grant: bad, method: "inspectThread", args: [f.thread.threadId] }), /not approved/);
});

test("managed input rechecks the live Gateway guard and never submits after revocation", async t => {
  const f = await peerFixture(t, { managedHost: "local", device: true });
  await assert.rejects(f.as(() => f.facade.run(f.input({ assertCurrent() { throw Error("revoked"); } }))), CodexCommunicationError);
  assert.equal(f.runs.length, 0);
});

test("Gateway reconnection leaves the existing native input alone and recovers old and new source IDs", async t => {
  const f = await peerFixture(t, { managedHost: "local", device: true });
  const messages: CodexHistoryMessage[] = [{ id: "old", role: "user", text: "old", clientUserMessageId: "before-migration", turnId: "old-turn" }];
  f.backend.getHistoryPage = async () => ({ messages });
  f.run = async input => { messages.push({ id: "new", role: "user", text: "new", clientUserMessageId: input.clientUserMessageId, turnId: "new-turn" });
    await input.onTurnStarted?.({ threadId: f.thread.threadId, turnId: "new-turn" }); return { threadId: f.thread.threadId, turnId: "new-turn", text: "done", raw: "" }; };
  await f.as(() => f.facade.run(f.input({ clientUserMessageId: "after-migration" })));
  await f.reconnect(true);
  const recovered = connectorOnlyBackend(f.registry); t.after(() => recovered.close());
  const result = await recovered.findNativeInputReceipts!({ hostId: "local", threadId: f.thread.threadId },
    ["before-migration", "after-migration"].map(clientUserMessageId => ({ ...principal, clientUserMessageId })));
  assert.deepEqual([...result], [["before-migration", "old-turn"], ["after-migration", "new-turn"]]);
  assert.equal(f.runs.length, 1); assert.deepEqual(f.stops, []);
});

test("legacy unknown input without actor metadata is only read on its explicitly migrated host", async t => {
  const f = await peerFixture(t, { managedHost: "local", device: true });
  f.backend.getHistoryPage = async () => ({ messages: [{ id: "old", role: "user", text: "old", clientUserMessageId: "legacy", turnId: "old-turn" }] });
  assert.equal((await f.facade.findNativeInputReceipts!({ hostId: "local", threadId: f.thread.threadId }, [{ accountId: "legacy-account", clientUserMessageId: "legacy" }])).get("legacy"), "old-turn");
  assert.equal(f.runs.length, 0);
});

test("accepted legacy queue and new Connector queue preserve distinct native source identities", async t => {
  const f = await peerFixture(t, { managedHost: "local", device: true }), seen: string[] = [];
  f.backend.addQueuedSubmission = async input => { await input.assertCurrent?.(); seen.push(input.clientUserMessageId); return { id: "new-queue", threadId: f.thread.threadId, clientUserMessageId: input.clientUserMessageId, prompt: "stored", createdAt: "now" }; };
  f.backend.runQueuedSubmission = async input => { seen.push(input.clientUserMessageId); return { threadId: f.thread.threadId, turnId: "queued-turn", text: "done", raw: "" }; };
  await f.as(async () => {
    await f.facade.runQueuedSubmission!({ ...f.input(), clientUserMessageId: "old-queue-source", queuedSubmissionId: "old-queue", threadId: f.thread.threadId });
    await f.facade.addQueuedSubmission!({ threadId: f.thread.threadId, clientUserMessageId: "new-queue-source", prompt: "stored", assertCurrent() {} }, "local");
    await f.facade.runQueuedSubmission!({ ...f.input(), clientUserMessageId: "new-queue-source", queuedSubmissionId: "new-queue", threadId: f.thread.threadId });
  });
  assert.equal(seen[0], "old-queue-source"); assert.match(seen[1], /^peer-/); assert.equal(seen[2], seen[1]);
});

test("managed Connector selection retains old hosts across restart and revocation hides them", async t => {
  const f = await peerFixture(t, { managedHost: "remote-ssh-discovered:old-machine", device: true });
  const paths = resolveStatePaths(path.join(f.root, "selection")), store = new RuntimeStateStore(paths);
  let admitted = true;
  const selection = new ConnectorSelection(store, f.registry, () => admitted);
  selection.list(principal); selection.select(principal, "C1");
  const restarted = new ConnectorSelection(new RuntimeStateStore(paths), f.registry, () => admitted);
  assert.equal(restarted.resolve(principal), f.ticket.hostId);
  admitted = false; assert.deepEqual(restarted.list(principal).hosts, []); assert.throws(() => restarted.resolve(principal), /准入已失效/);
});

test("managed route rejects duplicate hosts or shared physical targets", () => {
  const route = { hostId: "local", grantId: crypto.randomUUID(), nodeId: "node", profileId: "profile" };
  assert.throws(() => validateManagedRoutes([route, { ...route, nodeId: "another" }]), /unique/);
  assert.throws(() => validateManagedRoutes([route, { ...route, hostId: "remote-ssh-discovered:old" }]), /unique/);
});

test("IDE uses Connector for legacy local host and refuses anonymous or unmapped targets", async t => {
  const f = await peerFixture(t, { managedHost: "local", device: true, webIDE: { enabled: true, binary: "code-server", autoInstall: false } });
  const transport = new ConnectorIDEHostTransport(f.registry), context = { accountId: principal.accountId, threadId: f.thread.threadId, workspace: f.thread.cwd! };
  assert.equal(transport.ownsInstallation("local"), true); assert.equal(transport.canAccess("local", context), false);
  const subject = { principal: { channel: "dingtalk" as const, ...principal }, basis: "im-personal" as const, epoch: 0 };
  assert.equal(transport.canAccess("local", { ...context, subject }), true);
  assert.equal(transport.canAccess("unmapped", { ...context, subject }), false);
  await assert.rejects(transport.canonicalDirectory("unmapped", context.workspace, { ...context, subject }), /未使用本机或 SSH/);
});

test("managed project catalog retains missing secondary roots and empty projects", async t => {
  const f = await peerFixture(t, { managedHost: "local", device: true });
  const roots = [f.root, path.join(f.root, "unmounted-root")];
  f.projects.push({ id: "empty-project", name: "retained", roots });
  const catalog = await f.facade.listProjects("local");
  assert.deepEqual(catalog.projects, [{ id: "empty-project", name: "retained", roots: [fs.realpathSync(f.root), roots[1]], available: false }]);
});

test("ephemeral inference uses the explicit Connector without submitting to local", async t => {
  const f = await peerFixture(t, { managedHost: "remote-ssh-discovered:existing", device: true });
  f.run = async input => { await input.onThreadCreated?.("temporary-thread"); await input.onTurnStarted?.({ threadId: "temporary-thread", turnId: "temporary-turn" }); return { threadId: "temporary-thread", turnId: "temporary-turn", text: "{}", raw: "" }; };
  await f.facade.runEphemeral({ hostId: f.ticket.hostId, cwd: f.root, prompt: "classify", outputSchema: { type: "object" } });
  assert.equal(f.runs.length, 1); assert.equal(f.runs[0].ephemeral, true); assert.equal(f.runs[0].sandbox, "read-only");
  await assert.rejects(async () => f.facade.runEphemeral({ cwd: f.root, prompt: "no default host" }), CodexCommunicationError);
  assert.equal(f.runs.length, 1);
});

test("managed registration rejects another node, another profile and enrollment before replacing a connection", async t => {
  const f = await peerFixture(t, { managedHost: "local", device: true });
  for (const [node, profile, enrollment] of [["stranger", "work", false], ["laptop", "another", false], ["laptop", "work", true]] as const) {
    const handlers = new Map<string, (params: unknown) => unknown>();
    const connection = { handle(name: string, fn: (params: unknown) => unknown) { handlers.set(name, fn); }, onClose() {} };
    f.registry.accept(node, connection as never, enrollment ? {} as never : undefined);
    assert.throws(() => handlers.get("peer.register")!({ ...f.registry.description("local"), profileId: profile }), /deployment route/);
    assert.equal(f.registry.isOnline("local"), true);
  }
});

test("profile observation is delivered by Connector and can detach/reconnect without stopping Codex", async t => {
  const { ConnectorSessionMonitor } = await import("../src/peer/session-monitor.js");
  const f = await peerFixture(t, { managedHost: "local", device: true });
  const sessions = path.join(f.root, "codex-home", "sessions"); fs.mkdirSync(sessions, { recursive: true });
  const timestamp = new Date().toISOString(), tasks: string[] = [];
  fs.writeFileSync(path.join(sessions, "native.jsonl"), [
    { timestamp, type: "session_meta", payload: { id: "external", cwd: f.root, source: "cli" } },
    { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "existing-turn" } }
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const monitor = new ConnectorSessionMonitor(f.registry, { onCompletion() {}, onTaskChanged(event) { tasks.push(event.turnId); } });
  t.after(() => monitor.stop()); monitor.start(); await monitor.ready();
  assert.ok(tasks.includes("existing-turn"));
  await monitor.stop(); monitor.start(); await monitor.ready(); await monitor.stop();
  assert.equal(f.runs.length, 0); assert.deepEqual(f.stops, []);
});
