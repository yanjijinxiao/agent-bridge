import { stripVTControlCharacters } from "node:util";

/** Bound durable display state even if a provider returns a huge scrollback.
 * This is a text window, never a transcript or native task receipt. */
export const TERMINAL_WINDOW_POINTS = 50_000;

export function cleanTerminal(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function terminalWindowText(value: string): string {
  return Array.from(cleanTerminal(value)).slice(-TERMINAL_WINDOW_POINTS).join("");
}

/** Preserve visible text/line breaks, not terminal styling or executable UI.
 * Nonbreaking leading spaces prevent indentation becoming a copyable code
 * block; escaped fences/links/HTML remain inert terminal characters. */
export function terminalProse(value: string): string {
  // Native IM Markdown does not consistently decode HTML entities. Leave
  // clock colons readable, break automatic URI/domain/mention recognition
  // with invisible separators, and escape rich-content syntax as Markdown.
  return value.split("\n").map(line => line.replace(/([a-z][a-z0-9+.-]*):(?=\/\/)/gi, "$1:\u200b")
    .replace(/[.@]/g, "$&\u200b")
    .replace(/[\\`*_{}\[\]()#+.!|~\-&<>]/g, "\\$&")
    .replace(/^[ \t]+/, space => space.replace(/ /g, "\u00a0").replace(/\t/g, "\u00a0\u00a0\u00a0\u00a0")))
    .join("  \n");
}

/** Fit the largest tail we can render inside the remaining transport budget.
 * Count escaped UTF-8, including trusted status/controls/IDE supplied by the
 * caller. Never cut an escape, HTML entity or surrogate pair in half. */
export function renderTerminalWindow(text: string, maxBytes: number, before = "", after = "",
  measure: (text: string) => number = text => Buffer.byteLength(text)): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw Error("Invalid terminal card budget");
  const points = Array.from(text);
  const wrap = (body: string) => [before, body, after].filter(Boolean).join("\n\n");
  if (measure(wrap("")) > maxBytes) throw Error("Terminal card controls exceed the transport budget");
  let low = 0, high = points.length, result = wrap("");
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = wrap(terminalProse(points.slice(points.length - count).join("")));
    if (measure(candidate) <= maxBytes) { result = candidate; low = count + 1; }
    else high = count - 1;
  }
  return result;
}
