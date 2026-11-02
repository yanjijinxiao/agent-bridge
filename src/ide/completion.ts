import { closeMarkdownFence } from "../channels/result-pages.js";
import { projectAssistantProse } from "../channels/assistant-presentation.js";

/** A presentation label, not a URL shortener or an authorization credential. */
export function ideEntryLink(url: string): string {
  const target = new URL(url);
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) throw new Error("无效的 Web IDE 链接");
  // Keep Markdown control characters out of the destination without changing
  // its origin, path or browser authorization scope.
  const destination = target.href.replace(/[()<>]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `[打开项目 Web IDE](${destination})`;
}

/** Presentation-only enrichment. Never alters the model history or submission. */
export function withIDEEntry(text: string, url?: string, _options: { atEnd?: boolean } = {}): string {
  // This standalone label is Gateway-owned, including legacy model-authored
  // footers. Reconcile it semantically, not by comparing two session URLs.
  text = projectAssistantProse(text, prose => prose.split("\n").filter(line => {
    const match = /^\s*\[打开项目 Web IDE\]\((https?:\/\/\S+)\)\s*$/.exec(line);
    if (!match) return true;
    try { return !/^\/workspace\/[^/]+\/?$/.test(new URL(match[1]).pathname); } catch { return true; }
  }).join("\n")).trimEnd();
  if (!url) return text;
  const link = ideEntryLink(url);
  // A URL quoted in an example is not the usable Gateway entry. Automatic
  // footers always belong outside the model's fences.
  text = closeMarkdownFence(text);
  return `${text.trimEnd()}\n\n${link}`;
}
