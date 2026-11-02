import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fetchRemoteOutputFile, OUTPUT_FILE_SENDER } from "../src/codex/output-files.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-output-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ssh = path.join(root, "ssh");
  fs.writeFileSync(ssh, `#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process');
fs.writeFileSync(${JSON.stringify(path.join(root, "route.json"))},JSON.stringify(process.argv.slice(2,-1)));
const child=spawn('/bin/sh',['-c',process.argv.at(-1)],{stdio:'inherit'});child.on('close',code=>process.exitCode=code??1);`, { mode: 0o700 });
  return { root, transport: { command: ssh, args: ["-p", "2222", "selected-target", "original relay"], mode: "remote-daemon" as const } };
}

test("remote output transfer preserves bytes and filename using the selected SSH route and cleans its private copy", async t => {
  const { root, transport } = fixture(t), name = "结果 ' $().pdf", source = path.join(root, name);
  const bytes = Buffer.concat([crypto.randomBytes(2048), Buffer.from("中文\0\n")]); fs.writeFileSync(source, bytes);
  const lease = await fetchRemoteOutputFile(source, { maxBytes: 4096, directory: path.join(root, "received") }, transport);
  assert.notEqual(lease.path, source);
  assert.equal(path.basename(lease.path), name);
  assert.deepEqual(fs.readFileSync(lease.path), bytes);
  assert.equal(fs.statSync(lease.path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "route.json"), "utf8")), ["-p", "2222", "selected-target"]);
  await lease.dispose(); assert.equal(fs.existsSync(path.dirname(lease.path)), false);
  assert.deepEqual(fs.readFileSync(source), bytes, "the remote source is never removed");
});

test("remote output sender rejects symlinks, non-files, oversize and invalid paths", t => {
  const { root } = fixture(t), file = path.join(root, "source"); fs.writeFileSync(file, "1234");
  fs.symlinkSync(file, path.join(root, "link"));
  const run = (filePath: string, maxBytes: number) => spawnSync(process.execPath, ["-e", OUTPUT_FILE_SENDER],
    { input: JSON.stringify({ path: filePath, maxBytes }) });
  for (const [filePath, maxBytes] of [[file, 3], [path.join(root, "link"), 4], [root, 4], ["relative", 4], [file, 0]] as const) {
    const result = run(filePath, maxBytes); assert.equal(result.status, 1); assert.equal(result.stdout.length, 0);
  }
});

test("remote output receiver rejects another transport, corrupt bytes, excessive output and timeout", async t => {
  const { root, transport } = fixture(t), file = path.join(root, "source"); fs.writeFileSync(file, "data");
  await assert.rejects(fetchRemoteOutputFile(file, { maxBytes: 4096 }, { ...transport, command: "other" }), /回传端口/);
  for (const [script, error] of [
    ["process.stdout.write(JSON.stringify({size:4,hash:'invalid'})+'\\n'+'data');", /校验失败/],
    ["process.stdout.write(Buffer.alloc(20000));", /读取失败/],
    ["setInterval(()=>{},1000);", /超时/]
  ] as const) {
    fs.writeFileSync(transport.command, `#!${process.execPath}\n${script}`, { mode: 0o700 });
    await assert.rejects(fetchRemoteOutputFile(file, { maxBytes: 4096, timeoutMs: error.source === "超时" ? 100 : 5000 }, transport), error);
  }
});
