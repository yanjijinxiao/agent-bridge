import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { automaticApprovalProgress } from "../src/codex/approval-progress.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

test("automatic review statuses disclose their outcome without leaking action or reviewer payloads", () => {
  const input = { reviewId: "review", action: { command: "PRIVATE_ACTION" }, review: { status: "inProgress", rationale: "PRIVATE_REVIEW" } };
  const started = automaticApprovalProgress("item/autoApprovalReview/started", input)!;
  assert.match(started, /自动审核.*不是.*人工审批/);
  for (const [status, expected] of [["approved", /已通过.*以执行结果为准/], ["denied", /拒绝.*不是等待你审批/],
    ["timedOut", /超时.*尚未确认/], ["aborted", /已停止.*尚未确认/]] as const) {
    const text = automaticApprovalProgress("item/autoApprovalReview/completed", { ...input, review: { ...input.review, status } })!;
    assert.match(text, expected);
    assert.doesNotMatch(text, /PRIVATE_|\/approve|\/reject/);
  }
  for (const invalid of [{ ...input, reviewId: "" }, { ...input, review: [] }, { ...input, review: { status: "unknown" } }]) {
    assert.equal(automaticApprovalProgress("item/autoApprovalReview/completed", invalid), undefined);
  }
  assert.equal(automaticApprovalProgress("item/permissions/requestApproval", input), undefined);
  assert.equal(automaticApprovalProgress("item/autoApprovalReview/completed", input), undefined);
});

test("automatic review reaches only its active turn's progress, without fabricating a human request or reopening a finished turn", async t => {
  const runner = new AppServerCodexRunner({ codexBin: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-codex-app-server.mjs"), requestTimeoutMs: 2000 });
  t.after(() => runner.close());
  const progress: string[] = [], receipts: string[] = [];
  const result = await runner.run({ cwd: "/tmp/project", threadId: "automatic-review", prompt: "approval:automatic",
    onProgress: text => { progress.push(text); }, onApproval: () => assert.fail("automatic review is not a human approval"),
    onApprovalResult: (_request, result) => { receipts.push(result); } });
  assert.ok(result.turnId);
  assert.equal(progress.length, 2, "foreign and late review events are not forwarded");
  assert.match(progress[0], /正在自动审核/);
  assert.match(progress[1], /自动审核拒绝/);
  assert.doesNotMatch(progress.join("\n"), /PRIVATE_|\/approve|\/reject/);
  assert.deepEqual(receipts, []);
  assert.equal((await runner.inspectThread(result.threadId)).runtimeStatus, "idle");
});
