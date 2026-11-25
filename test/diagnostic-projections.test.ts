import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_SOCKET_RELAY } from "../src/codex/app-server-socket-relay.js";
import { AccountManager } from "../src/server/account-manager.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";

test("public account status keeps the monitor phase and removes credentials from adapter failures", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-diagnostics-"));
  const paths = resolveStatePaths(root);
  saveAccount(paths, { accountId: "fixture", userId: "user", token: "MARK_STORED", baseUrl: "https://example.test", enabled: true });
  const finish = Promise.withResolvers<void>();
  const manager = new AccountManager({ paths, configProvider: () => ({ ...defaultConfig(root), taskboardEnabled: false }),
    runnerFactory: () => ({ async warmUp() {}, close() {} }) as never,
    codexSessionMonitorFactory: () => ({ start() {}, stop() {} }) as never,
    codexDesktopRequestMonitorFactory: () => ({ start() {}, stop() {}, setFollowedThreads() {} }),
    adapterFactory: () => ({ client: createChannelClient("weixin", TEXT_CAPABILITIES, { async sendText() { return {}; } }),
      async monitor(options) {
        options.onStatus?.({ state: "error", detail: "upstream busy ticket=MARK_STATUS" });
        await finish.promise;
        throw Error("monitor ended apiKey=MARK_REJECTED");
      } })
  });
  const server = await startLocalHttpServer({ paths, accountManager: manager, port: 0 });
  t.after(async () => { finish.resolve(); await server.close(); await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  await manager.startAccount("fixture", false);
  const accounts = async () => {
    const response = await fetch(server.url + "/api/accounts");
    assert.equal(response.status, 200);
    return response.text();
  };
  const waiting = await accounts();
  assert.match(waiting, /upstream busy/);
  assert.doesNotMatch(waiting, /MARK_/);
  finish.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const ended = await accounts();
  assert.match(ended, /monitor ended/);
  assert.doesNotMatch(ended, /MARK_/);
});

test("the relay reports the upstream HTTP status without logging the supplied reason phrase", { skip: process.platform === "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-diag-"));
  const socketPath = path.join(root, "wire");
  const server = http.createServer();
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 503 ticket=MARK_RELAY\r\nContent-Length: 0\r\n\r\n"));
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const child = spawn(process.execPath, ["-e", APP_SERVER_SOCKET_RELAY, socketPath], { stdio: ["pipe", "ignore", "pipe"] });
  t.after(async () => { child.kill(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  assert.equal((await once(child, "exit"))[0], 1);
  assert.match(stderr, /503/);
  assert.doesNotMatch(stderr, /MARK_RELAY/);
});
