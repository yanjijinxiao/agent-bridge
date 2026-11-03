import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

for (const status of ["completed", "interrupted"]) test(`an early queue ${status} history view keeps observing its loaded active turn`, async t => {
  const runner = new AppServerCodexRunner({ requestTimeoutMs: 2000, transport: { command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url)), `--queue-terminal-view=${status}`], mode: "stdio" } });
  t.after(() => runner.close());
  const wire = runner as unknown as { request(method: string, params: unknown, ...args: unknown[]): Promise<unknown> };
  const request = wire.request.bind(runner), methods: string[] = [];
  wire.request = (method, params, ...args) => { methods.push(method); return request(method, params, ...args); };
  const item = await runner.addQueuedSubmission({ threadId: "thread-existing", prompt: "queue once", clientUserMessageId: "queue-source" });
  const result = await runner.runQueuedSubmission({ threadId: "thread-existing", queuedSubmissionId: item.id,
    clientUserMessageId: "queue-source", cwd: "/tmp/project" });
  assert.equal(result.text, "QUEUE_RACE_DONE", "wait for the actual final event, not the incomplete/interrupted history view");
  assert.equal(result.turnId, "queue-race-1");
  assert.equal(methods.filter(method => method === "thread/queue/add").length, 1);
  assert.equal(methods.filter(method => ["turn/start", "thread/queue/start", "turn/interrupt"].includes(method)).length, 0);
  assert.equal((await runner.listQueuedSubmissions("thread-existing")).data.length, 0);
});
