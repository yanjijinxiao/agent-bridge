import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import type { CodexThreadSnapshot } from "../src/codex/backend.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";

for (const terminal of ["completed", "failed", "interrupted"] as const) for (const explicit of [false, true])
  test(`CTRL-03.5: conflicting active owner and ${terminal} history cannot finish follow (activeId=${explicit})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "follow-coherence-"));
    const filePath = path.join(root, "follow.json"), sent: string[] = [], applied: string[] = [];
    let snapshot: CodexThreadSnapshot = { state: { threadId: "thread", persistence: "active", runtimeStatus: "active",
      activeTurnId: "turn", activeFlags: [] }, turns: [{ id: "turn", status: "inProgress", messages: [] }] };
    const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "room", managed: false,
      client: createChannelClient("dingtalk", TEXT_CAPABILITIES, { async sendText(input) { sent.push(input.text); return { messageId: String(sent.length) }; } }) };
    const options = { filePath, subscriptions: () => [sub], backend: () => ({ async readThreadSnapshot() { return structuredClone(snapshot); } }),
      async applyResult(_sub: ThreadSubscription, _turn: string, text: string) { applied.push(text); return undefined; } };
    const hub = new ThreadEventHub(options);
    t.after(async () => { await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    await hub.refresh(); const before = sent.length;
    snapshot = { state: { ...snapshot.state, activeTurnId: explicit ? "turn" : undefined },
      turns: [{ id: "turn", status: terminal, messages: [{ id: "stale", role: "assistant", text: "STALE_TERMINAL" }] }] };
    const conflict = await hub.synchronize("binding");
    assert.equal(conflict.failure?.code, "unconfirmed"); assert.equal(sent.length, before); assert.equal(applied.length, 0);
    const pending = JSON.parse(fs.readFileSync(filePath, "utf8")).binding;
    assert.ok(!pending.completed.includes("turn")); assert.ok(!pending.checkpoint?.finished); assert.equal(pending.terminalPending, undefined);
    snapshot = { state: { ...snapshot.state, runtimeStatus: "active", activeTurnId: "turn" },
      turns: [{ id: "turn", status: "inProgress", messages: [] }] };
    await hub.refresh(); assert.ok(!JSON.parse(fs.readFileSync(filePath, "utf8")).binding.completed.includes("turn"));
    const result = 'GENUINE_RESULT\n```codex-im-gateway-actions\n{"remember":[{"kind":"knowledge","scope":"account","title":"source","content":"known"}]}\n```';
    snapshot = { state: { ...snapshot.state, runtimeStatus: "idle", activeTurnId: undefined },
      turns: [{ id: "turn", status: "completed", messages: [{ id: "result", role: "assistant", text: result }] }] };
    await hub.refresh(); await hub.refresh();
    assert.deepEqual(applied, [result]); assert.equal(sent.filter(text => text.includes("GENUINE_RESULT")).length, 1);
    assert.ok(!sent.some(text => text.includes("STALE_TERMINAL")));
    await hub.stop(); const restarted = new ThreadEventHub(options); t.after(() => restarted.stop()); await restarted.refresh();
    assert.deepEqual(applied, [result]); assert.equal(sent.filter(text => text.includes("GENUINE_RESULT")).length, 1);
  });
