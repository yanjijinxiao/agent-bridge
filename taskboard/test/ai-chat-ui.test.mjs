import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  buildThreadCreateInput,
  buildTurnInput,
  chatPrimaryAction,
  filterVisibleAiEvents,
  AI_CHAT_SKILL_MARKER,
  parseAiChatComposerFragment,
  isAiChatCapabilityAvailable,
  needsDangerConfirmation,
  normalizeChatSelection,
  routeChatState,
  shouldRefreshAiSnapshot,
} from "../web/src/aiChatState.ts";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const chatSource = await readFile(
  new URL("../web/src/components/AiChat.tsx", import.meta.url),
  "utf8",
);
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
// Layout, IME, loading, skill tokens and cross-project creation are exercised
// against production React/CSS in ai-chat-browser.test.mjs. Exact source strings
// and old fixed pixel sizes prevented the original checks from exercising them.

const models = [
  {
    slug: "codex-real-model",
    displayName: "Codex Real Model",
    description: "Host model",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["medium", "high"],
    serviceTiers: [{ id: "priority", name: "Priority" }],
  },
  {
    slug: "codex-fast-model",
    displayName: "Codex Fast Model",
    description: "Fast host model",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low"],
    serviceTiers: [],
  },
];

test("AI chat capability is local-only and thread creation freezes the current origin", () => {
  assert.equal(isAiChatCapabilityAvailable({ localAiChat: true }), true);
  assert.equal(isAiChatCapabilityAvailable({ localAiChat: false }), false);
  assert.equal(isAiChatCapabilityAvailable(undefined), false);
  assert.deepEqual(buildThreadCreateInput("project-1", "task-1"), {
    projectId: "project-1",
    issueId: "task-1",
  });
  assert.deepEqual(buildThreadCreateInput("project-1", null), {
    projectId: "project-1",
  });
  assert.equal(buildThreadCreateInput("", null), null);
});

test("navigation updates only the pending new-thread origin and preserves the selected global thread", () => {
  assert.deepEqual(
    routeChatState(
      { selectedThreadId: "thread-a", pendingProjectId: "project-a", pendingIssueId: "issue-a" },
      "project-b",
      "issue-b",
    ),
    {
      selectedThreadId: "thread-a",
      pendingProjectId: "project-b",
      pendingIssueId: "issue-b",
    },
  );
});

test("model and effort selections are normalized exclusively against the real catalog", () => {
  assert.deepEqual(normalizeChatSelection(models, "codex-real-model", "medium"), {
    model: "codex-real-model",
    reasoningEffort: "medium",
  });
  assert.deepEqual(normalizeChatSelection(models, "codex-real-model", "fake-effort"), {
    model: "codex-real-model",
    reasoningEffort: "high",
  });
  assert.deepEqual(normalizeChatSelection(models, "missing-model", "high"), {
    model: "codex-real-model",
    reasoningEffort: "high",
  });
  assert.equal(normalizeChatSelection([], "missing-model", "high"), null);
});

test("skill clipboard parsing keeps the selected real id in its marker position", () => {
  const fragment = { message: `请用 ${AI_CHAT_SKILL_MARKER} 检查`, skillIds: ["cloudflare"] };
  assert.deepEqual(parseAiChatComposerFragment(JSON.stringify(fragment), ["cloudflare"]), fragment);
  assert.match(chatSource, /parseAiChatComposerFragment\(/);
  assert.match(chatSource, /insertComposerFragment\(\{ message: SKILL_MARKER, skillIds: \[skill.id\] \}, range\)/);
});

test("turn input contains only visible user content, real skill ids and one-time confirmation", () => {
  assert.deepEqual(buildTurnInput("检查 LOCAL-103", ["cloudflare"], false), {
    message: "检查 LOCAL-103",
    skillIds: ["cloudflare"],
  });
  assert.deepEqual(buildTurnInput("执行", [], true), {
    message: "执行",
    dangerFullAccessConfirmed: true,
  });
  assert.equal(JSON.stringify(buildTurnInput("hello", [], false)).includes("workspacePath"), false);
  assert.equal(JSON.stringify(buildTurnInput("hello", [], false)).includes("manage-taskboard"), false);
});

test("running threads expose stop, danger-full-access requires confirmation, and SSE is a refresh hint", () => {
  assert.equal(chatPrimaryAction("running", "hello"), "stop");
  assert.equal(chatPrimaryAction("idle", "hello"), "send");
  assert.equal(chatPrimaryAction("idle", "  "), "disabled");
  assert.equal(needsDangerConfirmation("danger-full-access", false), true);
  assert.equal(needsDangerConfirmation("danger-full-access", true), false);
  assert.equal(needsDangerConfirmation("workspace-write", false), false);
  assert.equal(shouldRefreshAiSnapshot("ai.event"), true);
  assert.equal(shouldRefreshAiSnapshot("ai.run"), true);
  assert.equal(shouldRefreshAiSnapshot("unrelated"), false);
});

test("reasoning and raw JSONL events never enter the visible activity timeline", () => {
  const events = filterVisibleAiEvents([
    { id: "1", type: "agent_message", role: "assistant", content: "公开回复" },
    { id: "2", type: "reasoning", role: "activity", content: "private chain of thought" },
    { id: "3", type: "raw_jsonl", role: "activity", content: "{\"secret\":true}" },
    { id: "4", type: "command", role: "activity", content: "npm test" },
  ]);
  assert.deepEqual(events.map((event) => event.id), ["1", "4"]);
});

test("App wires the global panel outside project/detail branches and hides it without local capability", () => {
  assert.match(appSource, /<AiChat/);
  assert.match(appSource, /projectId=\{selectedProjectId \|\| null\}/);
  assert.match(appSource, /issueId=\{detailTaskId\}/);
  assert.match(appSource, /localAiChat/);
  assert.match(chatSource, /if \(!available\) return null/);
  assert.match(chatSource, /className="ai-chat-launcher/);
  assert.match(chatSource, /className="ai-chat-panel/);
});

test("AI chat API uses the stable local contract and never sends cwd or hidden prompt fields", () => {
  assert.match(apiSource, /\/api\/local\/ai\/catalog\?projectId=/);
  assert.match(apiSource, /\/api\/local\/ai\/threads/);
  assert.match(apiSource, /\/turns/);
  assert.match(apiSource, /\/interrupt/);
  assert.match(apiSource, /new EventSource\(`\/api\/local\/ai\/threads\//);
  assert.doesNotMatch(apiSource, /hiddenPrompt|workspacePath:\s*input|argv|cwd/);
});

test("quiet refreshes preserve action errors and PATCH results are guarded by their starting thread", () => {
  assert.match(chatSource, /if \(!quiet\) setError\(null\);/);
  assert.match(chatSource, /patchAiChatSnapshot\(current,\s*threadId,\s*thread\)/);
  assert.match(chatSource, /selectedThreadRef\.current === threadId/);
  assert.match(chatSource, /restoreDraftSettings\(previousThread\)/);
});

test("danger confirmation sends the bound pending retry instead of the current draft", () => {
  assert.match(chatSource, /pendingDangerInput/);
  assert.match(chatSource, /setPendingDangerInput\(\{[\s\S]*?message:\s*trimmed/);
  assert.match(chatSource, /startMessage\(\s*pendingDangerInput\.message,\s*true,\s*pendingDangerInput\.skillIds/);
  assert.doesNotMatch(chatSource, /onClick=\{\(\) => void startMessage\(draft,\s*true\)\}/);
});

test("history exposes deletion of local records without adding rename controls", () => {
  assert.match(chatSource, /deleteAiChatThread\(/);
  assert.match(chatSource, /aria-label=\{`删除对话 \$\{thread\.title\}`\}/);
  assert.match(chatSource, /window\.confirm\(`删除本地对话“\$\{thread\.title\}”\？`\)/);
  assert.doesNotMatch(chatSource, /重命名对话|renameAiChatThread/);
});
