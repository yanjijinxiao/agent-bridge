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
  const receiver = INBOUND_FILE_RECEIVER.replace("os.homedir()", JSON.stringify(root));
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

for (const supplied of ["owned", "root", "public", "relative"] as const) test(`SSH receiver validates the explicit persistent home: ${supplied}`, { skip: process.platform === "win32" }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "receiver-explicit-home-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (supplied === "public") fs.chmodSync(root, 0o777);
  const home = supplied === "root" ? path.parse(root).root : supplied === "relative" ? "relative" : root;
  const body = Buffer.from("persistent SSH filesystem\0"), hash = crypto.createHash("sha256").update(body).digest("hex");
  const input = Buffer.concat([Buffer.from(JSON.stringify({ name: "test.bin", hash, scope: "b".repeat(64), size: body.length }) + "\n"), body]);
  // Simulate node's container view: os.homedir returns root while argv retains
  // the SSH shell's actual home. The receiver must not choose ephemeral /tmp.
  const receiver = INBOUND_FILE_RECEIVER.replace("os.homedir()", "path.parse(process.cwd()).root");
  const run = () => spawnSync(process.execPath, ["-e", receiver, "--", home], { input });
  const result = run();
  if (supplied !== "owned") {
    assert.equal(result.status, 1); assert.equal(fs.existsSync(path.join(root, ".codex-im-gateway")), false);
    if (supplied === "public") assert.equal(fs.statSync(root).mode & 0o777, 0o777, "never chmod a supplied shared directory to claim it");
  } else {
    assert.equal(result.status, 0, result.stderr.toString());
    const staged = JSON.parse(result.stdout.toString()).path;
    assert.ok(staged.startsWith(root + path.sep)); assert.deepEqual(fs.readFileSync(staged), body);
    assert.equal(fs.statSync(staged).mode & 0o777, 0o600);
    assert.equal(run().stdout.toString(), result.stdout.toString());
  }
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
