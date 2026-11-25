import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { codeServerAsset, ProcessIDEInstallerIO } from "../src/ide/installer.js";
import { eventually, isolatedBrowser } from "./helpers/gap-browser.js";

const exec = promisify(execFile);
const archive = process.env.CODEX_IDE_ARM64_TEST_ARCHIVE;
const vsix = process.env.CODEX_IDE_ARM64_TEST_VSIX;

test("Linux ARM64 activates the pinned IDE, installs an extension and opens its workspace in Chrome", {
  skip: !archive || !vsix || !process.env.CODEX_CHROME_TEST_BIN, timeout: 240000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-arm64-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const docker = async (...args: string[]) => (await exec("docker", args, { timeout: 120000 })).stdout.trim();
  const id = await docker("run", "--rm", "--detach", "--pull=never", "--platform=linux/arm64",
    "--user", "node:node", "--cap-drop=ALL", "--security-opt=no-new-privileges", "-e", "HOME=/tmp/arm-home",
    "--publish", "127.0.0.1::8080", "node:22-bookworm", "sleep", "360");
  assert.match(id, /^[a-f0-9]{64}$/);
  t.after(() => docker("rm", "-f", id));
  const inside = (...args: string[]) => docker("exec", id, ...args);
  await inside("mkdir", "-m", "700", "/tmp/arm-home", "/tmp/workspace");
  await inside("touch", "/tmp/workspace/README.md");
  const io = new ProcessIDEInstallerIO(root, undefined, async (host, script, input) => {
    assert.equal(host, "arm64-test");
    return { command: "docker", args: ["exec", "-i", id, "node", "-e", script, Buffer.from(JSON.stringify(input)).toString("base64")] };
  });
  const signal = AbortSignal.timeout(210000);
  const probe = await io.probe("arm64-test", "code-server", signal);
  assert.deepEqual([probe.platform, probe.arch, probe.binary], ["linux", "arm64", undefined]);
  assert.match(probe.glibc ?? "", /^2\.\d+$/);
  const asset = codeServerAsset(probe.platform, probe.arch);
  const stage = await io.prepare("arm64-test", signal);
  const invalid = path.join(root, "incomplete.tgz");
  fs.writeFileSync(invalid, "incomplete");
  await io.upload("arm64-test", stage, invalid, signal);
  await assert.rejects(io.activate("arm64-test", stage, asset, signal));
  assert.equal((await io.probe("arm64-test", "code-server", signal)).binary, undefined);
  await io.upload("arm64-test", stage, archive!, signal);
  const binary = await io.activate("arm64-test", stage, asset, signal);
  assert.equal((await io.probe("arm64-test", binary, signal)).binary, binary);
  const profile = ["--user-data-dir", "/tmp/user-data", "--extensions-dir", "/tmp/extensions"];
  await docker("cp", vsix!, id + ":/tmp/emacs.vsix");
  await inside(binary, ...profile, "--install-extension", "/tmp/emacs.vsix");
  assert.match(await inside(binary, ...profile, "--list-extensions", "--show-versions"), /tuttieee\.emacs-mcx@/i);
  await docker("exec", "-d", id, binary, ...profile, "--auth", "none", "--bind-addr", "0.0.0.0:8080", "/tmp/workspace");
  const published = await docker("port", id, "8080/tcp");
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  const url = "http://" + published;
  await eventually(async () => {
    try { return (await fetch(url + "/healthz", { signal: AbortSignal.timeout(1500) })).ok; }
    catch { return false; }
  }, "ARM64 workbench did not start", 30000);
  const browser = await isolatedBrowser(t, root);
  await browser.call("Page.navigate", { url: url + "/?folder=/tmp/workspace" });
  await eventually(async () => {
    try { return await browser.evaluate("Boolean(document.querySelector('.monaco-workbench')) && document.body.innerText.includes('README.md')"); }
    catch { return false; }
  }, "workspace file did not appear in ARM64 workbench", 45000);
  t.diagnostic(`Linux ${probe.arch}, glibc ${probe.glibc}, code-server ${asset.version}, verified managed binary and workspace file`);
});
