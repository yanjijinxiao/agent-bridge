import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { sharedNativeCore, until } from "./fixtures/shared-native-core.mjs";

for (const callback of [false, true]) for (const reconnect of [false, true]) for (const explicit of [false, true]) {
  test(`NATIVE-02.2: native permission inheritance ${JSON.stringify({ callback, reconnect, explicit })}`, {
    skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30000
  }, async t => {
    const core = await sharedNativeCore(t), desktop = await core.rpc("permission_matrix");
    const corePid = (await desktop.request("server/diagnostics")).process.id;
    const { thread } = await desktop.request("thread/start", { cwd: core.root,
      approvalPolicy: "never", approvalsReviewer: "auto_review", sandbox: "workspace-write" });
    await desktop.request("turn/start", { threadId: thread.id,
      input: [{ type: "text", text: "initialize permission fixture", text_elements: [] }] });
    await until(() => desktop.events.some(e => e.method === "turn/completed"));
    const writes: Array<{ method: string; params: Record<string, unknown> }> = [];
    const connect = () => {
      const runner = core.runner({ sandbox: "read-only" });
      const request = (runner as any).request.bind(runner);
      (runner as any).request = (method: string, params: Record<string, unknown>, ...rest: unknown[]) => {
        if (["thread/resume", "thread/start", "turn/start"].includes(method)) writes.push({ method, params: structuredClone(params) });
        return request(method, params, ...rest);
      };
      const gateway = new CodexAppServerGateway({ appServerBackend: runner });
      t.after(() => gateway.close()); return gateway;
    };
    let gateway = connect(), approvals = 0;
    const onApproval = callback ? async () => { approvals++; return "decline" as const; } : undefined;
    const first = await gateway.run({ threadId: thread.id, cwd: core.root, prompt: "inherit before reconnect",
      clientUserMessageId: "permission-first", onApproval });
    assert.equal(first.threadId, thread.id);
    const before = await desktop.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    assert.equal(before.approvalPolicy, "never"); assert.equal(before.approvalsReviewer, "auto_review");
    assert.equal(before.sandbox.type, "workspaceWrite");
    if (reconnect) { await gateway.close(); gateway = connect(); }
    const second = await gateway.run({ threadId: thread.id, cwd: core.root, prompt: "continue exact native permissions",
      clientUserMessageId: "permission-second", onApproval,
      ...(explicit ? { nativeSettings: { sandbox: "read-only" as const, approvalPolicy: "on-request" as const,
        approvalsReviewer: "user" as const, runtimeWorkspaceRoots: [core.root] } } : {}) });
    const current = await desktop.request("thread/resume", { threadId: thread.id, excludeTurns: true });
    assert.equal(current.approvalPolicy, explicit ? "on-request" : "never");
    assert.equal(current.approvalsReviewer, explicit ? "user" : "auto_review");
    assert.equal(current.sandbox.type, explicit ? "readOnly" : "workspaceWrite");
    assert.equal(second.threadId, thread.id); assert.notEqual(second.turnId, first.turnId);
    assert.equal(approvals, 0, "text-only fixture cannot fabricate a permission request");
    assert.equal((await desktop.request("server/diagnostics")).process.id, corePid);
    const history = await gateway.getHistory(thread.id);
    for (const id of ["permission-first", "permission-second"])
      assert.equal(history.filter(m => m.clientUserMessageId === id).length, 1);
    assert.equal(core.calls.length, 3);
    const resumes = writes.filter(w => w.method === "thread/resume");
    assert.ok(resumes.length >= 1);
    for (const write of writes) {
      const selected = explicit && (write === resumes.at(-1) || write.method === "turn/start" && write.params.clientUserMessageId === "permission-second");
      for (const field of ["sandbox", "approvalPolicy", "approvalsReviewer", "runtimeWorkspaceRoots"])
        assert.equal(Object.hasOwn(write.params, field), selected && (field !== "sandbox" || write.method !== "turn/start"), `${write.method}.${field} follows explicit settings only`);
      if (write.method === "turn/start") assert.deepEqual(write.params.sandboxPolicy, selected ? { type: "readOnly" } : undefined);
    }
  });
}

test("NATIVE-02.5: an explicit writable workspace change reaches the loaded owner and remains inherited", {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30000
}, async t => {
  const { default: fs } = await import("node:fs"), { default: path } = await import("node:path");
  const core = await sharedNativeCore(t), desktop = await core.rpc("writable_scope");
  const { thread } = await desktop.request("thread/start", { cwd: core.root,
    approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only" });
  await desktop.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "initialize", text_elements: [] }] });
  await until(() => desktop.events.some(e => e.method === "turn/completed"));
  const roots = [path.join(core.root, "chosen"), path.join(core.root, "sibling")]; roots.forEach(p => fs.mkdirSync(p));
  const gateway = new CodexAppServerGateway({ appServerBackend: core.runner({ sandbox: "read-only" }) });
  t.after(() => gateway.close());
  await gateway.run({ threadId: thread.id, cwd: roots[0], prompt: "explicit writable roots", clientUserMessageId: "explicit-roots",
    nativeSettings: { sandbox: "workspace-write", approvalPolicy: "never", approvalsReviewer: "auto_review", runtimeWorkspaceRoots: roots } });
  const selected = await desktop.request("thread/resume", { threadId: thread.id, excludeTurns: true });
  assert.equal(selected.cwd, roots[0]); assert.equal(selected.sandbox.type, "workspaceWrite");
  // Native workspaceWrite grants cwd implicitly and normalizes it out of
  // writableRoots; runtimeWorkspaceRoots retains the complete selection.
  assert.deepEqual(selected.runtimeWorkspaceRoots, roots);
  assert.deepEqual(new Set([selected.cwd, ...selected.sandbox.writableRoots]), new Set(roots));
  assert.equal(selected.sandbox.networkAccess, false);
  await gateway.run({ threadId: thread.id, cwd: core.root, prompt: "inherit selected roots", clientUserMessageId: "inherit-roots" });
  const inherited = await desktop.request("thread/resume", { threadId: thread.id, excludeTurns: true });
  assert.equal(inherited.cwd, roots[0]); assert.deepEqual(inherited.sandbox, selected.sandbox);
  assert.equal(inherited.approvalPolicy, "never"); assert.equal(inherited.approvalsReviewer, "auto_review");
  const history = await gateway.getHistory(thread.id);
  assert.equal(history.filter(x => x.clientUserMessageId === "explicit-roots").length, 1);
  assert.equal(history.filter(x => x.clientUserMessageId === "inherit-roots").length, 1);
  assert.equal(core.calls.length, 3);
});
