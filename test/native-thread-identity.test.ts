import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

for (const shape of ["foreign", "missing", "empty", "inspect-foreign"]) {
  test(`continuation refuses ${shape} thread identity before any native write or acceptance`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-thread-identity-")), trace = path.join(root, "methods");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runner = new AppServerCodexRunner({ requestTimeoutMs: 1000, catalogSource: "native", transport: {
      command: process.execPath, args: [fileURLToPath(new URL("./fixtures/thread-identity-app-server.mjs", import.meta.url)), shape, trace], mode: "daemon-proxy"
    } }); t.after(() => runner.close());
    let accepted = 0;
    await assert.rejects(runner.run({ threadId: "original-thread", cwd: "/tmp", prompt: "must stay in original thread",
      threadTitle: "preserve", onTurnStarted: () => { accepted++; } }), /identity mismatch|did not return a thread id/i);
    // The fixture rejects all writes. Assert the error is identity validation,
    // rather than a later native rejection after input/metadata was submitted.
    assert.equal(accepted, 0);
    assert.equal(fs.readFileSync(trace, "utf8").split("\n").some(method => ["thread/name/set", "thread/metadata/update", "turn/start"].includes(method)), false);
    assert.equal((runner as any).subscribedThreads.has("foreign-thread"), false);
  });
}
