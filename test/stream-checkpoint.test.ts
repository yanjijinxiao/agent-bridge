import test from "node:test";
import assert from "node:assert/strict";
import { channelStreamCheckpointSchema } from "../src/channels/stream-checkpoint.js";
import type { ChannelStreamCheckpoint } from "../src/channels/progress.js";
const checkpoint = (): ChannelStreamCheckpoint => ({ startedAt: 100, progressEntries: [], thought: "", answerPreview: "", finished: false });
test("complete presentation checkpoint round trips nested bootstrap pages and segments", () => {
  const saved: ChannelStreamCheckpoint = { ...checkpoint(), messageId: "card", resultPresentation: "card", statusHeader: true,
    bootstrap: { version: 1, instanceId: "instance", recipientId: "chat", stage: "delivered", messageId: "card", adapterData: { key: "value" } },
    phaseProgress: { version: 1, phases: [{ text: "milestone", summary: "reviewed" }], live: ["reading"], completed: 1, failed: 0 },
    terminalPages: [{ messageId: "page", delivered: false, attempted: true }],
    terminalWindow: { version: 1, text: "latest terminal snapshot" },
    terminal: { text: "terminal idle", error: false, outcome: "terminal-idle" },
    segments: { acceptedInputs: ["input"], previous: [{ inputId: "first", checkpoint: checkpoint(), attempts: 1 }], answerPrefix: { length: 1, digest: "a".repeat(64) } } };
  assert.deepEqual(channelStreamCheckpointSchema.parse(saved), saved);
});
for (const [name, patch] of Object.entries({
  bootstrap: { bootstrap: { version: 1, instanceId: "x", recipientId: "c", stage: "executed" } },
  page: { terminalPages: [{ delivered: "yes" }] },
  phase: { phaseProgress: { version: 1, phases: [{ text: {} }], live: [], completed: 0, failed: 0 } },
  segment: { segments: { acceptedInputs: [], previous: [{ inputId: "x", attempts: 1, checkpoint: { ...checkpoint(), terminal: { text: "x", error: false, outcome: "invented" } } }] } },
  hidden: { execute: "arbitrary" }, time: { startedAt: -1 }, receipt: { progressReceipts: ["not-a-digest"] },
  terminalVersion: { terminalWindow: { version: 2, text: "x" } },
  terminalSize: { terminalWindow: { version: 1, text: "x".repeat(100001) } }
})) test(`checkpoint rejects malformed ${name} instead of trusting passthrough state`, () => {
  assert.equal(channelStreamCheckpointSchema.safeParse({ ...checkpoint(), ...patch }).success, false);
});
