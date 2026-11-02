import type { CodexBridgeBackend } from "../codex/backend.js";

/** Read acceptance evidence only. Similar text, missing history, partial pages
 * and duplicate client IDs never authorize either a receipt or a replay. */
export async function findNativeInputReceipts(backend: Pick<CodexBridgeBackend, "getHistoryPage">,
  scope: { hostId: string; threadId: string }, ids: ReadonlySet<string>,
  options: { timeoutMs?: number; maxPages?: number } = {}): Promise<Map<string, string>> {
  const matches = new Map<string, Set<string>>(), invalid = new Set<string>(), cursors = new Set<string>();
  const deadline = Date.now() + (options.timeoutMs ?? 3000);
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < (options.maxPages ?? 20); pageNumber++) {
    const remaining = deadline - Date.now(); if (remaining <= 0) throw Error("Native input receipt observation timed out");
    let timer: NodeJS.Timeout | undefined;
    const page = await Promise.race([
      Promise.resolve().then(() => backend.getHistoryPage(scope.threadId, { cursor, limit: 100, sortDirection: "desc" }, scope.hostId)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Native input receipt observation timed out")), remaining); })
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (!page || !Array.isArray(page.messages)) throw Error("Native input receipt history is incomplete");
    for (const message of page.messages) {
      if (message.role !== "user" || !message.clientUserMessageId || !ids.has(message.clientUserMessageId)) continue;
      if (typeof message.turnId !== "string" || !message.turnId.trim()) { invalid.add(message.clientUserMessageId); continue; }
      const turns = matches.get(message.clientUserMessageId) ?? new Set<string>();
      turns.add(message.turnId); matches.set(message.clientUserMessageId, turns);
    }
    if (page.nextCursor === undefined || page.nextCursor === "") {
      return new Map([...matches].filter(([id, turns]) => turns.size === 1 && !invalid.has(id))
        .map(([id, turns]) => [id, [...turns][0]]));
    }
    if (typeof page.nextCursor !== "string" || cursors.has(page.nextCursor)) throw Error("Native input receipt history cursor is invalid");
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw Error("Native input receipt history budget exceeded; acceptance remains unknown");
}
