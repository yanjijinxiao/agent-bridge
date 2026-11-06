import { markdownPreview } from "./markdown-preview.js";
import { progressKind } from "./progress-summary.js";

export type ProgressPhase = { text: string; summary?: string };
export type PhaseProgress = {
  version: 1;
  phases: ProgressPhase[];
  live: string[];
  completed: number;
  failed: number;
  lastTool?: string;
};

export function emptyPhaseProgress(): PhaseProgress {
  return { version: 1, phases: [], live: [], completed: 0, failed: 0 };
}

/** Deterministic presentation only. A commentary boundary is not a native
 * terminal event; tool counts never imply the task or even a test suite passed. */
export function applyPhaseProgress(state: PhaseProgress, text: string): void {
  const kind = progressKind(text);
  if (kind === "update") {
    if (state.phases.at(-1)?.text === text) return;
    const summary = activitySummary(state);
    if (summary) {
      if (!state.phases.length) state.phases.push({ text: "", summary });
      else state.phases.at(-1)!.summary = summary;
    }
    state.phases.push({ text });
    state.live = []; state.completed = 0; state.failed = 0; state.lastTool = undefined;
  } else if (kind === "thought") {
    state.live = state.live.filter(item => progressKind(item) !== "thought");
    state.live = [...state.live, text].slice(-3);
  } else {
    if (state.lastTool !== text) {
      if (kind === "failure") state.failed++;
      else if (text.startsWith("✅")) state.completed++;
      state.lastTool = text;
    }
    state.live = [...state.live.filter(item => item !== text), text].slice(-3);
  }
}

export function activitySummary(state: PhaseProgress): string {
  const parts = [state.completed ? `工具完成 ${state.completed} 次` : "", state.failed ? `工具异常 ${state.failed} 次（非任务终态）` : ""].filter(Boolean);
  if (parts.length) return parts.join("，");
  // Start/thought events alone do not establish a result. Keep them in the
  // bounded live region, without persisting protocol bookkeeping as a phase.
  return "";
}

export function phaseParagraphs(state: PhaseProgress, close = false): string[] {
  const summary = close ? activitySummary(state) : "";
  return state.phases.flatMap((phase, index) => [
    phase.text && progressBullet(markdownPreview(phase.text, Number.MAX_SAFE_INTEGER, { emphasis: false })),
    (phase.summary || (index === state.phases.length - 1 ? summary : "")) &&
      progressBullet(`🛠️ ${phase.summary || summary}`)
  ]).filter(Boolean);
}

export function phaseActivity(state: PhaseProgress): string[] {
  return state.live.map(text => progressBullet(progressKind(text) === "thought"
    ? `💭 ${markdownPreview(text.replace(/^🤔\s*/, ""), 160, { emphasis: false })}`
    : markdownPreview(text, 140, { emphasis: false })));
}

/** Keep the existing list/icon vocabulary in both phase history and the live
 * window. Continuation lines belong to the same item, including after restart. */
function progressBullet(text: string): string {
  // Blank preview paragraphs must not become indented empty list rows when
  // DingTalk flattens the list into its single streaming paragraph.
  return `- ${text.split("\n").filter(line => line.trim()).join("\n  ")}`;
}

/** Split only when one commentary cannot fit the reserved history area. Use
 * rendered bytes (Markdown escaping can expand ASCII), not JS string length.
 * Returning original source slices keeps repeated text and emoji lossless. */
export function splitPhaseCommentary(text: string, maxBytes: number): string[] {
  const points = Array.from(text), chunks: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    let low = 1, high = points.length - offset, best = 0;
    while (low <= high) {
      const size = Math.floor((low + high) / 2), source = points.slice(offset, offset + size).join("");
      const bytes = Buffer.byteLength(markdownPreview(source, Number.MAX_SAFE_INTEGER, { emphasis: false }));
      if (bytes <= maxBytes) { best = size; low = size + 1; } else high = size - 1;
    }
    // The minimum configured budget admits every single Unicode code point.
    if (!best) throw Error("Progress commentary budget is too small");
    chunks.push(points.slice(offset, offset + best).join("")); offset += best;
  }
  return chunks;
}
