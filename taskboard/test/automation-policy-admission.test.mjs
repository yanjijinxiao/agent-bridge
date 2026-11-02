import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createIssueAutomation } from "../server/issue-automation.mjs";

for (const change of ["unchanged", "disabled", "removed", "model", "workspace", "skill"]) {
  test(`an automation quota wait cannot outlive its ${change} policy`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-policy-admission-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "policies.json");
    const policy = { taskboardProjectId: "project", codexProjectId: "native-project", projectName: "Fixture",
      workspacePath: root, skillPath: path.join(root, "skills/manage-taskboard/SKILL.md"), enabledByUser: true,
      quotaAware: true, model: "gpt-5.5", reasoningEffort: "high" };
    await writeFile(file, JSON.stringify({ project: policy }));
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), spawned = [];
    const automation = createIssueAutomation({ automationPoliciesPath: file, codexExecutable: "fixture-only",
      logger: { info() {}, error() {} }, readQuota() { entered.resolve(); return release.promise; },
      spawnTurn(options) { spawned.push(options); return { child: { kill() {} }, completion: Promise.resolve({ exitCode: 0 }) }; }
    });
    t.after(() => { release.resolve({ state: "available" }); return automation.close(); });
    const pending = automation.trigger({ projectId: "project" });
    await entered.promise;
    const next = { ...policy };
    if (change === "disabled") next.enabledByUser = false;
    if (change === "model") next.model = "gpt-5.4";
    if (change === "workspace") next.workspacePath = path.join(root, "other-workspace");
    if (change === "skill") next.skillPath = path.join(root, "other-skill/SKILL.md");
    // Equivalent formatting is deliberately allowed: only the effective parsed
    // policy is the execution authority, not file mtime or serialized whitespace.
    await writeFile(file, JSON.stringify(change === "removed" ? {} : { project: next }, null, 2));
    release.resolve({ state: "available" });
    const result = await pending;
    assert.equal(spawned.length, change === "unchanged" ? 1 : 0);
    assert.deepEqual(result, change === "unchanged" ? { started: true } : { started: false, reason: "policy-changed" });
    if (change === "unchanged") {
      assert.equal(spawned[0].args[spawned[0].args.indexOf("-m") + 1], policy.model);
      assert.ok(spawned[0].prompt.includes(policy.workspacePath));
    }
  });
}
