import assert from "node:assert/strict";
import test from "node:test";
import { UpdateManager } from "../src/server/update-manager.js";

test("registry response byte limits cancel during reading, before consuming a whole oversized body", async () => {
  const streams: Array<{ pulled: number; cancelled: boolean }> = [];
  const manager = new UpdateManager({ packageRoot: "/fixture/node_modules/codex-im-gateway", currentVersion: "1.2.3",
    fetch: async () => {
      const state = { pulled: 0, cancelled: false }; streams.push(state);
      return new Response(new ReadableStream({
        pull(controller) {
          if (state.pulled++ === 8) { controller.close(); return; }
          controller.enqueue(new TextEncoder().encode(state.pulled === 1 ? '{"version":"1.2.4"}' : " ".repeat(32768)));
        }, cancel() { state.cancelled = true; }
      }));
    }
  });
  assert.equal((await manager.check()).error, "无法检查新版本");
  assert.equal(streams.length, 2);
  for (const state of streams) { assert.equal(state.cancelled, true); assert.ok(state.pulled < 8); }
});

test("registry deadline remains finite when an injected transport ignores abort", async () => {
  const manager = new UpdateManager({ packageRoot: "/fixture/node_modules/codex-im-gateway", currentVersion: "1.2.3",
    checkTimeoutMs: 20, fetch: () => new Promise(() => {}) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([manager.check(), new Promise(resolve => { timer = setTimeout(() => resolve("still waiting"), 300); })]);
    assert.notEqual(status, "still waiting");
    assert.equal((status as { error?: string }).error, "无法检查新版本");
  } finally { if (timer) clearTimeout(timer); }
});
