import type { CodexBridgeBackend } from "../codex/backend.js";

/** Every public facade port has an explicit transport policy. Adding a native
 * port without updating this map is a type error and fails the contract audit. */
export const PEER_BACKEND_CONTRACT = {
  runtimeRead: "runtime-rpc", runtimeSend: "runtime-rpc", runtimeInterrupt: "runtime-rpc", runtimeReceipt: "runtime-rpc", runtimeLifecycle: "runtime-rpc",
  withSource: "source-context", findNativeInputReceipts: "source-recovery",
  backendInfo: "negotiated", run: "rpc", steer: "rpc", submitThreadMessage: "rpc", stop: "rpc",
  runEphemeral: "rpc", warmUp: "rpc", listProjects: "rpc", listThreads: "catalog-projection",
  listSessionCatalog: "rpc", getHistory: "rpc", getHistoryPage: "rpc", readThreadSnapshot: "rpc",
  inspectThread: "rpc", getRuntimeInfo: "rpc", updateThreadSettings: "rpc", listModels: "rpc", getAccountRateLimits: "rpc",
  listSkills: "rpc", listMcpServers: "rpc", serverIdentity: "rpc", readThreadProvenance: "rpc",
  getGoal: "rpc", setGoal: "rpc", clearGoal: "rpc", createThread: "rpc", renameThread: "rpc",
  archiveThread: "rpc", unarchiveThread: "rpc", deleteThread: "rpc", interruptTurn: "rpc",
  readTurnLifecycle: "rpc", readTurnActivities: "rpc", addQueuedSubmission: "rpc",
  listQueuedSubmissions: "rpc", deleteQueuedSubmission: "rpc", runQueuedSubmission: "rpc",
  resumeAfterCapacity: "rpc", recoverSystemError: "rpc", systemErrorLifecycleRecovery: "negotiated",
  observeThreadInteractions: "subscription", unobserveThreadInteractions: "subscription", interactionSubscriptionReady: "subscription",
  stageAttachments: "file-transfer", fetchOutputFile: "file-transfer",
  hasInFlightWork: "aggregate", hasRestartBlockingWork: "aggregate", isIndependentObservation: "aggregate",
  detachIndependentObservations: "aggregate", close: "aggregate"
} as const satisfies Record<keyof CodexBridgeBackend, string>;

export const NATIVE_CONTRACT_METHODS = new Set([
  "updateThreadSettings", "warmUp", "listSkills", "listMcpServers", "serverIdentity", "readThreadProvenance", "addQueuedSubmission",
  "listQueuedSubmissions", "deleteQueuedSubmission", "runQueuedSubmission", "recoverSystemError", "resumeAfterCapacity"
]);
