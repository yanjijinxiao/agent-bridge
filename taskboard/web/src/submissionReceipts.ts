/** Browser handoff facts only. Bodies and File data stay in their composers.
 * Each operation owns one key: independent views cannot overwrite/clear each
 * other's evidence. Review retires the captured keys, never a later operation.
 */
export type SubmissionKind = "comment" | "issue" | "ai-thread" | "ai-turn";
export function submissionKey(kind: SubmissionKind, scope: string, id: string): string {
  return `taskboard.submission:${JSON.stringify([kind, scope])}:${id}`;
}

export function pendingSubmissionKeys(kind: SubmissionKind, scope: string): string[] {
  const prefix = `taskboard.submission:${JSON.stringify([kind, scope])}:`;
  return Object.keys(window.localStorage).filter(key => key.startsWith(prefix));
}

export function submissionReceiptState(key: string, id: string): "owned" | "retired" | "unavailable" {
  try {
    const value = window.localStorage.getItem(key);
    return value && JSON.parse(value)?.id === id ? "owned" : "retired";
  } catch { return "unavailable"; }
}

export function ownsSubmissionReceipt(key: string, id: string): boolean {
  const state = submissionReceiptState(key, id);
  if (state === "unavailable") throw Error("无法核对浏览器提交回执，原操作不会自动重发。");
  return state === "owned";
}
