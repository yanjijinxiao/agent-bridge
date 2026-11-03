import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { INBOUND_FILE_RECEIVER, stageRemoteFiles } from "../src/codex/inbound-files.js";

test("remote receiver preserves bytes, reuses the same digest and rejects traversal/symlink destinations", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "receiver-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receiver = INBOUND_FILE_RECEIVER.replace("fs.realpathSync(os.homedir())", `fs.realpathSync(${JSON.stringify(root)})`);
  const body = Buffer.from("Inventory 中文\n完整文件\0");
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const scope = "a".repeat(64);
  const run = (name: string) => spawnSync(process.execPath, ["-e", receiver], { input: Buffer.concat([
    Buffer.from(JSON.stringify({ name, hash, scope, size: body.length }) + "\n"), body
  ]) });
  const first = run("MCT.md");
  assert.equal(first.status, 0, first.stderr.toString());
  const target = JSON.parse(first.stdout.toString()).path;
  assert.deepEqual(fs.readFileSync(target), body);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(run("MCT.md").stdout.toString(), first.stdout.toString());
  assert.equal(run("../escape").status, 1);
  fs.renameSync(target, `${target}.original`);
  fs.symlinkSync(`${target}.original`, target);
  assert.equal(run("MCT.md").status, 1);
});

test("remote staging refuses non-SSH transports instead of guessing another host", async () => {
  await assert.rejects(stageRemoteFiles([], "account/chat", 1000,
    { command: "custom-websocket", args: ["wss://host"], mode: "remote-daemon" }), /no attachment staging transport/);
});

test("remote staging rejects a FIFO without blocking the Gateway event loop", { skip: process.platform === "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "staging-fifo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fifo = path.join(root, "pipe");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  // A separate process bounds the regression: synchronous open on a FIFO can
  // freeze the real event loop before its ordinary transfer timer even exists.
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    const { stageRemoteFiles } = await import(process.argv[1]);
    try {
      await stageRemoteFiles([{ path: process.argv[2], label: "pipe", kind: "file" }], "test", 100,
        { command: "/usr/bin/ssh", args: ["unused-host", "unused-command"], mode: "remote-daemon" });
      process.exitCode = 2;
    } catch { process.stdout.write("rejected"); }
  `, new URL("../src/codex/inbound-files.ts", import.meta.url).href, fifo], { timeout: 2000, encoding: "utf8" });
  assert.equal(child.error, undefined, "non-files must be rejected before a blocking open or SSH process");
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "rejected");
});
