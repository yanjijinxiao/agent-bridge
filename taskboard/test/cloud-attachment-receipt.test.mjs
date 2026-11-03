import assert from "node:assert/strict";
import path from "node:path";
import { before, after, test } from "node:test";
import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";
let cloud;
before(async () => { cloud = await createCloudWorkerHarness({ entryPath: path.join(import.meta.dirname, "helpers/uncertain-upload-worker.mjs") });
  const created = await cloud.request("/api/projects", { actorName: "Audit", method: "POST", json: { id: "upload", name: "Upload" } });
  assert.equal(created.response.status, 201);
});
after(async () => { await cloud?.dispose(); });

for (const mode of ["after", "before", "read-unavailable"]) {
  test(`cloud attachment preserves its R2 object after an uncertain D1 receipt: ${mode}`, async () => {
    const taskResult = await cloud.request("/api/tasks", { actorName: "Audit", method: "POST", json: { projectId: "upload", title: mode } });
    assert.equal(taskResult.response.status, 201);
    const task = taskResult.body.task;
    const oldKeys = await cloud.listAttachmentKeys();
    const upload = await cloud.request(`/api/tasks/${task.id}/attachments`, { actorName: "Audit", method: "POST",
      headers: { "content-type": "text/plain", "x-taskboard-filename": `${mode}.txt`, "x-audit-fault": mode }, body: "preserve this file" });
    assert.equal(upload.response.status, 500, "uncertain write remains explicitly unconfirmed");
    const keys = (await cloud.listAttachmentKeys()).filter(key => !oldKeys.includes(key));
    assert.equal(keys.length, 1, "an attempted D1 write does not authorize deleting its object");
    const listed = await cloud.request(`/api/tasks/${task.id}/attachments`, { actorName: "Audit" });
    assert.equal(listed.body.attachments.length, mode === "before" ? 0 : 1);
    if (mode !== "before") {
      assert.equal(listed.body.attachments[0].id, keys[0]);
      const download = await cloud.request(`/api/attachments/${keys[0]}/content`, { actorName: "Audit" });
      assert.equal(download.response.status, 200);
      assert.equal(download.body, "preserve this file");
    }
    assert.equal(await cloud.db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE task_id = ?").bind(task.id).first("n"), mode === "before" ? 0 : 1);
  });
}

test("cloud project lookup supplies the local AI catalog without exposing local paths", async () => {
  const result = await cloud.request("/api/projects/upload", { actorName: "Audit" });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.project.id, "upload");
  assert.equal(result.body.project.workspacePath, null);
  const missing = await cloud.request("/api/projects/not-found", { actorName: "Audit" });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, "PROJECT_NOT_FOUND");
});
