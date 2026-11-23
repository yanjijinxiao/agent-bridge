import { CodexCommunicationError } from "./communication-error.js";

export const COLD_PERMISSION_REASONS = ["timeout", "unavailable", "changed", "limit", "invalid"] as const;
export type ColdPermissionReason = typeof COLD_PERMISSION_REASONS[number];

export function coldPermissionReason(value: unknown): value is ColdPermissionReason {
  return typeof value === "string" && (COLD_PERMISSION_REASONS as readonly string[]).includes(value);
}

/** Emitted before any thread/resume or turn/start. The cause stays on the device. */
export class ColdPermissionError extends CodexCommunicationError {
  constructor(readonly reason: ColdPermissionReason, threadId?: string, cause?: unknown) {
    super("preflight", "thread/restore-permissions", threadId, undefined, cause);
  }
  get retryable(): boolean {
    return this.reason !== "invalid" && this.reason !== "limit";
  }
}
