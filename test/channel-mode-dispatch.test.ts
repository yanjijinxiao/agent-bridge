import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

for (const channel of ["weixin", "dingtalk", "feishu", "wecom"] as const) {
  for (const mode of ["session", "task", "qa"] as const) {
    test(`${channel} routes plain input, explicit help and an installed extension independently in ${mode} mode`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mode-dispatch-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const store = new RuntimeStateStore(resolveStatePaths(root));
      const project = store.createProject("Project", root);
      const kb = store.createKnowledgeBase("Explicit documentation", path.join(root, "docs"));
      const session = store.createSession("actor", root, "Selected", project.id, mode === "qa" ? "qa" : "session", mode === "qa" ? kb.id : undefined);
      store.setSessionThread(session.id, "source-thread");
      store.setInteractionMode("actor", mode);
      const texts: string[] = [], prompts: string[] = [], tools: string[] = [];
      const service = new BridgeService({ stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: false },
        modeSettings: { defaultMode: mode, enabledModes: ["session", "task", "qa"], qaKnowledgeBaseId: kb.id },
        channel: createChannelClient(channel, TEXT_CAPABILITIES, { async sendText({ text }) { texts.push(text); return { messageId: "sent" }; } }),
        channelCapabilities: async () => [{ id: "test", commandName: "example", helpLine: "/example - fixture",
          aliases: {}, aiActions: [], resolve: arg => ({ kind: "reply", text: "extension/" + arg }) }],
        runner: {
          async inspectThread() { return { threadId: "source-thread", persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
          async run(input: { threadId: string; prompt: string; dynamicTools?: { name: string }[] }) {
            assert.equal(input.threadId, "source-thread"); prompts.push(input.prompt);
            tools.push(...(input.dynamicTools ?? []).map(tool => tool.name));
            return { threadId: input.threadId, turnId: "turn", text: "ordinary reply", raw: "" };
          },
        } as never,
      });
      const send = (id: string, text: string) => service.handleMessage({ id, text, senderId: "actor", raw: {} });
      await send("normal", "请解释 /example 在文档中的含义");
      assert.equal(prompts.length, 1); assert.ok(prompts[0].includes("请解释 /example 在文档中的含义"));
      assert.deepEqual(tools, mode === "qa" ? ["knowledge"] : []);
      await send("help", "/help"); assert.match(texts.at(-1)!, /Agent Bridge/);
      await send("extension", "/example literal"); assert.equal(texts.at(-1), "extension/literal");
      assert.equal(prompts.length, 1); assert.equal(store.getInteractionMode("actor"), mode);
    });
  }
}
