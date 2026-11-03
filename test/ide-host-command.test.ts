import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { uploadIDEHost } from "../src/ide/host-command.js";

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { assert.ok(Date.now() < deadline, "isolated transfer did not settle"); await delay(10); }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

for (const failure of ["source", "input-pipe"] as const) test(`IDE upload ${failure} failure retires its owned transfer immediately`, { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-upload-failure-")), marker = path.join(root, "child.pid");
  const source = new PassThrough(); let pid: number | undefined;
  t.after(() => { source.destroy(); if (pid && alive(pid)) process.kill(pid); fs.rmSync(root, { recursive: true, force: true }); });
  t.mock.method(fs, "createReadStream", () => source as unknown as fs.ReadStream);
  const script = `const fs=require('node:fs'),input=JSON.parse(Buffer.from(process.argv[1],'base64'));
    if(input.failure==='input-pipe')fs.closeSync(0);
    fs.writeFileSync(input.marker,String(process.pid));setInterval(()=>{},1000);`;
  const rejected = assert.rejects(uploadIDEHost("local", script, { marker, failure }, "fixture", new AbortController().signal),
    failure === "source" ? /fixture source failure/ : /EPIPE|closed|write/i);
  await until(() => fs.existsSync(marker)); pid = Number(fs.readFileSync(marker, "utf8"));
  if (failure === "source") source.destroy(new Error("fixture source failure"));
  else source.write(Buffer.alloc(1024 * 1024));
  await rejected;
  await until(() => !alive(pid!), 500);
  assert.equal(source.destroyed, true);
});

test("IDE upload completes only after its owned process consumes the full artifact", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-upload-complete-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "input"), output = path.join(root, "output");
  const bytes = Buffer.from("完整制品\n".repeat(10000)); fs.writeFileSync(file, bytes);
  await uploadIDEHost("local", `const fs=require('node:fs'),input=JSON.parse(Buffer.from(process.argv[1],'base64'));
    process.stdin.pipe(fs.createWriteStream(input.output));`, { output }, file, new AbortController().signal);
  assert.deepEqual(fs.readFileSync(output), bytes);
});
