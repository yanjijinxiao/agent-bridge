import type { CodexBridgeBackend } from "../codex/backend.js";

/** Read acceptance evidence only. Similar text, missing history, partial pages
 * and duplicate client IDs never authorize either a receipt or a replay. */
export async function findNativeInputReceipts(backend: Pick<CodexBridgeBackend, "getHistoryPage">,
  scope: { hostId: string; threadId: string }, ids: ReadonlySet<string>,
  options: { timeoutMs?: number; maxPages?: number; signal?: AbortSignal } = {}): Promise<Map<string, string>> {
  const matches = new Map<string, Set<string>>(), invalid = new Set<string>(), cursors = new Set<string>();
  const deadline = Date.now() + (options.timeoutMs ?? 3000);
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < (options.maxPages ?? 20); pageNumber++) {
    options.signal?.throwIfAborted();
    const remaining = deadline - Date.now(); if (remaining <= 0) throw Error("Native input receipt observation timed out");
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const page = await Promise.race([
      Promise.resolve().then(() => backend.getHistoryPage(scope.threadId, { cursor, limit: 100, sortDirection: "desc" }, scope.hostId)),
      new Promise<never>((_, reject) => {
        abort = () => reject(Error("Native input receipt observation retired"));
        options.signal?.addEventListener("abort", abort, { once: true });
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Native input receipt observation timed out")), remaining); })
    ]).finally(() => { if (timer) clearTimeout(timer); if (abort) options.signal?.removeEventListener("abort", abort); });
    options.signal?.throwIfAborted();
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

type ScanOutcome = { proofs: Map<string, string> } | { error: unknown };
type Scan = { controller: AbortController; result: Promise<ScanOutcome>; expiresAt: number };

/** A short UI refresh may leave a longer read-only scan running. Share that
 * exact scan until its next consumer receives the complete result; never cache
 * partial acceptance or restart page one at every refresh timeout. This object
 * belongs to one backend owner and is cleared when that owner is closed. */
export class NativeInputReceiptObserver {
  private readonly scans = new Map<string, Scan>();
  constructor(private readonly options: { replyTimeoutMs?: number; scanTimeoutMs?: number; maxPages?: number; maxScans?: number } = {}) {}

  clear(): void {
    for (const scan of this.scans.values()) scan.controller.abort();
    this.scans.clear();
  }

  async observe(namespace: string, backend: Pick<CodexBridgeBackend, "getHistoryPage">,
    scope: { hostId: string; threadId: string }, ids: ReadonlySet<string>): Promise<Map<string, string>> {
    const now = Date.now();
    for (const [key, scan] of this.scans) if (scan.expiresAt <= now) { scan.controller.abort(); this.scans.delete(key); }
    const key = JSON.stringify([namespace, scope.hostId, scope.threadId, [...ids].sort()]);
    let scan = this.scans.get(key);
    if (!scan) {
      if (this.scans.size >= (this.options.maxScans ?? 64)) throw Error("Native input receipt observation capacity reached; acceptance remains unknown");
      const controller = new AbortController(), timeoutMs = this.options.scanTimeoutMs ?? 120_000;
      scan = { controller, expiresAt: now + timeoutMs + 60_000,
        result: findNativeInputReceipts(backend, scope, ids, { timeoutMs, maxPages: this.options.maxPages ?? 10_000, signal: controller.signal })
          .then(proofs => ({ proofs }), error => ({ error })) };
      this.scans.set(key, scan);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([scan.result, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("Native input receipt observation timed out; complete scan continues")), this.options.replyTimeoutMs ?? 3_000);
      })]);
      if (scan.controller.signal.aborted) throw Error("Native input receipt observation retired");
      if (this.scans.get(key) === scan) this.scans.delete(key);
      if ("error" in result) throw result.error;
      return result.proofs;
    } finally { if (timer) clearTimeout(timer); }
  }
}
