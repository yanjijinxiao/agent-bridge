import assert from "node:assert/strict";
import test from "node:test";
import { peerFixture } from "./peer-fixture.js";
import { guardNativeWrite } from "../src/codex/write-guard.js";

for (const managedHost of [undefined, "local", "remote-ssh-discovered:test"]) {
  test(`native settings traverse the selected Connector with final source checks (${managedHost ?? "paired"})`, async t => {
    const f = await peerFixture(t, { managedHost, device: Boolean(managedHost) }); if (!managedHost) await f.bind();
    const host = managedHost ?? f.ticket.hostId;
    const seen: unknown[] = [];
    f.backend.updateThreadSettings = async (id, patch, _host, guard) => {
      return guardNativeWrite(guard, async () => { seen.push([id, patch]); return { model: patch.model }; });
    };
    const result = await f.as(() => f.facade.updateThreadSettings!(f.thread.threadId, { model: "native-choice" }, host, () => {}));
    assert.equal(result.model, "native-choice");
    assert.deepEqual(seen, [[f.thread.threadId, { model: "native-choice" }]]);
    assert.equal(f.runs.length, 0);
    await assert.rejects(f.as(() => f.facade.updateThreadSettings!("other-thread", { effort: "high" }, host, () => {})));
    assert.equal(seen.length, 1);
    const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let current = true;
    f.backend.updateThreadSettings = async (_id, _patch, _host, guard) => {
      ready.resolve(); await release.promise;
      return guardNativeWrite(guard, async () => { seen.push("unexpected"); return {}; });
    };
    const pending = f.as(() => f.facade.updateThreadSettings!(f.thread.threadId, { effort: "low" }, host, () => {
      if (!current) throw Error("source revoked");
    }));
    const rejected = assert.rejects(pending);
    await ready.promise; current = false; release.resolve(); await rejected;
    assert.equal(seen.length, 1);
  });
}

test("an older Connector backend rejects settings without saving a local substitute", async t => {
  const f = await peerFixture(t); await f.bind();
  delete f.backend.updateThreadSettings;
  await assert.rejects(f.as(() => f.facade.updateThreadSettings!(f.thread.threadId, { model: "chosen" }, f.ticket.hostId)), /升级 Connector/);
  assert.equal(f.runs.length, 0);
});
