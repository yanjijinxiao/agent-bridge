import type { CodexBridgeBackend } from "./backend.js";

type Placement = number | "input" | "options" | "scope" | "shared";
/** Bind the existing facade once at the connection boundary. This is routing,
 * not a second implementation of any native command. Exhaustiveness matters:
 * a newly added backend port must not silently default to the local host. */
export const BACKEND_HOST_PLACEMENT = {
  withSource: "shared", findNativeInputReceipts: "scope", backendInfo: 0,
  run: "input", runEphemeral: "input", resumeAfterCapacity: "input",
  steer: 1, submitThreadMessage: 1, stop: 1, warmUp: 1, listProjects: 0,
  listThreads: 1, listSessionCatalog: 1, getHistory: 1, getHistoryPage: 2,
  readThreadSnapshot: 1, inspectThread: 1, getRuntimeInfo: 2, updateThreadSettings: 2, listModels: 0,
  getAccountRateLimits: 0, listSkills: 1, listMcpServers: 1, serverIdentity: 0,
  readThreadProvenance: 1, getGoal: 1, setGoal: 2, clearGoal: 1,
  createThread: 1, renameThread: 2, archiveThread: 1, unarchiveThread: 1,
  deleteThread: 1, interruptTurn: 2, readTurnLifecycle: 2, readTurnActivities: 2,
  addQueuedSubmission: 1, listQueuedSubmissions: 2, deleteQueuedSubmission: 2,
  runQueuedSubmission: "input", recoverSystemError: 1,
  observeThreadInteractions: 1, unobserveThreadInteractions: 1, interactionSubscriptionReady: 1,
  stageAttachments: "options", fetchOutputFile: "options", isIndependentObservation: "scope",
  systemErrorLifecycleRecovery: "shared", hasInFlightWork: "shared",
  hasRestartBlockingWork: "shared", detachIndependentObservations: "shared", close: "shared"
} as const satisfies Record<keyof CodexBridgeBackend, Placement>;

export function hostScopedBackend(backend: CodexBridgeBackend, hostId: string): CodexBridgeBackend {
  return new Proxy(backend, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    const placement = BACKEND_HOST_PLACEMENT[key as keyof CodexBridgeBackend];
    if (placement === undefined) throw new Error(`Backend port has no host contract: ${String(key)}`);
    return (...input: unknown[]) => {
      const args = [...input];
      if (typeof placement === "number") args[placement] = hostId;
      else if (placement !== "shared") {
        const index = placement === "options" ? 1 : 0;
        args[index] = { ...(args[index] as object), hostId };
      }
      return value.apply(target, args);
    };
  } });
}
