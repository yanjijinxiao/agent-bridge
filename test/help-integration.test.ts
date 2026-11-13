import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import type { ChannelActionCard } from "../src/channels/action-card.js";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

for (const channel of ["dingtalk", "weixin", "feishu", "wecom"] as const) for (const native of [false, true]) {
  test(`HELP-08: ${channel} ${native ? "cards" : "text"} help is read-only, filtered and navigable`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-help-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new RuntimeStateStore(resolveStatePaths(root));
    const project = store.createProject("fixture", root);
    store.activateProject("actor", project.id);
    const session = store.createSession("actor", root, "fixture", project.id);
    store.setSessionThread(session.id, "native");
    const texts: string[] = [], cards: ChannelActionCard[] = [];
    let reads = 0, writes = 0;
    const service = new BridgeService({ stateStore: store,
      config: { ...defaultConfig(root), allowedSenderIds: ["actor"] },
      modeSettings: { defaultMode: "session", enabledModes: ["session"] },
      channel: createChannelClient(channel, { ...TEXT_CAPABILITIES, actions: native ? "available" : "not-implemented" }, {
        async sendText({ text }) { texts.push(text); return { messageId: "text" }; },
        async sendActionCard({ card }) { cards.push(card); return { messageId: "card" }; }
      }),
      runner: { backendInfo: () => ({ id: "app-server", capabilities: { ...APP_SERVER_BACKEND_CAPABILITIES, models: false } }),
        async inspectThread() { reads++; throw Error("help must not inspect a native writer"); },
        async run() { writes++; throw Error("help must not execute"); },
        async stop() { writes++; }, async updateThreadSettings() { writes++; }
      } as never });
    t.after(() => service.suspendUserInputs());
    const before = { session: store.getActiveSession("actor")?.id, project: store.getActiveProject("actor")?.id,
      mode: store.getInteractionMode("actor") };
    const send = async (text: string) => {
      texts.length = 0; cards.length = 0;
      await service.handleMessage({ id: text, senderId: "actor", text, raw: {} });
      return native ? cards[0].body : texts.join("\n");
    };
    const home = await send("/help");
    assert.match(home, /常用命令/); assert.doesNotMatch(home, /^\/model\b|^\/task\b|^\/follow\b/m);
    if (native) {
      assert.ok(cards[0].actionGroups.flat().some(action => action.value.command === "help" && action.value.arg === "all"));
      assert.ok(!cards[0].actionGroups.flat().some(action => ["model", "task", "plan", "stop"].includes(action.value.command)));
    } else assert.match(home, /```text\n\/help all\n```/);
    const all = await send("/help all");
    assert.match(all, /^\/model[^\n]*【当前后端不支持】/m);
    assert.match(all, /^\/task[^\n]*【当前渠道未启用 task 模式】/m);
    assert.match(all, /^\/leave\b/m);
    const workflow = await send("/help workflow");
    assert.doesNotMatch(workflow, /^\/(qa|task)\b/m);
    const single = await send("/help /session");
    assert.match(single, /^\/session\b/m); assert.doesNotMatch(single, /^\/follow\b/m);
    const ide = await send("/help ide");
    assert.match(ide, /兼容核对流程/);
    assert.equal(reads, 0); assert.equal(writes, 0);
    assert.deepEqual({ session: store.getActiveSession("actor")?.id, project: store.getActiveProject("actor")?.id,
      mode: store.getInteractionMode("actor") }, before);
  });
}

test("HELP-08: unbound help reads the selected Connector capability rather than the local default", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-help-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const principal = { accountId: "fixture", actorId: "actor", conversationId: "room" };
  const host = "peer:selected:codex";
  store.setConnectorSelection(principal, host);
  const seen: Array<string | undefined> = [], texts: string[] = [];
  const service = new BridgeService({ accountId: principal.accountId, stateStore: store,
    config: { ...defaultConfig(root), allowedSenderIds: ["actor"] },
    channel: createChannelClient("dingtalk", TEXT_CAPABILITIES, {
      async sendText({ text }) { texts.push(text); return { messageId: "text" }; }
    }),
    peer: { hosts: () => [host], label: () => "fixture", isOnline: () => true, async connect() { throw Error("not pairing"); } },
    runner: { backendInfo(actual?: string) { seen.push(actual); return { id: "app-server",
      capabilities: { ...APP_SERVER_BACKEND_CAPABILITIES, models: actual !== host } }; } } as never });
  t.after(() => service.suspendUserInputs());
  await service.handleMessage({ id: "help", senderId: "actor", replyTargetId: "room", conversationKind: "group", text: "/help", raw: {} });
  assert.ok(seen.length > 0); assert.ok(seen.every(actual => actual === host));
  assert.doesNotMatch(texts.join("\n"), /^\/model\b/m);
  assert.equal(store.getActiveSession("room"), undefined);
  assert.equal(store.getConnectorSelection(principal)?.hostId, host);
});
