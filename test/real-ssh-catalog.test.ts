import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";

const remote = process.env.CODEX_SSH_CATALOG_TEST_TARGET;
const exec = promisify(execFile);
test("native project and thread catalog failures on SSH disconnect cannot return a local catalog", {
  skip: !remote, timeout: 90000,
}, async t => {
  const { args, target, binary } = JSON.parse(remote!) as { args: string[]; target: string; binary: string };
  assert.match(binary, /^\/[a-zA-Z0-9/_.-]+$/);
  const directory = (await exec("ssh", [...args, target, "mktemp -d /tmp/ab-catalog-XXXXXXXX"])).stdout.trim();
  assert.match(directory, /^\/tmp\/ab-catalog-[a-zA-Z0-9]{8}$/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ab-catalog-"));
  const socket = path.join(root, "mux");
  const control = [...args, "-S", socket];
  const master = () => exec("ssh", [...control, "-o", "ControlPersist=no", "-fMN", target]);
  const disconnect = () => exec("ssh", [...control, "-O", "exit", target]);
  let connected = false;
  let localReads = 0;
  const local = () => { localReads++; throw Error("unexpected local catalog"); };
  const runner = new CodexAppServerGateway({ appServerBackend: { listProjects: local, listThreads: local, listSessionCatalog: local, close() {} } as never,
    timeoutMs: 3000, remoteTransportResolver() {
      // After we close this dedicated master, even an automatic SSH retry
      // cannot open an unrelated connection to the real machine.
      return { command: "ssh", args: [...control, "-o", "ProxyCommand=false", target,
        `exec env CODEX_HOME='${directory}' '${binary}' app-server`] };
    } });
  t.after(async () => {
    try { await runner.close(); }
    finally {
      try { if (connected) await disconnect(); }
      finally {
        try { await exec("ssh", [...args, target, `rm -rf -- '${directory}'`]); }
        finally { fs.rmSync(root, { recursive: true, force: true }); }
      }
    }
  });
  await master(); connected = true;
  const host = "isolated-ssh";
  assert.equal((await runner.listProjects(host)).projects.length, 0);
  assert.deepEqual(await runner.listThreads({}, host), []);
  await disconnect(); connected = false;
  for (const read of [() => runner.listProjects(host), () => runner.listThreads({}, host), () => runner.listSessionCatalog({}, host)]) {
    await assert.rejects(read);
  }
  assert.equal(localReads, 0);
  await master(); connected = true;
  assert.deepEqual(await runner.listThreads({}, host), []);
  assert.equal((await runner.listProjects(host)).projects.length, 0);
});
