import crypto from "node:crypto";
import { CodexBackendCapabilityError, CodexTurnExecutionError, EXEC_BACKEND_CAPABILITIES,
  type CodexBridgeBackend, type CodexThreadState, type CodexTurnStatus, type CodexTurnObservation,
  type CodexInputReceipt, type CodexStopResult } from "../codex/backend.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { PeerRegistry } from "./registry.js";
import { PeerConnectionError, PeerError } from "./rpc.js";
import { peerPrincipal } from "./context.js";

/** Remote host routing decorates the existing facade; channel code continues
 * to use the same execution contract, including source/approval callbacks. */
export function withPeerBackend(local: CodexBridgeBackend, registry: PeerRegistry): CodexBridgeBackend {
  const operations = new Set<{ hostId: string; threadId: string; turnId?: string; independent: boolean; controller: AbortController }>();
  const describe = (hostId: string) => {
    try { return registry.description(hostId); }
    catch (error) { if (error instanceof PeerConnectionError) throw new CodexCommunicationError("preflight", "peer/discover", undefined, undefined, error); throw error; }
  };
  const native = (method: string, args: unknown[]) => {
    const fn = (local as any)[method];
    if (typeof fn !== "function") throw new CodexBackendCapabilityError("threadLifecycle", local.backendInfo().id);
    return fn.apply(local, args);
  };
  const invoke = async <T = unknown>(method: string, args: unknown[], hostId: string, write = false, input?: Record<string, any>): Promise<T> => {
    if (input?.dynamicTools?.length || input?.onDynamicToolCall || input?.ephemeral || input?.sandbox)
      throw new CodexBackendCapabilityError("dynamicTools", describe(hostId).info.id);
    if (input?.outputSchema) throw new CodexBackendCapabilityError("structuredOutput", describe(hostId).info.id);
    const principal = peerPrincipal.getStore();
    const operationId = write ? crypto.createHash("sha256").update(JSON.stringify([hostId, method,
      principal?.accountId, principal?.conversationId, principal?.actorId,
      input?.clientUserMessageId ?? crypto.randomUUID()])).digest("hex") : undefined;
    let acceptedTurnId: string | undefined;
    const scope: { hostId: string; threadId: string; turnId?: string; independent: boolean; controller: AbortController } | undefined = write
      ? { hostId, threadId: input?.threadId ?? String(args[0]), independent: describe(hostId).independent, controller: new AbortController() } : undefined;
    if (scope) operations.add(scope);
    const callback = async (name: string, values: unknown[]): Promise<unknown> => {
      if (!["assertCurrent", "onThreadCreated", "onTurnStarted", "onDelta", "onProgress", "onRecovery", "onApproval", "onApprovalResult", "onUserInput", "onUserInputResult"].includes(name))
        throw new PeerError("unsupported", "Unknown execution callback");
      if (name === "onTurnStarted") {
        const event = values[0] as { threadId: string; turnId: string; status?: CodexTurnStatus };
        if (!event || event.threadId !== scope?.threadId || typeof event.turnId !== "string") throw new PeerError("scope", "Invalid native acceptance");
        acceptedTurnId = event.turnId;
        await input?.onTurnStarted?.(event); // Gateway persistence precedes restart exemption.
        if (scope && (!event.status || event.status === "inProgress")) scope.turnId = event.turnId;
        return null;
      }
      if (name === "onThreadCreated" && values[0] !== scope?.threadId) throw new PeerError("scope", "The exported native thread cannot be replaced");
      if (name === "onApproval" || name.startsWith("onApprovalResult") || name === "onUserInput" || name === "onUserInputResult") {
        const request = values[0] as { threadId?: string; turnId?: string; hostId?: string };
        if (!request || request.threadId !== scope?.threadId) throw new PeerError("scope", "Invalid native interaction scope");
        if (acceptedTurnId && request.turnId !== acceptedTurnId) throw new PeerError("scope", "Invalid native interaction turn");
        values[0] = { ...request, hostId };
      }
      if (name === "onApproval" && !input?.onApproval) return "decline";
      return await input?.[name]?.(...values) ?? null;
    };
    const wireArgs = args.map(value => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key, item]) => typeof item !== "function" && item !== undefined && key !== "hostId")) : value);
    try { return await registry.invoke<T>(hostId, method, wireArgs, write, operationId, write ? callback : undefined, scope?.controller.signal); }
    catch (error) {
      if (error instanceof PeerConnectionError) throw new CodexCommunicationError(
        acceptedTurnId ? "observation" : write && error.sent ? "submission" : "preflight", method, scope?.threadId, acceptedTurnId, error);
      if (error instanceof PeerError && error.code === "codex-communication") {
        const data = error.data as any;
        throw new CodexCommunicationError(acceptedTurnId ? "observation" : ["preflight", "submission", "observation"].includes(data?.phase) ? data.phase : "submission",
          method, scope?.threadId, acceptedTurnId ?? data?.turnId);
      }
      if (error instanceof PeerError && error.code === "receipt") {
        const data = error.data as any;
        throw new CodexCommunicationError(data?.turnId ? "observation" : "submission", method, scope?.threadId, data?.turnId);
      }
      if (error instanceof PeerError && error.code === "turn-failed") {
        const data = error.data as any;
        throw new CodexTurnExecutionError(data?.status === "interrupted" ? "interrupted" : "failed", error.message, data?.failureCode);
      }
      throw error;
    } finally { if (scope) operations.delete(scope); }
  };
  const route = (method: string, args: unknown[], hostId?: string, write = false, input?: Record<string, any>) => registry.isPeer(hostId)
    ? invoke(method, args, hostId!, write, input) : native(method, args);
  const unsupported = (capability: keyof typeof EXEC_BACKEND_CAPABILITIES, hostId: string) => {
    throw new CodexBackendCapabilityError(capability, describe(hostId).info.id);
  };
  const overrides: Partial<CodexBridgeBackend> = {
    backendInfo(hostId) { return registry.isPeer(hostId) ? describe(hostId!).info : local.backendInfo(hostId); },
    run: input => route("run", [input], input.hostId, true, input),
    steer: async (input, hostId) => {
      if (!registry.isPeer(hostId)) return local.steer(input, hostId);
      const scoped = { ...input, cwd: input.cwd ?? (await overrides.inspectThread!(input.threadId, hostId)).cwd };
      return invoke<CodexInputReceipt>("steer", [scoped], hostId!, true, scoped);
    },
    submitThreadMessage: (input, hostId) => route("submitThreadMessage", [input, hostId], hostId, true, input),
    stop: (threadId, hostId, assertCurrent) => registry.isPeer(hostId)
      ? invoke<CodexStopResult>("stop", [threadId], hostId!, true, { threadId, assertCurrent }) : local.stop(threadId, hostId, assertCurrent),
    readThreadSnapshot: (id, host) => route("readThreadSnapshot", [id, host], host),
    getHistory: (id, host) => route("getHistory", [id, host], host),
    getHistoryPage: (id, page, host) => route("getHistoryPage", [id, page, host], host),
    getRuntimeInfo: (cwd, id, host, observation) => route("getRuntimeInfo", [cwd, id, host, observation], host),
    listModels: (host?: string) => route("listModels", [host], host),
    getAccountRateLimits: (host?: string) => route("getAccountRateLimits", [host], host),
    inspectThread: (id, host, observation) => route("inspectThread", [id, host, observation], host),
    async listSessionCatalog(input, host) {
      if (!registry.isPeer(host)) return local.listSessionCatalog(input, host);
      const description = describe(host!);
      if (!description.thread) {
        const catalog = await invoke<import("../codex/backend.js").CodexSessionCatalog>("listSessionCatalog", [input ?? {}], host!);
        return { ...catalog, hostIds: [host!] };
      }
      const state = await invoke("inspectThread", [description.thread.threadId], host!) as CodexThreadState;
      const visible = (!input?.cwd || input.cwd === state.cwd) && (!input?.projectId || input.projectId === state.projectId)
        && (!input?.unassigned || state.projectMembership === "none") && (input?.persistence !== "archived");
      return { backend: description.info.id, source: description.info.id === "exec" ? "cli-rollouts" : "app-server-storage",
        threads: visible ? [state] : [], hostIds: [host!], complete: true, warnings: [] };
    },
    async listThreads(input, host) { return registry.isPeer(host) ? (await overrides.listSessionCatalog!(input, host)).threads : local.listThreads(input, host); },
    async listProjects(host, observation) { return registry.isPeer(host) ? { backend: describe(host!).info.id, projects: [] } : local.listProjects(host, observation); },
    async warmUp(cwd, host) { if (!registry.isPeer(host)) await local.warmUp(cwd, host); },
    stageAttachments: async (files, input) => {
      if (registry.isPeer(input.hostId)) { if (files.length) throw new PeerError("unsupported", "第一版远程连接暂不支持附件传输，请使用文字。"); return []; }
      return local.stageAttachments ? local.stageAttachments(files, input) : [...files];
    },
    async getGoal(id, host) { return registry.isPeer(host) ? unsupported("goals", host!) : local.getGoal(id, host); },
    async setGoal(id, value, host, guard) { return registry.isPeer(host) ? unsupported("goals", host!) : local.setGoal(id, value, host, guard); },
    async clearGoal(id, host, guard) { if (registry.isPeer(host)) unsupported("goals", host!); else await local.clearGoal(id, host, guard); },
    async archiveThread(id, host) { if (registry.isPeer(host)) unsupported("threadLifecycle", host!); else await local.archiveThread(id, host); },
    async unarchiveThread(id, host) { return registry.isPeer(host) ? unsupported("threadLifecycle", host!) : local.unarchiveThread(id, host); },
    async deleteThread(id, host) { if (registry.isPeer(host)) unsupported("threadLifecycle", host!); else await local.deleteThread(id, host); },
    recoverSystemError: (input, host) => registry.isPeer(host) ? Promise.resolve({ status: "unsupported", reason: "owner-unsupported" })
      : local.recoverSystemError ? local.recoverSystemError(input, host) : Promise.resolve({ status: "unsupported" }),
    readThreadProvenance: (id, host) => registry.isPeer(host) ? Promise.resolve(undefined) : local.readThreadProvenance?.(id, host) ?? Promise.resolve(undefined),
    readTurnLifecycle: async (id, turn, host) => {
      if (!registry.isPeer(host)) return local.readTurnLifecycle?.(id, turn, host) ?? { status: "unknown", source: "unknown" };
      return invoke<CodexTurnObservation>("readTurnLifecycle", [id, turn], host!);
    },
    hasInFlightWork: () => operations.size > 0 || Boolean(local.hasInFlightWork?.()),
    hasRestartBlockingWork: () => [...operations].some(op => !op.independent || !op.turnId)
      || Boolean(local.hasRestartBlockingWork?.() ?? local.hasInFlightWork?.()),
    isIndependentObservation: scope => [...operations].some(op => op.independent && op.hostId === scope.hostId && op.threadId === scope.threadId && op.turnId === scope.turnId)
      || Boolean(local.isIndependentObservation?.(scope)),
    detachIndependentObservations() {
      for (const op of operations) if (op.independent && op.turnId) op.controller.abort();
      local.detachIndependentObservations?.();
    },
    async close() { for (const op of operations) op.controller.abort(); await local.close(); }
  };
  // Explicitly reject optional native writes instead of letting a peer host
  // fall through the old SSH branch or the local executor.
  for (const method of ["addQueuedSubmission", "listQueuedSubmissions", "deleteQueuedSubmission", "runQueuedSubmission", "resumeAfterCapacity"] as const) {
    (overrides as any)[method] = (...args: any[]) => {
      const host = method === "runQueuedSubmission" || method === "resumeAfterCapacity" ? args[0]?.hostId
        : method === "addQueuedSubmission" ? args[1] : args[2];
      if (registry.isPeer(host)) return unsupported("nativeQueue", host);
      return native(method, args);
    };
  }
  return new Proxy(local, { get(target, key) {
    const value = Object.hasOwn(overrides, key) ? (overrides as any)[key] : Reflect.get(target, key);
    return typeof value === "function" ? value.bind(Object.hasOwn(overrides, key) ? overrides : target) : value;
  } });
}
