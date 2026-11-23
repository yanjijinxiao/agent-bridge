import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nativePermissionSource } from "../src/codex/native-permission-source.js";
import { ColdPermissionError, type ColdPermissionReason } from "../src/codex/cold-permission-error.js";

const threadId = "original-thread";
const header = (id = threadId) => ({ type: "session_meta", payload: { id, session_id: "parent", source: "cli" } });
const settings = (permissions = ":read-only") => ({ cwd: "/project", approval_policy: "on-request", approvals_reviewer: "user",
  active_permission_profile: { id: permissions }, developer_instructions: "discard this unrelated content" });
const applied = (value: unknown) => ({ type: "event_msg", payload: { type: "thread_settings_applied", thread_id: threadId, thread_settings: value } });
const row = (value: unknown) => JSON.stringify(value) + "\n";

function fixture(t: test.TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-permission-source-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions"); fs.mkdirSync(dir);
  const file = path.join(dir, "rollout.jsonl");
  const read = nativePermissionSource((script, input) => ({ command: process.execPath, args: ["-e", script, input] }), home);
  return { home, file, read: (filename = file) => read({ file: filename, threadId, signal: new AbortController().signal, timeoutMs: 4000 }) };
}

test("NATIVE-02.10: a multi-GiB native log can restore its latest permission from small bounded reads", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, row(header()) + row(applied(settings("broad-old-profile"))));
  // A sparse prefix models an old bulk history. Its contents must never be
  // read to recover a newer complete permission row near EOF.
  fs.truncateSync(f.file, 3 * 1024 ** 3);
  fs.appendFileSync(f.file, "\n" + row({ type: "turn_context", payload: settings() })
    + row({ type: "response_item", payload: { output: "large unrelated row".repeat(40000) } }));
  assert.deepEqual(await f.read(), { cwd: "/project", approvalPolicy: "on-request", approvalsReviewer: "user", permissions: ":read-only" });
});

test("NATIVE-02.10: settings-applied takes precedence when newest and empty threads retain native defaults", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, row(header())); assert.deepEqual(await f.read(), {});
  fs.appendFileSync(f.file, row({ type: "turn_context", payload: settings("earlier") }) + row(applied(settings("current"))));
  assert.equal((await f.read()).permissions, "current");
});

for (const [scenario, last, expected] of [
  ["truncated append", '{"type":', "changed"],
  ["corrupt complete line", "{invalid}\n", "invalid"],
  ["newer incomplete settings", row(applied({ cwd: "/project" })), "invalid"],
  ["foreign latest settings", row({ type: "turn_context", payload: { ...settings(), thread_id: "foreign" } }), "invalid"],
] as const) test(`NATIVE-02.10: ${scenario} cannot fall back to older permissions`, async t => {
  const f = fixture(t); fs.writeFileSync(f.file, row(header()) + row(applied(settings("older"))) + last);
  await assert.rejects(f.read(), (error: ColdPermissionError) => error instanceof ColdPermissionError && error.reason === expected);
});

test("NATIVE-02.10: a foreign, internal, symlinked or outside-home source cannot restore permissions", async t => {
  const f = fixture(t);
  const reject = (p?: string) => assert.rejects(f.read(p), (error: ColdPermissionError) => error instanceof ColdPermissionError && error.reason === "invalid");
  fs.writeFileSync(f.file, row(header("other")) + row(applied(settings()))); await reject();
  fs.writeFileSync(f.file, row({ type: "session_meta", payload: { id: threadId, source: { subagent: {} } } })); await reject();
  fs.writeFileSync(f.file, row(header()));
  const symlink = path.join(path.dirname(f.file), "alias.jsonl"); fs.symlinkSync(f.file, symlink); await reject(symlink);
  const outside = path.join(f.home, "outside.jsonl"); fs.writeFileSync(outside, row(header())); await reject(outside);
});

test("NATIVE-02.10: a large unread line stops the latest-first scan instead of guessing older permissions", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, row(header()) + row(applied(settings("older"))));
  fs.truncateSync(f.file, 70 * 1024 ** 2); fs.appendFileSync(f.file, "\n");
  const expected: ColdPermissionReason = "limit";
  await assert.rejects(f.read(), (error: ColdPermissionError) => error instanceof ColdPermissionError && error.reason === expected);
});
