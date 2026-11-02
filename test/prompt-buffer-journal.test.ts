import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PromptBuffer } from "../src/bridge/prompt-buffer.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-buffer-journal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "buffers.json");
  const create = (now = 0) => new PromptBuffer({ maxItems: 2, ttlMs: 10, filePath, now: () => now });
  return { filePath, create };
}

test("buffer append is atomic, source-deduplicated and isolated by binding scope", t => {
  const f = fixture(t), buffer = f.create();
  buffer.start("room", "old-binding");
  buffer.appendBatch("room", [{ kind: "text", text: "one" }], "source", "old-binding");
  buffer.appendBatch("room", [{ kind: "text", text: "one" }], "source", "old-binding");
  assert.throws(() => buffer.appendBatch("room", [{ kind: "text", text: "two" }, { kind: "text", text: "three" }]), /too many/);
  assert.throws(() => buffer.begin("room", "new-binding"), /先前的会话/);
  assert.deepEqual(f.create().begin("room", "old-binding")?.items, [{ kind: "text", text: "one" }]);
});

test("restart releases preparation but preserves attempted submissions even beyond collecting TTL", t => {
  const f = fixture(t);
  let buffer = f.create(); buffer.start("room", "binding"); buffer.append("room", { kind: "text", text: "saved" });
  assert.ok(buffer.begin("room", "binding"));
  buffer = f.create(); const batch = buffer.begin("room", "binding")!;
  assert.equal(batch.items.length, 1); buffer.submitting("room", batch.id);
  buffer = f.create(100);
  assert.equal(buffer.isActive("room"), true);
  assert.throws(() => buffer.begin("room", "binding"), /回执尚未确认/);
  buffer.cancel("room"); assert.equal(f.create().isActive("room"), false);
});

test("a failed durable append does not mutate the in-memory accepted contents", t => {
  const f = fixture(t), buffer = f.create();
  buffer.start("room", "binding"); buffer.append("room", { kind: "text", text: "saved" });
  const original = fs.readFileSync(f.filePath);
  fs.rmSync(f.filePath); fs.mkdirSync(f.filePath);
  assert.throws(() => buffer.append("room", { kind: "text", text: "not saved" }));
  fs.rmdirSync(f.filePath); fs.writeFileSync(f.filePath, original);
  assert.deepEqual(buffer.begin("room", "binding")?.items, [{ kind: "text", text: "saved" }]);
});

test("a malformed or duplicate-key journal is preserved instead of silently reset", t => {
  const f = fixture(t);
  for (const body of ["{}", '{"version":1,"buffers":[["room",{}]]}']) {
    fs.writeFileSync(f.filePath, body);
    assert.throws(() => f.create(), /Invalid prompt buffer journal/);
    assert.equal(fs.readFileSync(f.filePath, "utf8"), body);
  }
  const buffer = (fs.rmSync(f.filePath), f.create()); buffer.start("room");
  const saved = JSON.parse(fs.readFileSync(f.filePath, "utf8")); saved.buffers.push(saved.buffers[0]);
  const body = JSON.stringify(saved); fs.writeFileSync(f.filePath, body);
  assert.throws(() => f.create(), /Invalid prompt buffer journal/);
  assert.equal(fs.readFileSync(f.filePath, "utf8"), body);
});
