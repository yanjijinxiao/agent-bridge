import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

// A real child process exposes unhandled async rejection, rather than masking
// it with the test runner's own event handlers. No production service is used.
for (const mode of ["sync-failure", "async-failure", "accepted"]) {
  test(`HTTP update restart handoff keeps service alive and releases only failed launches (${mode})`, async () => {
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./fixtures/update-restart-failure.mjs", import.meta.url)), mode],
      { timeout: 10_000 });
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    assert.deepEqual(result, { mode, calls: 1, prepared: mode === "accepted", alive: true });
  });
}
