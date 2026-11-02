import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { sharedNativeCore, until } from "./fixtures/shared-native-core.mjs";

for (const assigned of [false, true]) {
  test(`ordinary continuation ignores stale project hints when native membership is ${assigned ? "different" : "none"}`, async t => {
    const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
    const runner = new AppServerCodexRunner({ requestTimeoutMs: 2000, catalogSource: "native", transport: {
      command: process.execPath, args: [fixture, "--forbid-existing-project-write", ...(assigned ? ["--existing-other-project"] : [])], mode: "daemon-proxy"
    } }); t.after(() => runner.close());
    const result = await runner.run({ threadId: "thread-existing", cwd: "/tmp/project", projectId: "project-native",
      projectName: "Fixture Project", prompt: "continue-with-stale-project-hint" });
    assert.equal(result.text, "reply:continue-with-stale-project-hint");
  });

  test(`real native ${assigned ? "reassigned" : "removed"} membership survives continuation from an old Gateway project context`,
    { skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30000 }, async t => {
      const f = await sharedNativeCore(t), peer = await f.rpc("membership_continuation"), cwd = fs.realpathSync(f.root);
      const { project: old } = await peer.request("project/create", { name: "Old project", roots: [{ path: cwd }], idempotencyKey: "old-project" });
      const { thread } = await peer.request("thread/start", { cwd, projectId: old.id });
      await peer.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "initialize", text_elements: [] }] });
      await until(() => peer.events.some(event => event.method === "turn/completed"));
      const next = assigned ? (await peer.request("project/create", { name: "New project", roots: [{ path: cwd }], idempotencyKey: "new-project" })).project.id : "";
      await peer.request("thread/metadata/update", { threadId: thread.id, projectId: next });
      const runner = f.runner();
      await runner.run({ threadId: thread.id, cwd, projectId: old.id, projectName: old.name, prompt: "continue from cached context" });
      const observed = (await peer.request("thread/read", { threadId: thread.id, includeTurns: false })).thread;
      assert.equal(observed.projectId || null, next || null, "continuing a thread does not reassign it to the cached project");
      assert.equal(f.calls.length, 2, "one existing turn and exactly one continuation");
    });
}
