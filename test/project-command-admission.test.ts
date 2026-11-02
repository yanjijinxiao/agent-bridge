import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-project-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const replies: string[] = [];
  let writable = true;
  const service = new BridgeService({ stateStore: store,
    config: { ...defaultConfig(root), allowedSenderIds: ["actor"] },
    modeSettings: { defaultMode: "session", enabledModes: ["session", "task", "qa"] },
    assertRuntimeWritable() { if (!writable) throw Error("account runtime retired"); },
    weixin: { async sendText(input) { replies.push(input.text); return { messageId: "sent" }; } },
    runner: {} as never
  });
  return { store, replies, service, retire() { writable = false; }, send(text: string) {
    return service.handleMessage({ id: text, senderId: "actor", text, raw: {} });
  } };
}

for (const command of ["/task list", "/qa", "/mode session"]) {
  test(`${command}: no selected project must not activate the first registered project`, async t => {
    const f = fixture(t);
    f.store.createProject("First registered", "/tmp/first-project");
    f.store.createProject("Second registered", "/tmp/second-project");
    await f.send(command);
    assert.equal(f.store.getActiveProject("actor"), undefined);
    assert.equal(f.store.listSessions().length, 0);
    assert.match(f.replies.at(-1)!, /选择项目|绑定.*项目|添加.*项目/);
  });
}

test("standalone new rechecks the retired account runtime before allocating or binding", async t => {
  const f = fixture(t);
  const pending = f.send("/new --standalone");
  // The source was valid at entry, then retired during reference preparation.
  f.retire();
  await assert.rejects(pending, /runtime retired/);
  assert.equal(f.store.listSessions().length, 0);
  assert.equal(fs.existsSync(f.store.standaloneWorkspacesDir), false);
});
