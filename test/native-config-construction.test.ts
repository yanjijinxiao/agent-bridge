import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { loadConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { APP_SERVER_SOCKET_RELAY } from "../src/codex/app-server-socket-relay.js";
import { sharedNativeCore, message, until } from "./fixtures/shared-native-core.mjs";

for (const legacy of ["auto", "exec"] as const) test(`NATIVE-01.3: migrated ${legacy} constructs one native adapter for writes and read views`, {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN || process.platform === "win32", timeout: 30000
}, async t => {
  const release = Promise.withResolvers<void>(); t.after(() => release.resolve());
  const f = await sharedNativeCore(t, async (_body: unknown, n: number) => { if (n === 2) await release.promise; return message(`CONFIG_${n}`, n); }), stateRoot = path.join(f.root, "gateway-state"); fs.mkdirSync(stateRoot);
  const paths = resolveStatePaths(stateRoot), wrapper = path.join(f.root, "codex-stdio-peer"), log = path.join(f.root, "launches.jsonl");
  // Exercise the public constructor, not its injected appServerBackend seam.
  // The explicit test executable relays native JSONL to the isolated core.
  fs.writeFileSync(wrapper, `#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({event:'start',pid:process.pid,args:process.argv.slice(2)})+'\\n');
if(process.argv[2]!=='app-server')process.exit(13);
const c=spawn(process.execPath,['-e',${JSON.stringify(APP_SERVER_SOCKET_RELAY)},${JSON.stringify(f.endpoint)}],{stdio:'inherit'});
c.on('exit',code=>{fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({event:'end',pid:process.pid})+'\\n');process.exit(code??1);});process.on('SIGTERM',()=>c.kill());`, { mode: 0o700 });
  fs.writeFileSync(paths.configPath, JSON.stringify({ codexBackend: legacy, codexAppServerTransport: "stdio",
    codexBin: wrapper, codexExecSandbox: "workspace-write", allowedSenderIds: ["original-user"] }));
  const config = loadConfig(paths);
  const gateway = new CodexAppServerGateway({ backend: config.codexBackend, codexBin: config.codexBin,
    appServerTransport: config.codexAppServerTransport, execSandbox: config.codexExecSandbox, codexHome: f.root, timeoutMs: 5000 });
  t.after(() => gateway.close());
  const first = await gateway.run({ cwd: f.root, prompt: "first", clientUserMessageId: "first" });
  const status = await gateway.inspectThread(first.threadId);
  assert.equal(status.threadId, first.threadId);
  await gateway.getRuntimeInfo(f.root, first.threadId);
  assert.equal((await gateway.getHistory(first.threadId)).filter(row => row.clientUserMessageId === "first").length, 1);
  const second = gateway.run({ cwd: f.root, threadId: first.threadId, prompt: "continue", clientUserMessageId: "second" });
  await until(() => f.calls.length === 2);
  const beforeReads = fs.readFileSync(log, "utf8");
  await Promise.all([gateway.inspectThread(first.threadId), gateway.getRuntimeInfo(f.root, first.threadId), gateway.getHistory(first.threadId)]);
  assert.equal(fs.readFileSync(log, "utf8"), beforeReads, "active read views share the write adapter connection");
  release.resolve(); await second;
  assert.equal((await gateway.getHistory(first.threadId)).filter(row => row.clientUserMessageId === "second").length, 1);
  const launches = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const live = new Set<number>();
  for (const event of launches) {
    if (event.event === "start") { live.add(event.pid); assert.equal(event.args[0], "app-server"); assert.equal(live.size, 1); }
    else live.delete(event.pid);
  }
  // Idle stdio retirement deliberately releases its thread writer lock; later
  // reads may reconnect sequentially. That is not a second business adapter.
  assert.equal(f.calls.length, 2);
  assert.equal(config.codexExecSandbox, "workspace-write"); assert.deepEqual(config.allowedSenderIds, ["original-user"]);
});
