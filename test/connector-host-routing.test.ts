import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { peerFixture, principal } from "./peer-fixture.js";
import { peerNativeHost } from "../src/peer/registry.js";
import { ConnectorSelection } from "../src/bridge/connector-selection.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { hostScopedBackend } from "../src/codex/host-scoped-backend.js";
import type { CodexBridgeBackend } from "../src/codex/backend.js";
import { validateManagedRoutes } from "../src/peer/managed-route.js";

const remote = "remote-ssh-discovered:registered-host";
for (const managed of [true, false]) test(`one Connector keeps native host identity through catalogs, history, execution and reconnect (${managed ? "managed" : "personal"})`, async t => {
  const f = await peerFixture(t, { device: true, nativeHost: remote, managedHost: managed ? "local" : undefined });
  if (!managed) await f.bind();
  const root = f.ticket.hostId, target = managed ? remote : peerNativeHost(root, remote);
  const seen: Array<[string, string | undefined]> = [];
  f.backend.listProjects = async host => ({ backend: "app-server", projects: [{ id: "same-project", name: "same-name", roots: [host === remote ? "/remote-only/project" : f.root] }] });
  f.backend.inspectThread = async (id, host) => ({ ...f.thread, threadId: id, cwd: host === remote ? "/remote-only/project" : f.root });
  f.backend.getHistory = async (id, host) => { seen.push(["history", host]); return [{ id: "history", role: "assistant", text: host ?? "local" }]; };
  f.backend.listSessionCatalog = async (_, host) => ({ backend: "app-server", source: "app-server-storage", threads: [await f.backend.inspectThread("same-thread", host)], hostIds: [], complete: true, warnings: [] });
  f.run = async input => { seen.push(["run", input.hostId]); input.assertCurrent?.(); await input.onTurnStarted?.({ threadId: input.threadId!, turnId: "remote-turn" }); return { threadId: input.threadId!, turnId: "remote-turn", text: "done", raw: "" }; };
  await f.as(async () => {
    const local = await f.facade.listSessionCatalog({}, root), other = await f.facade.listSessionCatalog({}, target);
    assert.equal(local.threads[0].threadId, other.threads[0].threadId);
    assert.equal(local.threads[0].cwd, f.root); assert.equal(other.threads[0].cwd, "/remote-only/project");
    assert.deepEqual(new Set(local.hostIds), new Set([root, target]));
    const catalog = await f.facade.listProjects(target); assert.equal(catalog.projects[0].available, undefined); assert.deepEqual(catalog.projects[0].roots, ["/remote-only/project"]);
    assert.equal((await f.facade.getHistory("same-thread", target))[0].text, remote);
    await f.facade.run(f.input({ hostId: target, threadId: "same-thread", cwd: "/remote-only/project" }));
  });
  assert.deepEqual(seen, [["history", remote], ["run", remote]]);
  const selection = new ConnectorSelection(new RuntimeStateStore(resolveStatePaths(path.join(f.root, "selection"))), f.registry, () => true);
  assert.deepEqual(selection.list(principal).hosts, [root]);
  assert.equal(selection.resolve(principal), root);
  assert.deepEqual(new Set(f.registry.catalogHosts(root)), new Set([root, target]));
  if (!managed) await assert.rejects(f.as(() => f.facade.inspectThread("same-thread", target), { ...principal, actorId: "other" }), /未获准/);
  if (managed) await assert.rejects(f.as(() => f.facade.inspectThread("same-thread", peerNativeHost("peer:laptop:work", remote))), /未获准/);
  await assert.rejects(f.serverConnection.channel("unregistered").request("execution.call", {}), /unavailable/);
  await f.reconnect();
  await f.as(() => f.facade.getHistory("same-thread", target));
  assert.equal(f.runs.length, 1); assert.deepEqual(f.stops, []);
});

test("all native facade shapes preserve a bound host and original guard/callback objects", async () => {
  const calls: [string, unknown[]][] = [];
  const base = new Proxy({}, { get: (_, key) => (...args: unknown[]) => { calls.push([String(key), args]); return Promise.resolve(); } }) as CodexBridgeBackend;
  const b = hostScopedBackend(base, remote), guard = () => {}, observer = { onApproval: async () => "accept" };
  await b.inspectThread("t", "wrong", { includeTurns: false, timeoutMs: 1 });
  await b.getRuntimeInfo("/remote", "t", "wrong", { timeoutMs: 1 });
  await b.run({ hostId: "wrong", cwd: "/remote", prompt: "x", assertCurrent: guard });
  await b.deleteQueuedSubmission!("t", "q", "wrong", guard);
  await b.observeThreadInteractions!("t", "wrong", observer as never, "consumer");
  await b.stageAttachments!([], { hostId: "wrong", scope: "s", maxBytes: 10 });
  await b.fetchOutputFile!("/remote/f", { hostId: "wrong", maxBytes: 10 });
  assert.equal(calls[0][1][1], remote); assert.equal(calls[1][1][2], remote);
  assert.equal((calls[2][1][0] as any).hostId, remote); assert.equal((calls[2][1][0] as any).assertCurrent, guard);
  assert.equal(calls[3][1][2], remote); assert.equal(calls[3][1][3], guard);
  assert.equal(calls[4][1][1], remote); assert.equal(calls[4][1][2], observer);
  assert.equal((calls[5][1][1] as any).hostId, remote); assert.equal((calls[6][1][1] as any).hostId, remote);
});

test("managed aliases may share a physical connection but never the same native target", () => {
  const local = { hostId: "local", nodeId: "mac", profileId: "desktop", grantId: crypto.randomUUID() };
  const other = { ...local, hostId: remote, nativeHostId: remote, grantId: crypto.randomUUID() };
  assert.doesNotThrow(() => validateManagedRoutes([local, other]));
  assert.throws(() => validateManagedRoutes([local, other, { ...other, hostId: "another-alias" }]), /unique/);
});

test("personal remote attachments use native file ports and retain workspace plus uploaded-file scope", async t => {
  const f = await peerFixture(t, { device: true, nativeHost: remote }); await f.bind();
  const hostId = peerNativeHost(f.ticket.hostId, remote), data = Buffer.from("remote bytes"), calls: unknown[] = [];
  const inbound = path.join(f.root, "inbound.txt"); fs.writeFileSync(inbound, data);
  f.backend.stageAttachments = async (files, options) => { calls.push(options); assert.equal(options.hostId, remote); return files; };
  f.backend.fetchOutputFile = async (file, options) => {
    calls.push(options); assert.equal(options.hostId, remote);
    assert.deepEqual(options.allowedRoots, [f.thread.cwd, path.dirname(file)]);
    const local = path.join(f.root, "downloaded.txt"); fs.copyFileSync(file, local);
    return { path: local, dispose: async () => { fs.rmSync(local, { force: true }); } };
  };
  const scope = { hostId, ...principal, threadId: f.thread.threadId, maxBytes: 1024 };
  await f.as(async () => {
    const [file] = await f.facade.stageAttachments!([{ path: inbound, label: "inbound.txt", kind: "file" }], { ...scope, scope: "source" });
    const copy = await f.facade.fetchOutputFile!(file.path, scope); assert.deepEqual(fs.readFileSync(copy.path), data); await copy.dispose();
  });
  assert.equal(calls.length, 2); assert.equal(f.runs.length, 0);
});
