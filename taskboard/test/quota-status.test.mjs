import assert from "node:assert/strict";
import test from "node:test";
import { readCodexQuotaStatus } from "../scripts/codex-rate-limits.mjs";

for (const [label, balance, expected] of [
  ["empty native snapshot", {}, { state: "unknown" }],
  ["plan metadata only", { planType: "pro" }, { state: "unknown" }],
  ["known available window", { primary: { usedPercent: 25, resetsAt: 200 } }, { state: "available" }],
  ["exhausted window with unknown reset", { primary: { usedPercent: 100, resetsAt: null } }, { state: "blocked" }],
  ["exhausted window with reset", { primary: { usedPercent: 100, resetsAt: 200 } }, { state: "blocked", resetsAt: 200 }],
  ["credits cover a spent window", { primary: { usedPercent: 100 }, credits: { hasCredits: true } }, { state: "available" }],
  ["credits only", { credits: { unlimited: true } }, { state: "available" }],
  ["empty credit wallet without a window", { credits: { hasCredits: false, unlimited: false } }, { state: "unknown" }],
  ["individual spend exhausted", { individualLimit: { remainingPercent: 0, resetsAt: 300 } }, { state: "blocked", resetsAt: 300 }],
  ["spend block overrides credits", { spendControlReached: true, credits: { unlimited: true } }, { state: "blocked" }],
]) test(`quota status preserves evidence for ${label}`, async () => {
  const { checkedAt, ...result } = await readCodexQuotaStatus("model", { async getAccountRateLimits() { return balance; } });
  assert.equal(Number.isFinite(checkedAt), true);
  assert.deepEqual(result, expected);
});
