/** Additive result metadata only. Never include upstream exception strings,
 * question/answer contents, credentials or a replacement request identity. */
export const USER_INPUT_RESULT_REASONS = [
  "accepted-answer", "accepted-elsewhere", "widget-removed", "widget-replaced",
  "source-changed", "answer-failed", "turn-terminal", "turn-replaced",
  "observer-suspended", "observer-replaced", "connection-lost", "request-resolved",
  "timeout", "binding-changed", "answer-selected-elsewhere"
] as const;
export type CodexUserInputResultReason = typeof USER_INPUT_RESULT_REASONS[number];

export function parseUserInputResultReason(value: unknown): CodexUserInputResultReason | undefined {
  return typeof value === "string" && (USER_INPUT_RESULT_REASONS as readonly string[]).includes(value)
    ? value as CodexUserInputResultReason : undefined;
}
