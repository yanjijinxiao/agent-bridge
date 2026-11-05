import { NATIVE_CONTRACT_METHODS } from "./contract.js";
import { PeerInteractionClient } from "./interaction-client.js";
import crypto from "node:crypto";
import { peerOperationId } from "./identity.js";
import { NativeInputReceiptObserver } from "../bridge/native-input-recovery.js";
import type { PeerPrincipal } from "./context.js";
import { CodexBackendCapabilityError, CodexQueueAdmissionError, CodexInterventionError, CodexThreadStateError, CodexRunAdmissionError, CodexTurnExecutionError, EXEC_BACKEND_CAPABILITIES,
  type CodexBridgeBackend, type CodexThreadState, type CodexTurnStatus, type CodexTurnObservation,
  type CodexInputReceipt, type CodexStopResult, APP_SERVER_BACKEND_CAPABILITIES } from "../codex/backend.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { PeerRegistry } from "./registry.js";
import { PeerConnectionError, PeerError } from "./rpc.js";
import { peerPrincipal } from "./context.js";
import { gatewayServicePrincipal } from "./managed-route.js";
import { downloadPeerFile, uploadPeerFiles } from "./files.js";


/** Remote host routing decorates the existing facade; channel code continues
 * to use the same execution contract, including source/approval callbacks. */
export function withPeerBackend(local: CodexBridgeBackend, registry: PeerRegistry,
  recoverySource?: (scope: { hostId: string; threadId: string }) => { source: PeerPrincipal; assertCurrent: () => void } | undefined,
  onThreadMutation?: (threadId: string, hostId: string) => void): CodexBridgeBackend {
  const interactions = new PeerInteractionClient(registry);
  const receiptObserver = new NativeInputReceiptObserver();
  const queueCallbacks = new Map<string, () => void>();
  const queueItems = new Map<string, string>();
  const operations = new Set<{ hostId: string; threadId: string; turnId?: string; independent: boolean; controller: AbortController }>();
  const describe = (hostId = "local") => {
    try { return registry.description(hostId); }
    catch (error) { if (error instanceof PeerConnectionError) throw new CodexCommunicationError("preflight", "peer/discover", undefined, undefined, error); throw error; }
  };
  const native = (method: string, args: unknown[]) => {
    const fn = (local as any)[method];
    if (typeof fn !== "function") throw new CodexBackendCapabilityError("threadLifecycle", local.backendInfo().id);
    return fn.apply(local, args);
  };
  const invoke = async <T = unknown>(method: string, args: unknown[], hostId: string, write = false, input?: Record<string, any>): Promise<T> => {
    hostId ??= "local";
    if (["run", "steer", "submitThreadMessage", "stop", "interruptTurn", "addQueuedSubmission", "setGoal", "clearGoal", "renameThread", "archiveThread", "unarchiveThread", "deleteThread"].includes(method)) {
      const threadId = input?.threadId; if (threadId) onThreadMutation?.(threadId, hostId);
    }
    if ((NATIVE_CONTRACT_METHODS.has(method) || input?.nativeSettings || input?.imagePaths?.length || input?.dynamicTools?.length
      || input?.onDynamicToolCall || input?.outputSchema || method === "run" && !input?.threadId) && describe(hostId).nativeContract !== 1)
      throw new PeerError("unsupported", "请升级 Connector：此接口需要 nativeContract: 1。");
    const authority = !peerPrincipal.getStore() && ["recoverSystemError", "resumeAfterCapacity"].includes(method)
      ? recoverySource?.({ hostId, threadId: input?.threadId }) : undefined;
    const principal = peerPrincipal.getStore() ?? input?.assertCurrent?.source ?? authority?.source ?? (registry.managedRoute(hostId) ? gatewayServicePrincipal : undefined);
    const operationId = write ? peerOperationId(hostId, method, principal, input?.clientUserMessageId ?? crypto.randomUUID()) : undefined;
    let acceptedTurnId: string | undefined;
    // Channel controllers associate native receipts with the exact request
    // object. Restore that identity after JSON transport, within this operation.
    const interactionRequests = new Map<string, unknown>();
    const answeredInteractions = new Set<string>();
    const scope: { hostId: string; threadId: string; turnId?: string; independent: boolean; controller: AbortController } | undefined = write
      ? { hostId, threadId: (method === "createThread" || method === "run" && !input?.threadId) ? "new" : input?.threadId ?? String(args[0]), independent: describe(hostId).independent && !input?.dynamicTools?.length && !input?.onDynamicToolCall, controller: new AbortController() } : undefined;
    if (scope) operations.add(scope);
    const releaseCallback = operationId ? registry.callbackLease(hostId, operationId) : () => {};
    let retireQueue: (() => void) | undefined;
    let retainQueue = false;
    let queueRetired = false;
    const callback = async (name: string, values: unknown[]): Promise<unknown> => {
      if (name === "queueRetired" && method === "addQueuedSubmission") { queueRetired = true; retireQueue?.(); return null; }
      if (name === "assertCurrent") authority?.assertCurrent();
      let interactionKey: string | undefined;
      if (!["assertCurrent", "onThreadCreated", "onTurnStarted", "onDelta", "onItem", "onProgress", "onRecovery", "onApproval", "onApprovalResult", "onUserInput", "onUserInputResult", "onDynamicToolCall", "onAccepted", "onQueueStarting", "beforeArchive", "archived", "restored"].includes(name))
        throw new PeerError("unsupported", "Unknown execution callback");
      if (name === "onTurnStarted") {
        const event = values[0] as { threadId: string; turnId: string; status?: CodexTurnStatus };
        if (!event || event.threadId !== scope?.threadId || typeof event.turnId !== "string") throw new PeerError("scope", "Invalid native acceptance");
        acceptedTurnId = event.turnId;
        await input?.onTurnStarted?.(event); // Gateway persistence precedes restart exemption.
        if (scope && (!event.status || event.status === "inProgress")) scope.turnId = event.turnId;
        return null;
      }
      if (name === "onThreadCreated") {
        if ((method === "createThread" || method === "run") && scope?.threadId === "new" && typeof values[0] === "string" && values[0]) scope.threadId = values[0];
        else if (values[0] !== scope?.threadId) throw new PeerError("scope", "The exported native thread cannot be replaced");
      }
      if (name === "onApproval" || name.startsWith("onApprovalResult") || name === "onUserInput" || name === "onUserInputResult") {
        const request = values[0] as { threadId?: string; turnId?: string; hostId?: string };
        if (!request || request.threadId !== scope?.threadId) throw new PeerError("scope", "Invalid native interaction scope");
        if (acceptedTurnId && request.turnId !== acceptedTurnId) throw new PeerError("scope", "Invalid native interaction turn");
        values[0] = { ...request, hostId };
        const requestKind = name === "onApproval" || name === "onApprovalResult" ? "approval" : "question";
        const key = JSON.stringify([requestKind, values[0]]); interactionKey = key;
        if (name === "onApproval" || name === "onUserInput") {
          const existing = interactionRequests.get(key);
          if (existing) values[0] = existing;
          else interactionRequests.set(key, values[0]);
        } else {
          const original = interactionRequests.get(key);
          if (!original) throw new PeerError("scope", "Native interaction receipt has no matching request");
          values[0] = original;
        }
      }
      if (["beforeArchive", "archived", "restored"].includes(name)) return await input?.lifecycle?.[name]?.() ?? null;
      if (name === "onDynamicToolCall") {
        const call = values[0] as { threadId?: string; turnId?: string };
        if (call?.threadId !== scope?.threadId || acceptedTurnId && call.turnId !== acceptedTurnId)
          throw new PeerError("scope", "Invalid dynamic tool scope");
        if (!input?.onDynamicToolCall) throw new PeerError("unsupported", "No source dynamic tool handler");
      }
      if (name === "onAccepted") {
        if (typeof values[0] !== "string" || !values[0]) throw new PeerError("scope", "Invalid queue acceptance");
        acceptedTurnId = values[0];
      }
      if (name === "onApproval" && !input?.onApproval) return null;
      try {
        const result = await input?.[name]?.(...values) ?? null;
        if (interactionKey && result !== null && (name === "onApproval" || name === "onUserInput")) answeredInteractions.add(interactionKey);
        return result;
      } finally {
        if (interactionKey && (name === "onApprovalResult" || name === "onUserInputResult")) {
          interactionRequests.delete(interactionKey); answeredInteractions.delete(interactionKey);
        }
      }
    };
    const wireArgs = args.map(value => value && typeof value === "object" && !Array.isArray(value)
      ? { ...Object.fromEntries(Object.entries(value).filter(([key, item]) => typeof item !== "function" && item !== undefined && key !== "hostId")),
        ...((value as any).onDynamicToolCall ? { _dynamicToolCallback: true } : {}) } : value);
    const retireInteractions = () => {
      for (const [key, request] of interactionRequests) {
        const handler = key.startsWith('["approval"') ? input?.onApprovalResult : input?.onUserInputResult;
        try { void Promise.resolve(handler?.(request, answeredInteractions.has(key) ? "failed" : "withdrawn")).catch(() => {}); } catch { /* No native answer. */ }
      }
      interactionRequests.clear();
    };
    try {
      const result = await peerPrincipal.run(principal!, () => registry.invoke<T>(hostId, method, wireArgs, write, operationId, write ? callback : undefined,
        scope?.controller.signal, undefined, method === "addQueuedSubmission"));
      if (method === "addQueuedSubmission" && operationId && (result as any)?._peerQueueCallback && !queueRetired && !queueCallbacks.has(operationId)) {
        retainQueue = true;
        let detach = () => {};
        const itemKey = JSON.stringify([hostId, scope!.threadId, (result as any).id]);
        queueItems.set(itemKey, operationId);
        retireQueue = () => { releaseCallback(); queueCallbacks.delete(operationId); queueItems.delete(itemKey); detach(); retireInteractions(); };
        queueCallbacks.set(operationId, retireQueue);
        detach = registry.onDisconnect(hostId, retireQueue);
      }
      if (method === "addQueuedSubmission" && result && typeof result === "object") {
        if ((!(result as any)._peerQueueCallback || queueRetired) && operationId && !queueCallbacks.has(operationId)) releaseCallback();
        const { _peerQueueCallback, ...item } = result as any; return item;
      }
      if (method === "deleteQueuedSubmission" && result === true || method === "runQueuedSubmission") {
        const itemKey = JSON.stringify([hostId, scope?.threadId, method === "deleteQueuedSubmission" ? args[1] : input?.queuedSubmissionId]);
        const queueOperation = queueItems.get(itemKey);
        if (queueOperation) queueCallbacks.get(queueOperation)?.();
      }
      return result;
    }
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
      if (error instanceof PeerError && error.code === "run-admission") {
        if (acceptedTurnId) throw new CodexCommunicationError("observation", method, scope?.threadId, acceptedTurnId);
        const reason = (error.data as { reason?: unknown })?.reason;
        if (reason === "active" || reason === "handoff") throw new CodexRunAdmissionError(reason, scope?.threadId);
        throw new CodexCommunicationError("submission", method, scope?.threadId);
      }
      if (error instanceof PeerError && error.code === "capability")
        throw new CodexBackendCapabilityError((error.data as any).capability, describe(hostId).info.id);
      if (error instanceof PeerError && error.code === "queue-admission") throw new CodexQueueAdmissionError(error.message);
      if (error instanceof PeerError && error.code === "intervention") throw new CodexInterventionError(error.message);
      if (error instanceof PeerError && error.code === "thread-state") {
        const data = error.data as any;
        throw new CodexThreadStateError(data.code, data.threadId, error.message, data.lastTurnFailure, data.systemRecovery);
      }
      if (error instanceof PeerError && error.code === "turn-failed") {
        const data = error.data as any;
        throw new CodexTurnExecutionError(data?.status === "interrupted" ? "interrupted" : "failed", error.message, data?.failureCode);
      }
      throw error;
    } finally {
      if (scope) operations.delete(scope);
      if (!retainQueue) retireInteractions();
    }
  };
  const route = (method: string, args: unknown[], hostId?: string, write = false, input?: Record<string, any>) => registry.isRouted(hostId)
    ? invoke(method, args, hostId!, write, input) : native(method, args);
  const unsupported = (capability: keyof typeof EXEC_BACKEND_CAPABILITIES, hostId: string) => {
    throw new CodexBackendCapabilityError(capability, describe(hostId).info.id);
  };
  const manage = async <T>(method: string, input: Record<string, any>, hostId: string): Promise<T> => {
    const description = describe(hostId);
    if (!description.management) throw new PeerError("unsupported", "设备尚未启用会话管理，请更新 Connector。");
    if (!(method === "renameThread" ? description.info.capabilities.threadNaming : description.info.capabilities.threadLifecycle))
      throw new PeerError("unsupported", "当前设备后端不支持这项会话管理操作。");
    if (method === "createThread" && description.thread) throw new PeerError("scope", "固定会话授权不能新建其他会话。");
    return invoke<T>(method, [input], hostId, true, input);
  };
  const overrides: Partial<CodexBridgeBackend> = {
    withSource: (source, action) => peerPrincipal.run(source, action),
    async findNativeInputReceipts(scope, sources) {
      if (!registry.isRouted(scope.hostId)) return local.findNativeInputReceipts
        ? local.findNativeInputReceipts(scope, sources)
        : receiptObserver.observe("local", local, scope, new Set(sources.map(source => source.clientUserMessageId)));
      const groups = new Map<string, { principal: PeerPrincipal; ids: Map<string, string> }>();
      for (const source of sources) {
        // Legacy records without exact identity cannot borrow another user's
        // device grant, even when background recovery has no ambient principal.
        if ((!source.accountId || !source.conversationId || !source.actorId) && !registry.managedRoute(scope.hostId)) continue;
        const principal = source.accountId && source.conversationId && source.actorId
          ? { accountId: source.accountId, conversationId: source.conversationId, actorId: source.actorId } : gatewayServicePrincipal;
        const key = JSON.stringify(principal);
        const group = groups.get(key) ?? { principal, ids: new Map<string, string>() };
        // Direct submissions made before migration retain their native IDs.
        if (registry.managedRoute(scope.hostId)) group.ids.set(source.clientUserMessageId, source.clientUserMessageId);
        for (const method of ["run", "steer", "submitThreadMessage"])
          group.ids.set(`peer-${peerOperationId(scope.hostId, method, principal, source.clientUserMessageId)}`, source.clientUserMessageId);
        groups.set(key, group);
      }
      const matches = new Map<string, Set<string>>();
      for (const { principal, ids } of groups.values()) {
        const proofs = await peerPrincipal.run(principal, () => receiptObserver.observe(JSON.stringify(principal), {
          getHistoryPage: (id, page, host) => invoke("getHistoryPage", [id, page, host], host!)
        }, scope, new Set(ids.keys())));
        for (const [nativeId, turnId] of proofs) {
          const originalId = ids.get(nativeId)!;
          const turns = matches.get(originalId) ?? new Set<string>(); turns.add(turnId); matches.set(originalId, turns);
        }
      }
      return new Map([...matches].filter(([, turns]) => turns.size === 1).map(([id, turns]) => [id, [...turns][0]]));
    },
    backendInfo(hostId) {
      if (registry.managedRoute(hostId) && !registry.isOnline(hostId ?? "local")) return { id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES };
      return registry.isRouted(hostId) ? describe(hostId).info : local.backendInfo(hostId);
    },
    runEphemeral: input => registry.isRouted(input.hostId)
      ? invoke("run", [{ ...input, ephemeral: true, sandbox: "read-only" }], input.hostId ?? "local", true, input) : local.runEphemeral(input),
    run: input => route("run", [input], input.hostId, true, input),
    steer: async (input, hostId) => {
      if (!registry.isRouted(hostId)) return local.steer(input, hostId);
      const scoped = { ...input, cwd: input.cwd ?? (await overrides.inspectThread!(input.threadId, hostId)).cwd };
      return invoke<CodexInputReceipt>("steer", [scoped], hostId!, true, scoped);
    },
    submitThreadMessage: (input, hostId) => route("submitThreadMessage", [input, hostId], hostId, true, input),
    stop: (threadId, hostId, assertCurrent) => registry.isRouted(hostId)
      ? invoke<CodexStopResult>("stop", [threadId], hostId!, true, { threadId, assertCurrent }) : local.stop(threadId, hostId, assertCurrent),
    readThreadSnapshot: (id, host) => route("readThreadSnapshot", [id, host], host),
    getHistory: (id, host) => route("getHistory", [id, host], host),
    getHistoryPage: (id, page, host) => route("getHistoryPage", [id, page, host], host),
    getRuntimeInfo: (cwd, id, host, observation) => route("getRuntimeInfo", [cwd, id, host, observation], host),
    listModels: (host?: string) => route("listModels", [host], host),
    getAccountRateLimits: (host?: string, model?: string) => registry.isRouted(host)
      ? invoke("getAccountRateLimits", [host, model], host!) : local.getAccountRateLimits(host, model),
    inspectThread: (id, host, observation) => route("inspectThread", [id, host, observation], host),
    async listSessionCatalog(input, host) {
      if (!registry.isRouted(host)) return local.listSessionCatalog(input, host);
      const description = describe(host!);
      if (!description.thread) {
        const catalog = await invoke<import("../codex/backend.js").CodexSessionCatalog>("listSessionCatalog", [input ?? {}], host!);
        return { ...catalog, hostIds: registry.managedRoute(host) ? registry.managedHosts() : [host!] };
      }
      const state = await invoke("inspectThread", [description.thread.threadId], host!) as CodexThreadState;
      const visible = (!input?.cwd || input.cwd === state.cwd) && (!input?.projectId || input.projectId === state.projectId)
        && (!input?.unassigned || state.projectMembership === "none")
        && (input?.persistence === "all" || state.persistence === (input?.persistence ?? "active"));
      return { backend: description.info.id, source: description.info.id === "exec" ? "cli-rollouts" : "app-server-storage",
        threads: visible ? [state] : [], hostIds: [host!], complete: true, warnings: [] };
    },
    async listThreads(input, host) { return registry.isRouted(host) ? (await overrides.listSessionCatalog!(input, host)).threads : local.listThreads(input, host); },
    async listProjects(host, observation) {
      if (!registry.isRouted(host)) return local.listProjects(host, observation);
      const description = describe(host!);
      if (description.thread) return { backend: description.info.id, projects: [] };
      if (!description.management) throw new PeerError("unsupported", "设备尚未启用项目目录，请更新 Connector。");
      return invoke<import("../codex/backend.js").CodexProjectCatalog>("listProjects", [observation], host!);
    },
    async warmUp(cwd, host) { if (registry.isRouted(host)) await invoke("warmUp", [cwd], host!); else await local.warmUp(cwd, host); },
    stageAttachments: async (files, input) => {
      if (registry.isRouted(input.hostId)) {
        if (!files.length) return [];
        if (!input.accountId || !input.conversationId || !input.threadId) throw new PeerError("scope", "Attachment staging requires a selected chat and thread");
        const principal = peerPrincipal.getStore();
        if (!principal || principal.accountId !== input.accountId || principal.conversationId !== input.conversationId
          || !registry.managedRoute(input.hostId) && !registry.hosts(principal).includes(input.hostId!)) throw new PeerError("access", "File transfer has no authorized chat identity");
        if (!describe(input.hostId!).files) throw new PeerError("unsupported", "设备尚未启用文件传输，请更新 Connector。");
        const scope = { accountId: input.accountId, conversationId: input.conversationId, threadId: input.threadId };
        return uploadPeerFiles(files, input.scope, input.threadId, input.maxBytes,
          (method, payload) => registry.invokeFile(input.hostId!, method, payload, scope));
      }
      return local.stageAttachments ? local.stageAttachments(files, input) : [...files];
    },
    fetchOutputFile: async (remotePath, input) => {
      if (registry.isRouted(input.hostId)) {
        if (!describe(input.hostId).files) throw new PeerError("unsupported", "设备尚未启用文件传输，请更新 Connector。");
        if (!input.accountId || !input.conversationId || !input.threadId) throw new PeerError("scope", "Output transfer requires a selected chat and thread");
        const scope = { accountId: input.accountId, conversationId: input.conversationId, threadId: input.threadId };
        return downloadPeerFile(input.threadId, remotePath, input.maxBytes,
          (method, payload) => registry.invokeFile(input.hostId, method, payload, scope), input.directory);
      }
      if (local.fetchOutputFile) return local.fetchOutputFile(remotePath, input);
      throw new PeerError("unsupported", "This execution host has no output file transfer transport");
    },
    getGoal: async (id, host) => (await route("getGoal", [id, host], host)) ?? undefined,
    setGoal: (id, value, host, assertCurrent) => registry.isRouted(host)
      ? invoke<import("../codex/backend.js").CodexThreadGoal | null>("setGoal", [id, value], host!, true, { threadId: id, assertCurrent }).then(value => value ?? undefined) : local.setGoal(id, value, host, assertCurrent),
    clearGoal: async (id, host, assertCurrent) => {
      if (registry.isRouted(host)) await invoke("clearGoal", [id], host!, true, { threadId: id, assertCurrent });
      else await local.clearGoal(id, host, assertCurrent);
    },
    createThread: (input, host) => registry.isRouted(host) ? manage("createThread", input, host!) : native("createThread", [input, host]),
    renameThread: (id, title, host, assertCurrent, clientUserMessageId) => registry.isRouted(host)
      ? manage("renameThread", { threadId: id, title, assertCurrent, clientUserMessageId }, host!) : native("renameThread", [id, title, host, assertCurrent]),
    async archiveThread(id, host, assertCurrent, clientUserMessageId) {
      if (registry.isRouted(host)) await manage("archiveThread", { threadId: id, assertCurrent, clientUserMessageId }, host!);
      else await local.archiveThread(id, host, assertCurrent);
    },
    unarchiveThread: (id, host, assertCurrent, clientUserMessageId) => registry.isRouted(host)
      ? manage("unarchiveThread", { threadId: id, assertCurrent, clientUserMessageId }, host!) : local.unarchiveThread(id, host, assertCurrent),
    async deleteThread(id, host, assertCurrent, clientUserMessageId) {
      if (registry.isRouted(host)) await manage("deleteThread", { threadId: id, assertCurrent, clientUserMessageId }, host!);
      else await local.deleteThread(id, host, assertCurrent);
    },
    recoverSystemError: (input, host) => registry.isRouted(host) ? invoke("recoverSystemError", [input], host!, true, input)
      : local.recoverSystemError ? local.recoverSystemError(input, host) : Promise.resolve({ status: "unsupported" }),
    readThreadProvenance: (id, host) => registry.isRouted(host) ? invoke<import("../codex/backend.js").CodexThreadProvenance | null>("readThreadProvenance", [id], host!).then(value => value ?? undefined) : local.readThreadProvenance?.(id, host) ?? Promise.resolve(undefined),
    readTurnLifecycle: async (id, turn, host) => {
      if (!registry.isRouted(host)) return local.readTurnLifecycle?.(id, turn, host) ?? { status: "unknown", source: "unknown" };
      return invoke<CodexTurnObservation>("readTurnLifecycle", [id, turn], host!);
    },
    readTurnActivities: (id, turn, host) => route("readTurnActivities", [id, turn, host], host),
    // Every host-scoped port is routed explicitly; a peer never reaches the local core.
    interruptTurn: async (id, turn, host, assertCurrent) => {
      if (registry.isRouted(host)) await invoke("interruptTurn", [id, turn], host!, true, { threadId: id, assertCurrent });
      else await native("interruptTurn", [id, turn, host, assertCurrent]);
    },
    listSkills: async (cwd, host) => registry.isRouted(host) ? invoke("listSkills", [cwd], host!) : native("listSkills", [cwd, host]),
    listMcpServers: async (id, host) => registry.isRouted(host) ? invoke("listMcpServers", [id], host!) : native("listMcpServers", [id, host]),
    observeThreadInteractions: (id, host, observer, consumer) => registry.isRouted(host)
      ? interactions.observe(id, host, observer, consumer) : native("observeThreadInteractions", [id, host, observer, consumer]),
    unobserveThreadInteractions: (id, host, consumer) => registry.isRouted(host)
      ? interactions.unobserve(id, host, consumer) : native("unobserveThreadInteractions", [id, host, consumer]),
    interactionSubscriptionReady: (id, host, consumer) => registry.isRouted(host) ? interactions.ready(id, host, consumer) : Boolean(local.interactionSubscriptionReady?.(id, host, consumer)),
    serverIdentity: async host => {
      if (registry.isRouted(host)) return invoke("serverIdentity", [], host!);
      return native("serverIdentity", [host]);
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
    async close() { receiptObserver.clear(); for (const retire of queueCallbacks.values()) retire(); await interactions.close(); for (const op of operations) op.controller.abort(); await local.close(); }
  };
  overrides.addQueuedSubmission = (input, host) => registry.isRouted(host)
    ? invoke("addQueuedSubmission", [input], host!, true, input) : native("addQueuedSubmission", [input, host]);
  overrides.listQueuedSubmissions = (id, cursor, host) => route("listQueuedSubmissions", [id, cursor, host], host);
  overrides.deleteQueuedSubmission = (id, queuedId, host, assertCurrent) => registry.isRouted(host)
    ? invoke("deleteQueuedSubmission", [id, queuedId], host!, true, { threadId: id, assertCurrent })
    : native("deleteQueuedSubmission", [id, queuedId, host, assertCurrent]);
  overrides.runQueuedSubmission = input => {
    if (!registry.isRouted(input.hostId)) return native("runQueuedSubmission", [input]);
    const { prompt: _presentationOnly, ...wire } = input as typeof input & { prompt?: string };
    return invoke("runQueuedSubmission", [wire], input.hostId!, true, input);
  };
  overrides.resumeAfterCapacity = input => route("resumeAfterCapacity", [input], input.hostId, true, input);
  return new Proxy(local, { get(target, key) {
    const value = Object.hasOwn(overrides, key) ? (overrides as any)[key] : Reflect.get(target, key);
    return typeof value === "function" ? value.bind(Object.hasOwn(overrides, key) ? overrides : target) : value;
  } });
}

/** Production Gateway has no native core. Unconfigured/offline hosts fail
 * before submission; this base cannot spawn Codex, use SSH or replay input. */
export function connectorOnlyBackend(registry: PeerRegistry,
  recoverySource?: Parameters<typeof withPeerBackend>[2],
  onThreadMutation?: Parameters<typeof withPeerBackend>[3]): CodexBridgeBackend {
  const base = {
    systemErrorLifecycleRecovery: true,
    backendInfo: () => ({ id: "app-server" as const, capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
    hasInFlightWork: () => false, hasRestartBlockingWork: () => false, isIndependentObservation: () => false,
    detachIndependentObservations() {}, close() {}
  };
  const unavailable = new Proxy(base, { get(target, key) {
    if (Reflect.has(target, key)) return Reflect.get(target, key);
    if (key === "then") return undefined;
    return () => { throw new CodexCommunicationError("preflight", `connector/not-configured/${String(key)}`); };
  } }) as unknown as CodexBridgeBackend;
  return withPeerBackend(unavailable, registry, recoverySource, onThreadMutation);
}
