import assert from "node:assert/strict";
import test from "node:test";
import { nativePermissionResume } from "../src/codex/native-permission-resume.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

const id = "native-thread", cwd = "/workspace";
const special = (kind: string, access: string) => ({ path: { type: "special", value: { kind } }, access });
const file = (p: string, access = "write", extra = {}) => ({ path: { type: "path", path: p }, access, ...extra });
const settings = (network = true, roots = [cwd, cwd + "/.git"]) => ({
  cwd, runtime_workspace_roots: [cwd], approval_policy: "on-request", approvals_reviewer: "auto_review",
  model: "do-not-replay", collaboration_mode: { mode: "plan" },
  permission_profile: { type: "managed", network: network ? "enabled" : "restricted", file_system: { type: "restricted", entries: [
    special("root", "read"), ...roots.map(p => file(p)), file(cwd + "/.git", "read", { missing_path_behavior: "skip" })
  ] } }
});
const applied = (value: unknown) => ({ type: "event_msg", payload: { type: "thread_settings_applied", thread_id: id, thread_settings: value } });
const rollout = (...rows: unknown[]) => [ { type: "session_meta", payload: { id } }, ...rows ].map(r => JSON.stringify(r) + "\n").join("");

test("NATIVE-02.8: latest native permission record preserves network, extra roots and temp exclusions without replaying model", () => {
  const p = nativePermissionResume(rollout(applied(settings())), id);
  assert.deepEqual(p, { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: "on-request", approvalsReviewer: "auto_review",
    sandbox: "workspace-write", config: { "sandbox_workspace_write.network_access": true,
      "sandbox_workspace_write.writable_roots": [cwd + "/.git"],
      "sandbox_workspace_write.exclude_tmpdir_env_var": true, "sandbox_workspace_write.exclude_slash_tmp": true } });
  for (const key of ["model", "effort", "collaborationMode", "developerInstructions", "projectId"]) assert.equal(key in p, false);
});

test("NATIVE-02.8: later native tightening and emptied roots supersede earlier broader grants", () => {
  const p = nativePermissionResume(rollout(applied(settings()), applied(settings(false, [cwd]))), id);
  assert.equal((p.config as any)["sandbox_workspace_write.network_access"], false);
  assert.deepEqual((p.config as any)["sandbox_workspace_write.writable_roots"], []);
  const readonly = { ...settings(), permission_profile: { type: "managed", network: "restricted",
    file_system: { type: "restricted", entries: [special("root", "read")] } } };
  assert.equal(nativePermissionResume(rollout(applied(settings()), applied(readonly)), id).sandbox, "read-only");
});

test("NATIVE-02.8: named native profile retains its identity instead of discarding domain or deny rules", () => {
  const value = { ...settings(), active_permission_profile: { id: "restricted-profile" } };
  value.permission_profile.file_system.entries.push(file("/workspace/secret", "deny"));
  const restored = nativePermissionResume(rollout(applied(value)), id);
  assert.equal(restored.permissions, "restricted-profile");
  assert.equal("sandbox" in restored, false);
  assert.equal("config" in restored, false);
  const granular = { granular: { sandbox_approval: true, rules: false, skill_approval: false, request_permissions: true, mcp_elicitations: false } };
  assert.deepEqual(nativePermissionResume(rollout(applied({ ...value, approval_policy: granular })), id).approvalPolicy, granular);
});

for (const tmpdir of [false, true]) for (const slashTmp of [false, true]) {
  test(`NATIVE-02.8: native temporary-directory grants stay independent (tmpdir=${tmpdir}, slashTmp=${slashTmp})`, () => {
    const value = settings();
    if (tmpdir) value.permission_profile.file_system.entries.push(special("tmpdir", "write") as any);
    if (slashTmp) value.permission_profile.file_system.entries.push(special("slash_tmp", "write") as any);
    const config = nativePermissionResume(rollout(applied(value)), id).config as any;
    assert.equal(config["sandbox_workspace_write.exclude_tmpdir_env_var"], !tmpdir);
    assert.equal(config["sandbox_workspace_write.exclude_slash_tmp"], !slashTmp);
  });
}

test("NATIVE-02.8: old turn context, modern applied settings and empty native threads retain their ordering", () => {
  const old = { cwd, approval_policy: "never", sandbox_policy: { type: "workspace-write", network_access: false,
    writable_roots: ["/sibling"], exclude_tmpdir_env_var: false, exclude_slash_tmp: false } };
  const context = { type: "turn_context", payload: old };
  assert.equal(nativePermissionResume(rollout(applied(settings()), context), id).approvalPolicy, "never");
  assert.equal(nativePermissionResume(rollout(context, applied(settings())), id).approvalPolicy, "on-request");
  assert.deepEqual(nativePermissionResume(rollout(), id), {});
  assert.equal(nativePermissionResume(rollout(applied({ ...old, sandbox_policy: { type: "read-only" } })), id).sandbox, "read-only");
  assert.equal(nativePermissionResume(rollout(applied({ ...old, permission_profile: { type: "disabled" } })), id).sandbox, "danger-full-access");
});

for (const variant of ["deny", "glob", "read-scope", "unknown-profile", "external", "unknown-approval", "unknown-reviewer", "relative-root", "missing-cwd", "writable-outside-cwd", "runtime-root-not-writable"]) {
  test(`NATIVE-02.8: nonrepresentable or incomplete ${variant} never falls back to an older broad grant`, () => {
    const bad: any = settings();
    const entries = bad.permission_profile.file_system.entries;
    if (variant === "deny") entries.push(file("/workspace/secret", "deny"));
    if (variant === "glob") entries.push({ path: { type: "glob_pattern", pattern: "**/*.env" }, access: "deny" });
    if (variant === "read-scope") entries.push(file("/workspace/protected", "read"));
    if (variant === "unknown-profile") bad.permission_profile.type = "future";
    if (variant === "external") bad.permission_profile = { type: "external", network: "restricted" };
    if (variant === "unknown-approval") bad.approval_policy = "future";
    if (variant === "unknown-reviewer") bad.approvals_reviewer = "future";
    if (variant === "relative-root") bad.runtime_workspace_roots = ["relative"];
    if (variant === "missing-cwd") delete bad.cwd;
    if (variant === "writable-outside-cwd") bad.cwd = "/other";
    if (variant === "runtime-root-not-writable") bad.runtime_workspace_roots.push("/not-granted");
    assert.throws(() => nativePermissionResume(rollout(applied(settings()), applied(bad)), id), /最新权限/);
  });
}

for (const variant of ["foreign-header", "foreign-settings", "internal", "torn", "malformed", "missing-settings"]) {
  test(`NATIVE-02.8: ${variant} native source cannot authorize restoration`, () => {
    let text = rollout(applied(settings()));
    if (variant === "foreign-header") text = text.replace('"id":"native-thread"', '"id":"foreign"');
    if (variant === "foreign-settings") text = text.replace('"thread_id":"native-thread"', '"thread_id":"foreign"');
    if (variant === "internal") text = text.replace('"id":"native-thread"', '"id":"native-thread","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}');
    if (variant === "torn") text += '{"type":"event_msg"';
    if (variant === "malformed") text += '{"type":"turn_context",bad}\n';
    if (variant === "missing-settings") text += JSON.stringify(applied(null)) + "\n";
    assert.throws(() => nativePermissionResume(text, id));
  });
}

function runner(state = "notLoaded", contents = rollout(applied(settings()))) {
  const r = new AppServerCodexRunner() as any;
  const calls: Array<{ method: string; params: any }> = [];
  r.request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id, path: "/native/owner.jsonl", status: { type: state } } };
    if (method === "fs/readFile") return { dataBase64: Buffer.from(contents).toString("base64") };
    return { thread: { id } };
  };
  return { r, calls };
}
test("NATIVE-02.8: cold restoration uses the native host file and checks revoked source before its only resume", async () => {
  const f = runner(); let current = true;
  const request = f.r.request;
  f.r.request = async (method: string, params: any) => {
    const result = await request(method, params); if (method === "fs/readFile") current = false; return result;
  };
  await assert.rejects(f.r.resumeThread({ threadId: id, excludeTurns: true }, undefined,
    () => { if (!current) throw Error("binding revoked"); }), /binding revoked/);
  assert.deepEqual(f.calls.map(c => c.method), ["thread/read", "fs/readFile"]);
  assert.deepEqual(f.calls[1].params, { path: "/native/owner.jsonl" });
});

for (const state of ["idle", "active", "systemError"]) test(`NATIVE-02.8: loaded ${state} owner is attached without cached or stored overrides`, async () => {
  const { r, calls } = runner(state);
  await r.resumeThread({ threadId: id, excludeTurns: true });
  assert.deepEqual(calls.map(c => c.method), ["thread/read", "thread/resume"]);
  assert.deepEqual(calls[1].params, { threadId: id, excludeTurns: true });
});

test("NATIVE-02.8: explicit owning UI bypasses historical grants and unreadable native records never submit", async () => {
  const { r, calls } = runner();
  const params = { threadId: id, sandbox: "read-only", approvalPolicy: "on-request" };
  await r.resumeThread(params);
  assert.deepEqual(calls, [{ method: "thread/resume", params }]);
  const broken = runner("notLoaded", "broken\n");
  await assert.rejects(broken.r.resumeThread({ threadId: id }));
  assert.equal(broken.calls.some(c => c.method === "thread/resume" || c.method === "turn/start"), false);
});

test("NATIVE-02.8: missing load status or native path cannot silently fall back to defaults", async () => {
  for (const thread of [{ id }, { id, status: { type: "future" } }, { id, status: { type: "notLoaded" } }]) {
    const { r, calls } = runner();
    r.request = async (method: string) => { calls.push({ method, params: {} }); return { thread }; };
    await assert.rejects(r.resumeThread({ threadId: id }), /加载状态|记录路径/);
    assert.deepEqual(calls.map(c => c.method), ["thread/read"]);
  }
});

test("NATIVE-02.8: a definite permission preflight failure releases an owned queue origin without submitting input", async () => {
  const { r, calls } = runner("notLoaded", "broken\n");
  r.ensureConnected = async () => {}; r.recyclePrivateTransportIfIdle = async () => {};
  await assert.rejects(r.addQueuedSubmission({ threadId: id, prompt: "one input", clientUserMessageId: "not-submitted" }));
  assert.equal(r.nativeQueueOrigins.size, 0);
  assert.equal(calls.some(c => c.method === "thread/resume" || c.method === "thread/queue/add" || c.method === "turn/start"), false);
});
