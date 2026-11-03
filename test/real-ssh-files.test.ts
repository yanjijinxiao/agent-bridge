import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { stageRemoteFiles, type CodexInboundFile } from "../src/codex/inbound-files.js";
import { fetchRemoteOutputFile } from "../src/codex/output-files.js";
import type { AppServerTransport } from "../src/codex/app-server-transport.js";

// Explicit opt-in test destinations, never discovered from production config.
// Each target is the SSH argument list ending at the destination, without a
// remote command. Only the uniquely generated content-addressed scope is removed.
const targets: Array<{ name: string; args: string[] }> = JSON.parse(process.env.CODEX_SSH_FILE_TEST_TARGETS ?? "[]");
for (const target of targets.length ? targets : [{ name: "not-configured", args: [] }]) {
  test(`IN-06: real SSH binary round trip and failure isolation (${target.name})`, { skip: !targets.length, timeout: 90000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-ssh-files-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const scope = `isolated-file-regression-${crypto.randomUUID()}`, scopeHash = crypto.createHash("sha256").update(scope).digest("hex");
    const transport: AppServerTransport = { command: "/usr/bin/ssh", args: [...target.args, "unused-original-relay"], mode: "remote-daemon" };
    const bytes = Buffer.concat([Buffer.from([0, 255, 0, 1]), crypto.randomBytes(64 * 1024), Buffer.from("文件末尾\r\n")]);
    const files: CodexInboundFile[] = ["image", "file", "video", "audio"].map((kind, index) => {
      const file = path.join(root, `source-${index}`); fs.writeFileSync(file, bytes);
      return { path: file, kind: kind as CodexInboundFile["kind"], label: `case_${index}_中文'quote;value.bin` };
    });
    t.after(() => {
      const code = `const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const home=fs.realpathSync(process.argv[1]);const dir=path.join(home,'.codex-im-gateway','inbound','${scopeHash}');if(fs.existsSync(dir)&&fs.lstatSync(dir).isDirectory()&&!fs.lstatSync(dir).isSymbolicLink()&&fs.lstatSync(dir).uid===process.getuid())fs.rmSync(dir,{recursive:true});`;
      const encoded = Buffer.from(code).toString("base64");
      execFileSync("/usr/bin/ssh", [...target.args, `node -e "eval(Buffer.from('${encoded}','base64').toString())" -- "$HOME"`], { timeout: 15000, stdio: "pipe" });
    });
    const staged = await stageRemoteFiles(files, scope, bytes.length, transport);
    assert.equal(staged.length, 4);
    for (let index = 0; index < staged.length; index++) {
      assert.equal(staged[index].label, files[index].label); assert.equal(staged[index].kind, files[index].kind);
      assert.notEqual(staged[index].path, files[index].path);
      assert.match(staged[index].path, new RegExp(`/inbound/${scopeHash}/[a-f0-9]{64}-case_${index}_`));
      const fetched = await fetchRemoteOutputFile(staged[index].path, { maxBytes: bytes.length, directory: root }, transport);
      assert.deepEqual(fs.readFileSync(fetched.path), bytes);
      assert.equal(fs.statSync(fetched.path).mode & 0o777, 0o600);
      assert.equal(path.basename(fetched.path), path.posix.basename(staged[index].path));
      await fetched.dispose(); assert.equal(fs.existsSync(fetched.path), false);
    }
    assert.deepEqual(await stageRemoteFiles(files, scope, bytes.length, transport), staged, "same staged input is content-addressed, not rewritten under a new name");
    await assert.rejects(stageRemoteFiles(files, scope, bytes.length - 1, transport), /limit/);
    await assert.rejects(fetchRemoteOutputFile(staged[0].path, { maxBytes: bytes.length - 1, directory: root }, transport), /大小限制|读取失败/);
    await assert.rejects(fetchRemoteOutputFile(staged[0].path + ".missing", { maxBytes: bytes.length, directory: root }, transport), /读取失败/);
    assert.equal(fs.readdirSync(root).filter(name => name.startsWith("output-")).length, 0, "failed and disposed transfers leave no local copies");
  });
}
