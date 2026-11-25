import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

for (const barrier of ["read", "mid-batch", "before-save", "after-save"]) {
  test(`Weixin recovery after process death at ${barrier} retains the correct cursor and handles each source once`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-checkpoint-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = resolveStatePaths(root);
    const run = (phase: string) => spawnSync(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("./fixtures/weixin-checkpoint-crash.mjs", import.meta.url)), root, phase],
      { encoding: "utf8", timeout: 15000 });
    const readLines = (name: string) => fs.readFileSync(path.join(root, name), "utf8").trim().split("\n");
    const interrupted = run(barrier);
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
    assert.equal(new RuntimeStateStore(paths).getSyncKey(), barrier === "after-save" ? "batch-1" : undefined);
    const before = readLines("reads").length;
    const restored = run("complete");
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readLines("reads")[before], barrier === "after-save" ? "batch-1" : "initial");
    assert.deepEqual(readLines("delivered"), ["a", "b"]);
    assert.equal(new RuntimeStateStore(paths).getSyncKey(), "batch-1");
  });
}
