import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChannelStreamCheckpoint } from "../src/channels/progress.js";
import { compactArchivedSummaries } from "../src/server/follow-checkpoint-compaction.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";

const frame = (): ChannelStreamCheckpoint => ({ streamId: "current", startedAt: 1,
  progressEntries: [], thought: "", answerPreview: "", finished: false });
const stage = (id: string) => ({ inputId: id, attempts: 2, retryAt: 10,
  checkpoint: { ...frame(), streamId: id, messageId: id, terminal: { text: "阶段成果".repeat(1000), error: false, outcome: "continued" as const } } });

test("stage compaction preserves distinct receipts, text, old answers and the sole carried copy", () => {
  const first = stage("stage"), owner = { ...frame(), segments: { acceptedInputs: ["input"], previous: [first] } };
  const altered = { ...first, attempts: 3 };
  const checkpoint = { ...frame(), segments: { acceptedInputs: ["old-input"], previous: [structuredClone(first), altered, stage("unique")],
    answerPrefix: { length: 3, digest: "old-prefix" } } };
  const state = { checkpoint: owner, pendingTerminals: { old: { text: "原始最终结果", sourceText: "附件动作待处理", checkpoint },
    shared: { text: "另一个结果", checkpoint: owner } } };
  assert.equal(compactArchivedSummaries(state), 2);
  assert.equal(owner.segments.previous.length, 1, "shared checkpoint objects must not erase their owner's stages");
  assert.deepEqual(state.pendingTerminals.old.checkpoint.segments?.previous, [altered, stage("unique")]);
  assert.equal(state.pendingTerminals.old.text, "原始最终结果");
  assert.equal(state.pendingTerminals.old.sourceText, "附件动作待处理");
  assert.deepEqual(state.pendingTerminals.old.checkpoint.segments?.acceptedInputs, ["old-input"]);
  assert.deepEqual(state.pendingTerminals.old.checkpoint.segments?.answerPrefix, { length: 3, digest: "old-prefix" });
  assert.equal(compactArchivedSummaries(state), 0);
  assert.equal(compactArchivedSummaries({ pendingTerminals: { old: { checkpoint } } }), 0, "no owner means no deletion");
});

test("follow journal migration and new turns retain historical results without multiplying carried stage payloads", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "follow-compact-")), filePath = path.join(root, "state.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stages = Array.from({ length: 12 }, (_, i) => stage(`stage-${i}`));
  const checkpoint = { ...frame(), terminal: { text: "当前未送达结果", error: false }, segments: { acceptedInputs: [], previous: stages } };
  const pendingTerminals = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`old-${i}`, {
    text: `result-${i}`, sourceText: `unprocessed-action-${i}`, checkpoint: { ...checkpoint, streamId: `old-${i}` }
  }]));
  fs.writeFileSync(filePath, JSON.stringify({ binding: { hostId: "local", threadId: "thread", turnId: "current",
    checkpointTurnId: "current", eventVersion: 2, deliveryVersion: 1, initialized: true,
    sequence: 0, delivered: [], completed: [], baseline: [], checkpoint, pendingTerminals } }));
  const before = fs.statSync(filePath).size;
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "room", managed: true,
    client: { async sendText() { throw Error("migration must not send messages"); } } };
  const hub = new ThreadEventHub({ filePath, subscriptions: () => [sub], backend: () => ({}) });
  t.after(() => hub.stop());
  hub.managedStarted(sub, "current");
  let saved = JSON.parse(fs.readFileSync(filePath, "utf8")).binding;
  assert.ok(fs.statSync(filePath).size < before / 10, "duplicate payload amplification is removed");
  assert.equal(Object.keys(saved.pendingTerminals).length, 25);
  for (let i = 0; i < 25; i++) {
    assert.equal(saved.pendingTerminals[`old-${i}`].text, `result-${i}`);
    assert.equal(saved.pendingTerminals[`old-${i}`].sourceText, `unprocessed-action-${i}`);
    assert.deepEqual(saved.pendingTerminals[`old-${i}`].checkpoint.segments.previous, []);
  }
  hub.managedStarted(sub, "next");
  saved = JSON.parse(fs.readFileSync(filePath, "utf8")).binding;
  assert.equal(saved.pendingTerminals.current.text, "当前未送达结果");
  assert.deepEqual(saved.pendingTerminals.current.checkpoint.segments.previous, []);
  assert.deepEqual(saved.checkpoint.segments.previous, stages);
  assert.equal(saved.turnId, "next");
  const restarted = new ThreadEventHub({ filePath, subscriptions: () => [sub], backend: () => ({}) });
  t.after(() => restarted.stop());
  restarted.managedStarted(sub, "next");
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).binding.pendingTerminals, saved.pendingTerminals);
});
