import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import type { ChannelActionCard } from "../src/channels/action-card.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-checklist-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root)), cards: ChannelActionCard[] = [], texts: string[] = [];
  let inspections = 0, now = Date.now(), seq = 0;
  t.mock.method(Date, "now", () => now);
  const service = new BridgeService({ stateStore: store, config: { ...defaultConfig(root), allowedSenderIds: ["actor"] },
    listCodexProjects: () => ["first", "second"].map(projectId => ({ name: "Same name", projectId, hostId: "local",
      workspace: root, rootPaths: [root], lastUsedAt: "", sessionCount: 0 })),
    weixin: { async sendText(x) { texts.push(x.text); return { messageId: "m" }; }, async sendActionCard(x) { cards.push(x.card); texts.push(x.card.fallbackText); return { messageId: "c" }; } },
    runner: { async listThreads() { return [{ threadId: "original", cwd: root, projectMembership: "none", persistence: "active", runtimeStatus: "idle", activeFlags: [] }]; },
      async inspectThread(threadId: string) { inspections++; return { threadId, cwd: root, projectMembership: "none", persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
      async getHistory() { return []; } } as never });
  t.after(() => service.suspendUserInputs());
  return { root, store, cards, texts, inspections: () => inspections, advance(ms: number) { now += ms; },
    send(text: string) { return service.handleMessage({ id: String(++seq), senderId: "actor", text, raw: {} }); } };
}

for (const command of ["/session R1", "/sessions r1", "/sessions detail R1", "/sessions next", "/sessions more", "/sessions page 2"]) {
  test(`CAT-02.2: expired snapshot rejects ${command} before inspection or rebinding`, async t => {
    const f = fixture(t); await f.send("/sessions"); f.advance(15 * 60000 + 1);
    await f.send(command); assert.match(f.texts.at(-1)!, /列表已过期/);
    assert.equal(f.inspections(), 0); assert.equal(f.store.getBoundSession("actor"), undefined);
    await f.send("/sessions"); await f.send("/session R1");
    assert.equal(f.store.getBoundSession("actor")?.threadId, "original"); assert.equal(f.inspections(), 1);
  });
}
test("CAT-02.2: versioned project button expires even without a newer list", async t => {
  const f = fixture(t); await f.send("/project"); const old = f.cards[0].actionGroups.flat()[0].value;
  f.advance(15 * 60000 + 1); await f.send(`/${old.command} ${old.arg}`);
  assert.match(f.texts.at(-1)!, /过期/); assert.equal(f.store.listProjects().length, 0);
  await f.send("/project"); const fresh = f.cards.at(-1)!.actionGroups.flat()[0].value;
  await f.send(`/${fresh.command} ${fresh.arg}`); assert.equal(f.store.getActiveProject("actor")?.sourceProjectId, "first");
});
test("CAT-02.3: same host, name and roots retain two exact native project identities through IM selection and reload", async t => {
  const f = fixture(t); await f.send("/project");
  const choices = f.cards[0].actionGroups.flat().map(a => a.value).filter(a => a.arg?.startsWith("C"));
  assert.equal(choices.length, 2);
  for (const a of choices) await f.send(`/${a.command} ${a.arg}`);
  const projects = f.store.listProjects(); assert.equal(projects.length, 2);
  assert.deepEqual(projects.map(p => p.sourceProjectId).sort(), ["first", "second"]);
  assert.equal(new Set(projects.map(p => p.id)).size, 2); assert.ok(projects.every(p => p.workspace === f.root));
  const reloaded = new RuntimeStateStore(resolveStatePaths(f.root)); assert.equal(reloaded.listProjects().length, 2);
  assert.equal(reloaded.getActiveProject("actor")?.sourceProjectId, "second");
  await f.send("/project Same name"); assert.match(f.texts.at(-1)!, /多个同名/);
  assert.equal(f.store.getActiveProject("actor")?.sourceProjectId, "second");
});
