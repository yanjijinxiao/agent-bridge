import { progressKind } from "./progress-summary.js";
import { closeMarkdownFence } from "./result-pages.js";
import { turnStatusHeading, type TurnActivity } from "./turn-status.js";
import type { ChannelProgressLayout } from "./types.js";
import { markdownPreview } from "./markdown-preview.js";
import { copyBlock } from "./copyable.js";
import { phaseActivity, phaseParagraphs, type PhaseProgress } from "./phase-progress.js";

/** A pure view of task facts. No timers, delivery state or execution decisions. */
type ProgressFacts = {
  activity: TurnActivity;
  elapsed: string;
  current: string;
  thought?: string;
  recent: readonly string[];
  tools: { completed: number; failed: number; active?: string };
  answerPreview: string;
  notice?: string;
  phases?: PhaseProgress;
  /** Undefined preserves native task cancellation semantics. */
  interruptControl?: "request" | "hidden";
};

export function renderTurnProgressCard(input: ProgressFacts): string {
  const { sections, status, controls } = progressParts(input);
  return [...sections, controls, status].filter(Boolean).join("\n\n");
}

export function renderTurnProgressLayout(input: ProgressFacts): ChannelProgressLayout {
  const { sections, status, controls } = progressParts(input);
  return { body: [...sections, status].filter(Boolean).join("\n\n"), footer: controls, status: sections[0] };
}

function progressParts(input: ProgressFacts) {
  const status = {
    running: "",
    "waiting-input": "等待你的回答，任务尚未完成",
    // The runtime flag also covers native automatic review. Only a concrete
    // approval request can establish that the recipient needs to act.
    "waiting-approval": "等待权限审批结果，任务尚未完成",
    "waiting-external": "请在原终端查看并处理；这不是聊天中的审批或回答请求",
    recovering: "正在恢复原任务，尚未确认完成",
    unconfirmed: "执行状态待确认，未重发或停止原任务",
    "waiting-result": "已收到原任务结束回执，正在核对结果投递；不会重新执行任务"
  }[input.activity];
  const tools = input.tools;
  const metadata = [input.elapsed];
  if (tools.failed) metadata.push(`工具异常 ${tools.failed} 次（非任务终态）`);
  const icon = { running: "⏳", "waiting-input": "💬", "waiting-approval": "🔐", "waiting-external": "💬", recovering: "↻", unconfirmed: "⚠️", "waiting-result": "📨" }[input.activity];
  const current = progressProse(input.notice || input.current, 360);
  const thought = input.thought && progressProse(input.thought, 160);
  const sections = [`${turnStatusHeading(input.activity)} ${icon} · ${metadata.join(" · ")}`, current];
  if (input.phases) {
    const history = phaseParagraphs(input.phases);
    const live = phaseActivity(input.phases);
    sections.splice(1, 1, ...history);
    if (input.notice) sections.push(progressProse(input.notice, 360));
    else if (live.length) sections.push(live.join("\n"));
    else if (!history.length) sections.push(current);
  }
  if (!input.phases && !input.notice && thought && !current.includes(thought)) {
    sections.push(`💭 ${thought}`);
  }
  // Keep errors visible without making a mobile progress card a growing log.
  const milestones = input.recent.filter(entry => progressKind(entry) !== "failure").slice(-2);
  const errors = input.recent.filter(entry => progressKind(entry) === "failure").slice(-2);
  const recent = input.recent.filter(entry => milestones.includes(entry) || errors.includes(entry));
  if (!input.phases && recent.length) sections.push(recent.map(entry => `- ${progressProse(entry, 140).replace(/\n/g, "\n  ")}`).join("\n"));
  if (!input.phases && tools.active) sections.push(progressProse(tools.active, 100));
  if (input.answerPreview) sections.push(`回复预览（尚未完成）\n\n${markdownPreview(input.answerPreview, 600)}`);
  // /stop targets the chat's current task, not the historical card. Once the
  // native state is unconfirmed, offering it here could interrupt a newer task.
  // Confirmed active states retain the exact-reply widget in a stable footer.
  const controls = input.activity === "unconfirmed" || input.activity === "waiting-result" || input.interruptControl === "hidden"
    || input.interruptControl === "request" && input.activity !== "running" ? ""
    : `${input.interruptControl === "request" ? "请求中断终端（结果以终端状态为准）" : "停止任务（发送后会中断执行）"}：\n\n${copyBlock("/stop")}\n\n复制不会发送。`;
  // Always end on a normal paragraph, not a code fence/list/blockquote. The
  // native streaming cursor belongs to DingTalk, never to generated dot frames.
  return { sections, status, controls };
}

function progressProse(value: string, length: number): string {
  return markdownPreview(bounded(value, length), length, { emphasis: false });
}

function bounded(value: string, length: number): string {
  const text = value.trim();
  return closeMarkdownFence(text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`);
}
