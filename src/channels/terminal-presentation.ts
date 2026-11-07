import crypto from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { RuntimeOutput } from "../agents/contracts.js";

export type TerminalPresentation = {
  /** A display boundary only; never a native turn or delivery identity. */
  boundary?: string;
  stages: Array<{ key: string; text: string }>;
  live: string;
  commands: number;
  recognized: boolean;
};
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const promptLine = /^(?:›|>)\s+\S/;
// Codex paints this grey composer hint as ordinary screen bytes. It is not
// submitted input: treating it as the newest prompt discards the whole reply.
const composerHint = /^[›>]\s+Ask Codex to do anything\s*$/;
const footer = /^(?:[─━]+\s*)?(?:Worked for\b|Working\b|Thinking\b|Context left\b|\d+% context left\b|Tip:|To continue this session|Model:|Directory:|Tokens:)/i;
const tool = /^(?:Ran|Running|Explored|Exploring|Searched|Searching|Read|Reading|Edited|Editing|Added|Deleted|Called|Calling|Updated Plan|Updated plan|Plan updated)\b/;

/** Screen layout is weak evidence. Only known CLI grammar is classified;
 * arbitrary shell/agent output remains a bounded display, never a fake final.
 * Raw text cannot inject Markdown links, copy widgets, actions or HTML controls. */
export function terminalProse(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]#|~]/g, "\\$&")
    .split("\n").map(line => line.replace(/^\s*[-+]\s/, "• ")).join("\n").trim();
}
export function cleanTerminal(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function projectTerminal(output: RuntimeOutput, agent: string | undefined, settled: boolean): TerminalPresentation {
  const lines = cleanTerminal(output.text).split("\n").map(line => line.trimEnd());
  if (!/^codex(?:\b|$)/i.test(agent ?? "")) {
    // No semantic guesses from unknown CLI output. A short excerpt is clearly
    // named as such by the observer; full raw output remains /history-only.
    return { stages: [], live: terminalProse(Array.from(lines.filter(line => line.trim()).slice(-4).join("\n")).slice(-480).join("")), commands: 0, recognized: false };
  }
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (promptLine.test(lines[i]) && !composerHint.test(lines[i])) start = i;
  const boundary = start < 0 ? undefined : hash(lines[start]);
  const blocks: Array<{ kind: "assistant" | "tool"; lines: string[]; complete: boolean }> = [];
  let current: typeof blocks[number] | undefined;
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (footer.test(trimmed) || /^└\s*Tip:/.test(trimmed)) { if (current) current.complete = true; current = undefined; continue; }
    // Empty prompt, box borders, status/help rows and tool indentation belong
    // to the terminal UI, not the assistant's prose.
    if (composerHint.test(trimmed) || /^[›>]\s*$/.test(trimmed) || /^[╭╰┌└│┃─━][─━─\s]*$/.test(trimmed)
      || /^\? for shortcuts|^\d+% context left|^Press .* to /i.test(trimmed)) continue;
    const bullet = /^\s*[•●]\s+(.*)$/.exec(line);
    if (bullet) {
      if (current) current.complete = true;
      current = { kind: tool.test(bullet[1]) ? "tool" : "assistant", lines: [bullet[1]], complete: false };
      blocks.push(current); continue;
    }
    // Ignore prompt continuations until the first explicit response marker.
    if (current) current.lines.push(line.replace(/^ {1,2}/, ""));
  }
  if (current && settled) current.complete = true;
  // Without the latest input boundary a scrolled screen may contain old tasks.
  // Preserve only its newest assistant block; earlier published stages already
  // live in the durable card checkpoint.
  const selected = boundary ? blocks : blocks.filter(block => block.kind === "assistant").slice(-1);
  const stages: TerminalPresentation["stages"] = []; let live = "";
  for (const block of selected) {
    if (block.kind !== "assistant") continue;
    // CLI soft wraps can move on resize. Join prose wraps before hashing;
    // retain empty paragraphs, list/heading boundaries and indented code.
    const prose: string[] = [];
    for (const line of block.lines) {
      if (line.trim() && prose.at(-1)?.trim() && !/^\s*(?:[-*+] |\d+[.)] |#{1,6} |```)/.test(line)
        && !/^ {2,}/.test(line) && !/^\s*(?:[-*+] |\d+[.)] |#{1,6} |```)/.test(prose.at(-1)!))
        prose[prose.length - 1] += ` ${line.trim()}`;
      else prose.push(line);
    }
    const text = terminalProse(prose.join("\n")); if (!text) continue;
    if (block.complete) stages.push({ key: hash(text), text }); else live = text;
  }
  return { ...(boundary ? { boundary } : {}), stages, live,
    commands: (boundary ? blocks : []).filter(block => block.kind === "tool").length, recognized: Boolean(blocks.length) };
}

export function terminalCommandSummary(count: number): string {
  return count ? `命令记录 ${count} 项 · 输出已收起，发送 /history 查看终端详情。` : "";
}
