import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexSessionCompletionMonitor } from "../src/server/codex-session-monitor.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";

test("DEL-08.3: inherited parent metadata from guardian/child logs never projects summaries, tools or false endings into the main card", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-provenance-card-")), dir = path.join(root, "sessions"); fs.mkdirSync(dir);
  const write = (file: string, rows: unknown[], append = false) => fs[append ? "appendFileSync" : "writeFileSync"](path.join(dir, file), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const meta = (id: string, source: unknown) => ({ type: "session_meta", payload: { id, session_id: "main", cwd: root, source } });
  const event = (type: string, turn_id: string, extra = {}) => ({ type: "event_msg", payload: { type, turn_id, ...extra } });
  const summary = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text }] } });
  const tool = (turnId: string) => ({ type: "event_msg", payload: { type: "item_completed", turn_id: turnId, item: { id: "cmd", type: "CommandExecution", status: "completed", command: "PRIVATE_COMMAND" } } });
  write("main.jsonl", [meta("main", "cli")]);
  const frames: any[] = [], sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "main", recipientId: "room", managed: false,
    client: { resumableTextStream: true, async sendText(input) { frames.push(input); return { messageId: "notice" }; },
      async startTextStream(input) { frames.push(input); return { messageId: input.streamId! }; }, async updateTextStream(input) { frames.push(input); } } };
  const hub = new ThreadEventHub({ filePath: path.join(root, "follow.json"), subscriptions: () => [sub], backend: () => ({} as never) });
  const completions: string[] = [];
  const monitor = new CodexSessionCompletionMonitor({ codexHome: root, pollIntervalMs: 60000,
    onTaskChanged: async e => { if (e.status === "running") await hub.started("local", e.sessionId, e.turnId, e.startedAt); },
    onActivity: e => hub.activity("local", e.sessionId, e.turnId, e.text),
    onCompletion: async e => { completions.push(e.turnId); await hub.completion("local", e.sessionId, e.turnId, e.text); } });
  t.after(async () => { await monitor.stop(); await hub.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  monitor.start(); await monitor.ready();
  write("main.jsonl", [event("task_started", "main-turn"), summary("公开主任务摘要")], true); await monitor.scanNow();
  for (const [i, source] of ["guardian", { subagent: { other: "guardian" } }].entries()) {
    write(`internal-${i}.jsonl`, [meta(`child-${i}`, source), meta("main", "cli"), event("task_started", "foreign"), summary("PRIVATE_CHILD_SUMMARY"), tool("foreign"), event("task_complete", "foreign", { last_agent_message: "PRIVATE_ENDING" })]);
  }
  write("main.jsonl", [meta("child", { subagent: {} }), event("task_complete", "foreign", { last_agent_message: "PRIVATE_ENDING" }),
    summary("继续公开主任务摘要"), tool("main-turn")], true);
  await monitor.scanNow();
  for (let i = 0; i < 100 && !JSON.stringify(frames).includes("工具活动：1 次成功"); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(completions, []); assert.doesNotMatch(JSON.stringify(frames), /PRIVATE_|foreign/);
  assert.match(JSON.stringify(frames), /公开主任务摘要/); assert.match(JSON.stringify(frames), /工具活动：1 次成功/);
  assert.doesNotMatch(JSON.stringify(frames), /工具活动：[23] 次成功/);
  assert.equal(frames.some(frame => frame.finalize), false);
  write("main.jsonl", [event("task_complete", "main-turn", { last_agent_message: "真正主任务结果" })], true);
  await monitor.scanNow(); assert.deepEqual(completions, ["main-turn"]);
  assert.equal(frames.filter(frame => frame.finalize && frame.text === "真正主任务结果").length, 1);
});
