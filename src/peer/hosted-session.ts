import type { PeerPrincipal } from "./context.js";

/** Gateway-only routing policy. The Connector still speaks the same native RPC.
 * Untargeted queries and future RPC methods are denied until classified. */
export type HostedSessionAuthority = (source: PeerPrincipal, host: string,
  scope: { threadId: string } | { reservationId: string }) => boolean;

const threadMethods = new Set([
  "inspectThread", "readThreadSnapshot", "getRuntimeInfo", "getHistory", "getHistoryPage", "readThreadProvenance",
  "getGoal", "setGoal", "clearGoal", "updateThreadSettings", "run", "steer", "submitThreadMessage", "stop",
  "interruptTurn", "readTurnLifecycle", "readTurnActivities", "addQueuedSubmission", "listQueuedSubmissions",
  "deleteQueuedSubmission", "runQueuedSubmission", "resumeAfterCapacity", "recoverSystemError",
  "observeThreadInteractions", "unobserveThreadInteractions"
]);

export function hostedSessionRequest(method: string, args: unknown[]): Parameters<HostedSessionAuthority>[2] | undefined {
  const first = args[0];
  if (method === "createThread") {
    if (!first || typeof first !== "object" || !("standalone" in first) || first.standalone !== true
      || !("clientUserMessageId" in first) || typeof first.clientUserMessageId !== "string"
      || Object.keys(first).some(key => !["standalone", "clientUserMessageId", "title"].includes(key))) return;
    return { reservationId: first.clientUserMessageId };
  }
  if (!threadMethods.has(method)) return;
  const threadId = method === "getRuntimeInfo" ? args[1] : typeof first === "string" ? first
    : first && typeof first === "object" && "threadId" in first ? first.threadId : undefined;
  if (typeof threadId === "string" && threadId) return { threadId };
}
