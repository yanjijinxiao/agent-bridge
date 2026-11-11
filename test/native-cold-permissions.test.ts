import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sharedNativeCore, until } from "./fixtures/shared-native-core.mjs";

const enabled = Boolean(process.env.CODEX_NATIVE_QUEUE_TEST_BIN);
const options = { skip: !enabled, timeout: 60_000 };
async function prepared(t: any, excludeTemporary = true) {
  const f = await sharedNativeCore(t), desktop = await f.rpc("cold_permission_owner");
  fs.mkdirSync(path.join(f.root, ".git"));
  const { thread } = await desktop.request("thread/start", { cwd: f.root, sandbox: "workspace-write",
    approvalPolicy: "on-request", runtimeWorkspaceRoots: [f.root], ephemeral: false });
  await desktop.request("thread/name/set", { threadId: thread.id, name: "Cold native permission regression" });
  const policy = { type: "workspaceWrite", writableRoots: [path.join(f.root, ".git")], networkAccess: true,
    excludeTmpdirEnvVar: excludeTemporary, excludeSlashTmp: excludeTemporary };
  await desktop.request("thread/settings/update", { threadId: thread.id, sandboxPolicy: policy, approvalPolicy: "on-request", approvalsReviewer: "user" });
  await until(() => desktop.events.some((e: any) => e.method === "thread/settings/updated" && e.params.threadSettings.sandboxPolicy.networkAccess));
  const before = await desktop.request("thread/resume", { threadId: thread.id, excludeTurns: true });
  const pid = (await desktop.request("server/diagnostics")).process.id;
  return { f, desktop, id: thread.id, before, pid };
}

for (const remote of [false, true]) for (const operation of ["interaction", "model", "turn"]) {
  test(`NATIVE-02.8: real core restart retains permissions through ${operation} (remote=${remote})`, options, async t => {
    const { f, id, before, pid } = await prepared(t);
    await f.restart();
    const reader = await f.rpc("cold_verify");
    assert.notEqual((await reader.request("server/diagnostics")).process.id, pid);
    assert.equal((await reader.request("thread/read", { threadId: id, includeTurns: false })).thread.status.type, "notLoaded");
    const runner = f.runner(remote ? { transport: f.transport("remote-daemon") } : {});
    const writes: string[] = [], reads: string[] = [], request = (runner as any).request.bind(runner);
    (runner as any).request = (method: string, params: any, ...args: any[]) => {
      (method === "fs/readFile" ? reads : writes).push(method); return request(method, params, ...args);
    };
    if (operation === "interaction") await runner.observeThreadInteractions(id, { approval: async () => {} } as any);
    if (operation === "model") await runner.updateThreadSettings(id, { model: "mock-model-later", effort: "low" });
    if (operation === "turn") await runner.run({ threadId: id, cwd: f.root, prompt: "One explicit input", clientUserMessageId: "cold-input" });
    const after = await reader.request("thread/resume", { threadId: id, excludeTurns: true });
    assert.deepEqual(after.sandbox, before.sandbox);
    assert.deepEqual(after.runtimeWorkspaceRoots, before.runtimeWorkspaceRoots);
    assert.equal(after.approvalPolicy, before.approvalPolicy);
    assert.equal(after.approvalsReviewer, before.approvalsReviewer);
    assert.deepEqual(reads, ["fs/readFile"], "cold source is fetched from the same native server even for a remote route");
    assert.equal(f.calls.length, operation === "turn" ? 1 : 0, "restoring permissions never creates an input or model request");
    assert.equal(writes.filter(x => x === "turn/start").length, operation === "turn" ? 1 : 0);
    assert.equal(writes.filter(x => x === "thread/settings/update").length, operation === "model" ? 1 : 0);
    if (operation === "model") { assert.equal(after.model, "mock-model-later"); assert.equal(after.reasoningEffort, "low"); }
  });
}

test("NATIVE-02.8: real later tightening survives cold restore and does not revive a wider earlier grant", options, async t => {
  const { f, desktop, id } = await prepared(t);
  await desktop.request("thread/settings/update", { threadId: id, sandboxPolicy: { type: "readOnly", networkAccess: false } });
  await until(() => desktop.events.some((e: any) => e.method === "thread/settings/updated" && e.params.threadSettings.sandboxPolicy.type === "readOnly"));
  const before = await desktop.request("thread/resume", { threadId: id, excludeTurns: true });
  await f.restart();
  await f.runner().observeThreadInteractions(id, {} as any);
  const reader = await f.rpc("tightened");
  const after = await reader.request("thread/resume", { threadId: id, excludeTurns: true });
  assert.deepEqual(after.sandbox, before.sandbox);
  assert.equal(after.approvalPolicy, before.approvalPolicy);
  assert.equal(f.calls.length, 0);
});

test("NATIVE-02.8: real cold restore retains permitted native temporary directories", options, async t => {
  const { f, id, before } = await prepared(t, false); await f.restart();
  await f.runner().observeThreadInteractions(id, {} as any);
  const reader = await f.rpc("temporary_roots_verify");
  const after = await reader.request("thread/resume", { threadId: id, excludeTurns: true });
  assert.deepEqual(after.sandbox, before.sandbox);
  assert.equal(after.sandbox.excludeTmpdirEnvVar, false);
  assert.equal(after.sandbox.excludeSlashTmp, false);
  assert.equal(f.calls.length, 0);
});

test("NATIVE-02.8: racing native owner tightening wins over a cold reader's earlier snapshot", options, async t => {
  const { f, id } = await prepared(t); await f.restart();
  const desktop = await f.rpc("racing_owner"), runner = f.runner();
  const request = (runner as any).request.bind(runner);
  (runner as any).request = async (method: string, params: any, ...args: any[]) => {
    const result = await request(method, params, ...args);
    if (method === "fs/readFile") {
      await desktop.request("thread/resume", { threadId: id, excludeTurns: true });
      await desktop.request("thread/settings/update", { threadId: id, sandboxPolicy: { type: "readOnly", networkAccess: false } });
      await until(() => desktop.events.some((e: any) => e.method === "thread/settings/updated" && e.params.threadSettings.sandboxPolicy.type === "readOnly"));
    }
    return result;
  };
  await runner.observeThreadInteractions(id, {} as any);
  const after = await desktop.request("thread/resume", { threadId: id, excludeTurns: true });
  assert.equal(after.sandbox.type, "readOnly");
  assert.equal(after.sandbox.networkAccess, false);
  assert.equal(f.calls.length, 0);
});

test("NATIVE-02.8: real cold restore reselects a named native profile without losing deny or domain configuration", options, async t => {
  const f = await sharedNativeCore(t);
  const configPath = path.join(f.root, "config.toml");
  const denied = path.join(f.root, "secret.txt"); fs.writeFileSync(denied, "isolated fixture");
  fs.writeFileSync(configPath, 'default_permissions=":read-only"\n' + fs.readFileSync(configPath, "utf8"));
  fs.appendFileSync(path.join(f.root, "config.toml"), ["", "[permissions.cold-profile.filesystem]", '":root"="read"',
    `${JSON.stringify(f.root)}="write"`, `${JSON.stringify(denied)}="deny"`,
    "[permissions.cold-profile.network]", "enabled=true", "[permissions.cold-profile.network.domains]", '"example.com"="allow"', ""].join("\n"));
  await f.restart();
  const desktop = await f.rpc("named_profile_owner");
  const { thread } = await desktop.request("thread/start", { cwd: f.root, permissions: "cold-profile", ephemeral: false });
  await desktop.request("thread/name/set", { threadId: thread.id, name: "Named profile cold regression" });
  await desktop.request("thread/settings/update", { threadId: thread.id, effort: "low" });
  await until(() => desktop.events.some((e: any) => e.method === "thread/settings/updated" && e.params.threadSettings.effort === "low"));
  await f.restart();
  await f.runner().observeThreadInteractions(thread.id, {} as any);
  const reader = await f.rpc("named_profile_verify");
  const after = await reader.request("thread/resume", { threadId: thread.id, excludeTurns: true });
  assert.equal(after.activePermissionProfile.id, "cold-profile");
  const config = await reader.request("config/read", { cwd: f.root, includeLayers: false });
  assert.equal(config.config.permissions["cold-profile"].filesystem[denied], "deny");
  assert.equal(config.config.permissions["cold-profile"].network.domains["example.com"], "allow");
  assert.equal(f.calls.length, 0);
});
