import { ApiError } from "./api";
import { pendingSubmissionKeys, submissionKey } from "./submissionReceipts";

export type AiSubmissionReceipt = { key: string; raw: string | null; id?: string; kind: "thread" | "turn"; scope: string };

export function readAiReceipts(projectId: string, threadId: string | null): { receipts: AiSubmissionReceipt[]; unavailable: boolean } {
  try {
    const receipts: AiSubmissionReceipt[] = [];
    for (const [kind, scope] of [["thread", projectId], ["turn", threadId]] as const) {
      if (!scope) continue;
      for (const key of pendingSubmissionKeys(kind === "thread" ? "ai-thread" : "ai-turn", scope)) {
        const raw = localStorage.getItem(key); let value: unknown;
        try { value = raw ? JSON.parse(raw) : undefined; } catch {}
        const id = value && typeof value === "object" && "id" in value && typeof value.id === "string" ? value.id : undefined;
        receipts.push({ key, raw, id, kind, scope });
      }
    }
    return { receipts, unavailable: false };
  } catch { return { receipts: [], unavailable: true }; }
}

export function beginAiReceipt(kind: "thread" | "turn", scope: string): AiSubmissionReceipt {
  const id = crypto.randomUUID(), key = submissionKey(kind === "thread" ? "ai-thread" : "ai-turn", scope, id);
  const raw = JSON.stringify({ version: 1, id, kind, scope });
  // If this fails, the caller must retain the draft and send zero HTTP writes.
  localStorage.setItem(key, raw);
  return { key, raw, id, kind, scope };
}

export function retireAiReceipt(receipt: AiSubmissionReceipt): void {
  if (localStorage.getItem(receipt.key) === receipt.raw) localStorage.removeItem(receipt.key);
}

export function knownAiRejection(error: unknown): boolean {
  return error instanceof ApiError && [400, 401, 403, 404, 405, 410, 413, 415, 422].includes(error.status);
}
