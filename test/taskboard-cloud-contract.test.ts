import assert from "node:assert/strict";
import test from "node:test";
import { TaskboardClient } from "../src/taskboard/client.js";
// @ts-ignore Isolated Taskboard Miniflare harness.
import { createCloudWorkerHarness } from "../taskboard/test/helpers/cloud-worker-harness.mjs";

for (const scenario of ["thread-filter", "transition", "stale-transition", "comment-failure"]) {
  test(`Gateway Taskboard client cloud contract: ${scenario}`, async t => {
    const cloud = await createCloudWorkerHarness();
    t.after(() => cloud.dispose());
    const client = new TaskboardClient({ baseUrl: "http://127.0.0.1:9999", fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Basic ${Buffer.from(`fixture:${cloud.sharedSecret}`).toString("base64")}`);
      return cloud.miniflare.dispatchFetch(new URL(new URL(String(url)).pathname + new URL(String(url)).search, "https://taskboard.example.test"), { ...init, headers });
    } });
    await cloud.request("/api/projects", { method: "POST", actorName: "fixture", json: { id: "contract", name: "Contract" } });
    const create = async (threadId: string) => {
      const result = await cloud.request("/api/tasks", { method: "POST", actorName: "fixture", json: { projectId: "contract", title: threadId, threadId } });
      assert.equal(result.response.status, 201);
      return result.body.task;
    };
    const task = await create("first-thread");
    await create("second-thread");
    if (scenario === "thread-filter") {
      const selected = await client.issueForThread("contract", "first-thread");
      assert.equal(selected?.id, task.id);
      assert.equal(await client.issueForThread("contract", "absent-thread"), undefined);
      return;
    }
    if (scenario === "comment-failure") {
      await cloud.db.exec("CREATE TRIGGER fail_transition_comment BEFORE INSERT ON comments WHEN NEW.body = 'fail-comment' BEGIN SELECT RAISE(ABORT, 'synthetic comment failure'); END;");
      await assert.rejects(client.moveIssueWithComment(task.id, "in_progress", task.version, "first-thread", "fail-comment"), /500/);
    } else {
      const result = await client.moveIssueWithComment(task.id, "in_progress", task.version, "first-thread", "work started");
      assert.equal(result.task.status, "in_progress");
      assert.equal(result.task.version, task.version + 1);
      assert.equal(result.comment.taskId, task.id);
      assert.equal(result.comment.body, "work started");
      assert.equal(await cloud.db.prepare("SELECT author_type FROM comments WHERE id = ?").bind(result.comment.id).first("author_type"), "agent");
      assert.equal(result.comment.threadId, "first-thread");
      if (scenario === "stale-transition") await assert.rejects(client.moveIssueWithComment(task.id, "done", task.version, "first-thread", "stale duplicate"), /409/);
    }
    const stored = await client.getIssue(task.id);
    const comments = await client.listComments(task.id);
    assert.equal(stored.status, scenario === "comment-failure" ? task.status : "in_progress");
    assert.equal(comments.length, scenario === "comment-failure" ? 0 : 1, "atomic transition cannot leave a half-written comment or move");
  });
}
