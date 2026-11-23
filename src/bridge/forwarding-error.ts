import { CodexCommunicationError } from "../codex/communication-error.js";
import { ColdPermissionError } from "../codex/cold-permission-error.js";
import { CodexRunAdmissionError } from "../codex/backend.js";

/** Known not submitted. A durable transport inbox may retry after acceptance
 * of the preceding input, without turning the message into a native queue item. */
export class ForwardingDeferredError extends Error {}

/** Classification only. Retry authority still requires the inbox's durable
 * source, unchanged target and a receipt proving that no input was accepted. */
export function isRetryableForwardingError(error: unknown): boolean {
  if (error instanceof ColdPermissionError) return error.retryable;
  return error instanceof ForwardingDeferredError || error instanceof CodexRunAdmissionError
    || error instanceof CodexCommunicationError && error.submission === "not-submitted";
}
