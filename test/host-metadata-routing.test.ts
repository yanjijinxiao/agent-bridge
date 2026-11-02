import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

test("model and account queries use the selected native host and never substitute the local account", async t => {
  const fixture = fileURLToPath(new URL("./fixtures/host-metadata-app-server.mjs", import.meta.url));
  const connected: string[] = [];
  const runner = new CodexAppServerGateway({ codexBin: fixture, timeoutMs: 2_000,
    remoteTransportResolver(host) { connected.push(host); return { command: process.execPath, args: [fixture, `--host=${host}`], label: host }; } });
  t.after(() => runner.close());
  // Passing through the public facade exercises protocol routing, not its maps.
  assert.equal((await runner.listModels("remote-a"))[0]?.model, "remote-a-model");
  assert.equal((await runner.getAccountRateLimits("remote-a")).primary?.usedPercent, 80);
  assert.equal((await runner.listModels())[0]?.model, "local-model");
  assert.equal((await runner.getAccountRateLimits()).primary?.usedPercent, 10);
  assert.equal((await runner.listModels("remote-b"))[0]?.model, "remote-b-model");
  await assert.rejects(runner.listModels("unavailable"), /Host unavailable/);
  await assert.rejects(runner.getAccountRateLimits("unavailable"), /Host unavailable/);
  assert.deepEqual(connected, ["remote-a", "remote-b", "unavailable"]);
});

for (const callbacks of [false, true]) test(`IM model, effort and balance queries preserve the bound remote scope (callbacks=${callbacks})`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-model-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)); store.setPairedSenderIds(["actor"]);
  const project = store.createProject("Remote", "/srv/project", { hostId: "remote-a", projectKind: "remote" });
  const session = store.createSession("chat", "/srv/project", "Remote task", project.id); store.setSessionThread(session.id, "remote-thread");
  const modelCalls: unknown[] = [], balanceCalls: unknown[] = [], replies: string[] = [];
  const models = [{ model: "remote-model", displayName: "Remote", supportedEfforts: [{ effort: "high", description: "Deep" }] }];
  const service = new BridgeService({ config: defaultConfig(root), stateStore: store,
    channel: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText(input) { replies.push(input.text); return { messageId: "ack" }; } }),
    ...(callbacks ? {
      listCodexModels: async (scope: unknown) => { modelCalls.push(scope); return models; },
      getCodexBalance: async (host: unknown) => { balanceCalls.push(host); return { limitName: "Remote account" }; }
    } : {}),
    runner: {
      async listModels(host: unknown) { modelCalls.push(host); return models; },
      async getAccountRateLimits(host: unknown) { balanceCalls.push(host); return { limitName: "Remote account" }; },
      async getRuntimeInfo() { return { model: "remote-model", effort: "high" }; }
    } as never });
  t.after(() => service.suspendUserInputs());
  for (const command of ["/model", "/effort", "/balance"]) await service.handleMessage({ id: command, senderId: "actor", replyTargetId: "chat", text: command, attachments: [], raw: {} });
  const scope = { cwd: "/srv/project", threadId: "remote-thread", hostId: "remote-a" };
  assert.deepEqual(modelCalls, callbacks ? [scope, scope] : ["remote-a", "remote-a"]);
  assert.deepEqual(balanceCalls, ["remote-a"]);
  assert.match(replies.join("\n"), /Remote account/);
});

for (const command of ["/model", "/effort", "/balance"]) for (const change of ["rebind", "revoke"]) {
  test(`${command} cannot deliver an old account query after ${change}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-model-scope-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new RuntimeStateStore(resolveStatePaths(root)); store.setPairedSenderIds(["actor"]);
    const project = store.createProject("Remote", "/srv/project", { hostId: "remote-a", projectKind: "remote" });
    const first = store.createSession("chat", "/srv/project", "First", project.id);
    const second = store.createSession("chat", "/srv/project", "Second", project.id); store.activateSession(first.id);
    const gate = Promise.withResolvers<any>(), replies: string[] = [];
    const service = new BridgeService({ config: defaultConfig(root), stateStore: store,
      channel: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText(input) { replies.push(input.text); return { messageId: "ack" }; } }),
      listCodexModels: () => gate.promise, getCodexBalance: () => gate.promise,
      runner: { async getRuntimeInfo() { return {}; } } as never });
    t.after(() => service.suspendUserInputs());
    const result = service.handleMessage({ id: command, senderId: "actor", replyTargetId: "chat", text: command, attachments: [], raw: {} })
      .then(() => undefined, error => error);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (change === "rebind") store.activateSession(second.id); else store.setPairedSenderIds([]);
    gate.resolve(command === "/balance" ? { limitName: "Old private account" }
      : [{ model: "old-private-model", displayName: "Old private model", supportedEfforts: [] }]);
    assert.ok(await result, "a retired query must ask for a fresh action");
    assert.equal(replies.length, 0, "no old account/model result may be delivered");
  });
}
