import assert from "node:assert/strict";
import test from "node:test";
import { sharedNativeCore, message, until } from "./fixtures/shared-native-core.mjs";
import { buildPrompt, parsePrompt } from "../src/bridge/format.js";

for (const disconnect of ["none", "writers", "all-clients"] as const) {
  test(`CTRL-02.1: two real clients append concurrently and preserve native FIFO (${disconnect})`, {
    skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 40_000
  }, async t => {
    const release = Promise.withResolvers<void>(); t.after(() => release.resolve());
    const executionOrder: string[] = [];
    const core = await sharedNativeCore(t, async (body: any, n: number) => {
      if (n === 1) { await release.promise; return message("SEED_DONE", n); }
      // Read only the current native user input, not earlier matching history.
      const user = body.input.filter((x: any) => x.role === "user").at(-1);
      const text = JSON.stringify(user), marker = text.match(/QUEUE_CONCURRENT_[AB]_[01]/)?.[0];
      assert.ok(marker, "the actual model call has a known queued source");
      assert.ok(text.includes("bridge rule:")); executionOrder.push(marker);
      return message(`DONE_${marker}`, n);
    });
    const owner = core.runner(), a = core.runner(), b = core.runner(), inspector = await core.rpc("queue_concurrency");
    const corePid = (await inspector.request("server/diagnostics")).process.id;
    const thread = await owner.createThread({ cwd: core.root, projectBinding: "none" });
    const first = owner.run({ cwd: core.root, threadId: thread.threadId, prompt: "Hold concurrent queue owner", clientUserMessageId: "seed" });
    void first.catch(() => {}); await until(() => core.calls.length === 1);
    const inputs = ["A", "B"].flatMap(name => [0, 1].map(i => ({ name, marker: `QUEUE_CONCURRENT_${name}_${i}`, id: `source-${name}-${i}` })));
    const receipts = await Promise.all(inputs.map(input => (input.name === "A" ? a : b).addQueuedSubmission({
      threadId: thread.threadId, clientUserMessageId: input.id, prompt: buildPrompt(input.marker, [], input.name === "A" ? "DingTalk" : "WeChat")
    })));
    const pending = (await owner.listQueuedSubmissions(thread.threadId)).data;
    assert.equal(pending.length, 4); assert.equal(new Set(pending.map(x => x.id)).size, 4);
    assert.deepEqual(new Set(pending.map(x => x.clientUserMessageId)), new Set(inputs.map(x => x.id)));
    assert.deepEqual(new Set(pending.map(x => x.id)), new Set(receipts.map(x => x.id)));
    const order = pending.map(item => inputs.find(x => x.id === item.clientUserMessageId)!.marker);
    if (disconnect !== "none") { await a.close(); await b.close(); }
    if (disconnect === "all-clients") { await owner.close(); await assert.rejects(first); }
    const observer = core.runner();
    assert.deepEqual((await observer.listQueuedSubmissions(thread.threadId)).data.map(x => x.id), pending.map(x => x.id));
    assert.equal((await inspector.request("server/diagnostics")).process.id, corePid);
    release.resolve(); if (disconnect !== "all-clients") await first;
    await until(() => core.calls.length === 5, 20_000);
    let settled = false;
    for (let i = 0; i < 100 && !settled; i++) {
      const state = await observer.readThreadSnapshot(thread.threadId);
      settled = state.state.runtimeStatus === "idle" && state.turns.filter(x => x.status === "completed").length === 5;
      if (!settled) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(settled, "the same native owner completed every queued turn");
    assert.deepEqual(executionOrder, order, "concurrent arrival order is determined by native queue/list, not client wall clocks");
    const history = await observer.getHistory(thread.threadId);
    for (const input of inputs) {
      const accepted = history.filter(x => x.clientUserMessageId === input.id);
      assert.equal(accepted.length, 1); assert.equal(parsePrompt(accepted[0].text).text, input.marker);
      assert.equal(accepted[0].turnStatus, "completed");
    }
    assert.equal((await observer.listQueuedSubmissions(thread.threadId)).data.length, 0);
    assert.equal((await inspector.request("server/diagnostics")).process.id, corePid);
    assert.equal(core.calls.length, 5);
  });
}
