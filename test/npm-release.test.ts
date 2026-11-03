import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { activateNpmRelease, confirmNpmRelease, createNpmReleaseDirectory, npmCandidateRoot, readNpmRelease,
  rollbackNpmRelease, runtimeVersion, sealNpmRelease } from "../src/server/npm-release.js";

function fixture(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "npm-release-"))), target = path.join(root, "node_modules", "codex-im-gateway");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writeRuntime = (dir: string, version: string, body = "export {};\n") => {
    fs.mkdirSync(path.join(dir, "dist", "server"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version, type: "module" }));
    fs.writeFileSync(path.join(dir, "dist", "server", "index.js"), body);
    fs.mkdirSync(path.join(dir, "node_modules", "dependency"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "dependency", "version"), version);
  };
  writeRuntime(target, "1.0.0");
  const stage = createNpmReleaseDirectory(target), candidate = npmCandidateRoot(stage);
  writeRuntime(candidate, "1.1.0");
  return { root, target, stage, candidate, writeRuntime, seal: () => sealNpmRelease(stage, target, "1.1.0") };
}

test("npm release prepares isolated dependencies, activates, confirms and rolls back program bytes only", t => {
  const f = fixture(t), state = path.join(f.root, "user-state.json");
  fs.writeFileSync(state, "initial receipt");
  const plan = f.seal(); assert.equal(runtimeVersion(f.target), "1.0.0");
  activateNpmRelease(plan); assert.equal(runtimeVersion(f.target), "1.1.0");
  assert.equal(fs.readFileSync(path.join(f.target, "node_modules", "dependency", "version"), "utf8"), "1.1.0");
  confirmNpmRelease(plan); assert.equal(readNpmRelease(plan).phase, "verified");
  fs.writeFileSync(state, "new receipt plus revoked permission");
  rollbackNpmRelease(plan); rollbackNpmRelease(plan);
  assert.equal(runtimeVersion(f.target), "1.0.0"); assert.equal(readNpmRelease(plan).phase, "rolled-back");
  assert.equal(fs.readFileSync(state, "utf8"), "new receipt plus revoked permission");
  assert.equal(runtimeVersion(path.join(f.stage, "failed-package")), "1.1.0");
});

for (const boundary of ["backup", "activation"] as const) test(`npm release recovers the rename before its phase receipt (${boundary})`, t => {
  const f = fixture(t), plan = f.seal(), original = fs.renameSync;
  let injected = false;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    original(from, to);
    if (!injected && String(from) === (boundary === "backup" ? f.target : f.candidate)) { injected = true; throw Error("isolated lost phase receipt"); }
  });
  assert.throws(() => activateNpmRelease(plan), /lost phase/); t.mock.restoreAll();
  activateNpmRelease(plan); assert.equal(runtimeVersion(f.target), "1.1.0");
  assert.equal(runtimeVersion(readNpmRelease(plan).backup), "1.0.0");
  rollbackNpmRelease(plan); assert.equal(runtimeVersion(f.target), "1.0.0");
});

for (const change of ["candidate", "live", "external-link"] as const) test(`npm release refuses changed ${change} before replacing the original`, t => {
  const f = fixture(t);
  if (change === "external-link") {
    fs.symlinkSync(f.target, path.join(f.candidate, "external"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => f.seal(), /external symlink/);
  } else {
    const plan = f.seal();
    fs.appendFileSync(path.join(change === "candidate" ? f.candidate : f.target, "dist", "server", "index.js"), "// changed\n");
    assert.throws(() => activateNpmRelease(plan), /changed after/);
  }
  assert.equal(runtimeVersion(f.target), "1.0.0");
});

test("npm activation failure restores the original without deleting the prepared candidate", t => {
  const f = fixture(t), plan = f.seal(), original = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === f.candidate) throw Object.assign(Error("isolated busy directory"), { code: "EBUSY" });
    original(from, to);
  });
  assert.throws(() => activateNpmRelease(plan), /busy/); t.mock.restoreAll();
  rollbackNpmRelease(plan);
  assert.equal(runtimeVersion(f.target), "1.0.0"); assert.equal(runtimeVersion(f.candidate), "1.1.0");
});

for (const healthy of [true, false]) test(`real npm restart helper activates or restores the runtime after health confirmation (${healthy})`, { timeout: 20000 }, async t => {
  const f = fixture(t), log = path.join(f.root, "restart.log"), pids = path.join(f.root, "pids.jsonl"), state = path.join(f.root, "receipts.txt");
  fs.writeFileSync(state, "existing-receipt\n");
  const socket = net.createServer(); await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(r => socket.close(() => r()));
  const script = (version: string) => `import fs from 'node:fs';import http from 'node:http';
fs.appendFileSync(${JSON.stringify(pids)},JSON.stringify({pid:process.pid,version:${JSON.stringify(version)}})+'\\n');
fs.appendFileSync(${JSON.stringify(state)},${JSON.stringify(version)}+'\\n');
http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({product:'codex-im-gateway',version:${JSON.stringify(version)},pid:process.pid}));}).listen(${port},'127.0.0.1');`;
  f.writeRuntime(f.target, "1.0.0", script("1.0.0")); f.writeRuntime(f.candidate, "1.1.0", healthy ? script("1.1.0") : "throw Error('isolated candidate startup failure');");
  const plan = f.seal(), parent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  t.after(() => parent.kill());
  const helper = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/server/restart-helper.ts", import.meta.url)),
    String(parent.pid), path.join(f.target, "dist", "server", "index.js"), log, plan, String(port)], { stdio: "ignore" });
  const stopped = new Promise<number | null>((resolve, reject) => { helper.once("exit", resolve); helper.once("error", reject); });
  t.after(async () => {
    helper.kill();
    if (fs.existsSync(pids)) for (const line of fs.readFileSync(pids, "utf8").trim().split("\n")) {
      try { process.kill(JSON.parse(line).pid); } catch {}
    }
  });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(runtimeVersion(f.target), "1.0.0", "the running parent must exit before activation");
  parent.kill();
  assert.equal(await stopped, healthy ? 0 : 1);
  assert.equal(readNpmRelease(plan).phase, healthy ? "verified" : "rolled-back");
  const response = await (await fetch(`http://127.0.0.1:${port}/api/build`)).json();
  assert.equal(response.version, healthy ? "1.1.0" : "1.0.0");
  assert.ok(fs.readFileSync(state, "utf8").startsWith("existing-receipt\n"));
});
