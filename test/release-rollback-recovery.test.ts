import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Run the actual release command against disposable artifacts. Every process,
// Git, launchd and HTTP boundary is synthetic; none can reach the live service.
for (const scenario of ["success", "rollback", "changed-owner", "restored-offline"]) {
  test(`actual release switch preserves admission ownership through ${scenario}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-rollback-audit-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "repo"), state = path.join(root, "state"), stage = path.join(root, "stage");
    for (const dir of [path.join(repo, "scripts"), path.join(repo, "dist"), path.join(state, "runtime"), path.join(stage, "dist")]) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync("scripts/release-local.mjs", path.join(repo, "scripts/release-local.mjs"));
    fs.writeFileSync(path.join(repo, "fixture.txt"), "fixture source");
    fs.writeFileSync(path.join(repo, "dist", "artifact.txt"), "old artifact");
    fs.writeFileSync(path.join(stage, "dist", "artifact.txt"), "new artifact");
    const module = await import(pathToFileURL(path.join(repo, "scripts/release-local.mjs")).href);
    const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
    const commit = "a".repeat(40), source = hash(`fixture.txt\0${hash("fixture source")}`);
    const manifest = { status: "sealed", commit, source, previousPid: 111,
      previous: module.treeHash(path.join(repo, "dist")), compiled: module.treeHash(path.join(stage, "dist")) };
    fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest));
    const gate = path.join(state, "release-admission.json");
    let generation = 0, owner: string | undefined, cancels = 0;
    const operations: string[] = [];
    const currentPid = () => [111, 222, 333][generation];
    t.mock.method(childProcess, "execFileSync", (bin: string, args: string[]) => {
      if (bin === "git") {
        if (args[0] === "diff") return "";
        if (args[0] === "ls-files") return args.includes("--others") ? "" : "fixture.txt\0";
      }
      if (bin === "/bin/launchctl") {
        if (args[0] === "print") return `pid = ${currentPid()}\n`;
        if (args[0] === "bootout") { operations.push(`stop:${currentPid()}`); return ""; }
        if (args[0] === "bootstrap") { generation++; operations.push(`start:${currentPid()}`); return ""; }
      }
      throw Error(`Unexpected isolated command: ${bin} ${args.join(" ")}`);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    t.mock.method(process, "kill", (pid: number) => {
      assert.ok(pid === 111 || pid === 222, `unexpected process probe ${pid}`);
      throw Object.assign(Error("synthetic exited process"), { code: "ESRCH" });
    });
    let clock = 0;
    t.mock.method(Date, "now", () => clock += 5000);
    const timeout = setTimeout;
    t.mock.method(globalThis, "setTimeout", ((callback: () => void) => timeout(callback, 0)) as any);
    t.mock.method(globalThis, "fetch", async (url: URL, init?: RequestInit) => {
      assert.equal(url.origin, "http://127.0.0.1:12345");
      if (generation === 2 && scenario === "restored-offline") throw Error("synthetic restored service offline");
      switch (url.pathname) {
        case "/api/request-context": return Response.json({ requestToken: `process-${currentPid()}` });
        case "/api/release/prepare":
          owner = JSON.parse(init!.body as string).id;
          fs.writeFileSync(gate, JSON.stringify({ version: 1, id: owner }));
          return Response.json({ id: owner, pid: currentPid(), prepared: true });
        case "/api/release/status": return Response.json({ pid: currentPid(), prepared: Boolean(owner),
          id: generation === 2 && scenario === "changed-owner" ? crypto.randomUUID() : owner });
        case "/api/release/cancel":
          assert.equal(JSON.parse(init!.body as string).id, owner);
          assert.equal((init!.headers as Record<string, string>)["X-Codex-Im-Gateway-Token"], `process-${currentPid()}`);
          operations.push(`reopen:${currentPid()}`); cancels++; owner = undefined; fs.unlinkSync(gate);
          return Response.json({ released: true });
        case "/api/accounts": return Response.json({ accounts: [] });
        case "/api/ide": return Response.json({ running: false, authorization: { sessionTtlDays: 90 }, endpoints: [] });
        case "/api/sessions": return Response.json({ sessions: [] });
        case "/api/build": return Response.json({ build: generation === 1 && scenario === "success" ? { commit, sourceHash: source } : { commit: "b".repeat(40), sourceHash: "c".repeat(64) } });
        default: throw Error(`Unexpected isolated route: ${url.pathname}`);
      }
    });
    const run = module.main(["switch", "--dir", stage, "--state", state, "--origin", "http://127.0.0.1:12345", "--service", "gui/501/audit.fixture", "--plist", path.join(root, "synthetic.plist")]);
    if (scenario === "success") {
      await run;
      assert.deepEqual(operations, ["stop:111", "start:222", "reopen:222"]);
      assert.equal(fs.readFileSync(path.join(repo, "dist", "artifact.txt"), "utf8"), "new artifact");
    } else {
      await assert.rejects(run, /readiness|rollback|restor/i);
      assert.equal(fs.readFileSync(path.join(repo, "dist", "artifact.txt"), "utf8"), "old artifact");
      assert.deepEqual(operations.slice(0, 4), ["stop:111", "start:222", "stop:222", "start:333"]);
    }
    if (scenario === "success" || scenario === "rollback") {
      assert.equal(fs.existsSync(gate), false, "restored service must not retain a dead release owner's admission freeze");
      assert.equal(cancels, 1);
    } else {
      assert.equal(fs.existsSync(gate), true, "changed owner or offline recovery cannot be reopened blindly");
      assert.equal(cancels, 0);
    }
  });
}
