import { PeerInteractionClient } from "./interaction-client.js";
import crypto from "node:crypto";
import { findNativeInputReceipts } from "../bridge/native-input-recovery.js";
import type { PeerPrincipal } from "./context.js";
import { CodexBackendCapabilityError, CodexRunAdmissionError, CodexTurnExecutionError, EXEC_BACKEND_CAPABILITIES,
  type CodexBridgeBackend, type CodexThreadState, type CodexTurnStatus, type CodexTurnObservation,
  type CodexInputReceipt, type CodexStopResult } from "../codex/backend.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { PeerRegistry } from "./registry.js";
import { PeerConnectionError, PeerError } from "./rpc.js";
import { peerPrincipal } from "./context.js";
import { downloadPeerFile, uploadPeerFiles } from "./files.js";

function peerOperationId(hostId: string, method: string, principal: PeerPrincipal | undefined, sourceId: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([hostId, method,
    principal?.accountId, principal?.conversationId, principal?.actorId, sourceId])).digest("hex");
}

/** Remote host routing decorates the existing facade; channel code continues
 * to use the same execution contract, including source/approval callbacks. */
export function withPeerBackend(local: CodexBridgeBackend, registry: PeerRegistry): CodexBridgeBackend {
  const interactions = new PeerInteractionClient(registry);
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
    if (input?.nativeSettings || input?.imagePaths?.length)
      throw new PeerError("unsupported", "Connector 尚未开放远程权限设置或原生图片路径；请使用设备权限和附件传输。");
    const principal = peerPrincipal.getStore();
    const operationId = write ? peerOperationId(hostId, method, principal, input?.clientUserMessageId ?? crypto.randomUUID()) : undefined;
    let acceptedTurnId: string | undefined;
    // Channel controllers associate native receipts with the exact request
    // object. Restore that identity after JSON transport, within this operation.
    const interactionRequests = new Map<string, unknown>();
    const answeredInteractions = new Set<string>();
    const scope: { hostId: string; threadId: string; turnId?: string; independent: boolean; controller: AbortController } | undefined = write
      ? { hostId, threadId: method === "createThread" ? "new" : input?.threadId ?? String(args[0]), independent: describe(hostId).independent, controller: new AbortController() } : undefined;
    if (scope) operations.add(scope);
    const callback = async (name: string, values: unknown[]): Promise<unknown> => {
      let interactionKey: string | undefined;
      if (!["assertCurrent", "onThreadCreated", "onTurnStarted", "onDelta", "onItem", "onProgress", "onRecovery", "onApproval", "onApprovalResult", "onUserInput", "onUserInputResult"].includes(name))
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
        if (method === "createThread" && scope?.threadId === "new" && typeof values[0] === "string" && values[0]) scope.threadId = values[0];
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
      if (error instanceof PeerError && error.code === "run-admission") {
        if (acceptedTurnId) throw new CodexCommunicationError("observation", method, scope?.threadId, acceptedTurnId);
        const reason = (error.data as { reason?: unknown })?.reason;
        if (reason === "active" || reason === "handoff") throw new CodexRunAdmissionError(reason, scope?.threadId);
        throw new CodexCommunicationError("submission", method, scope?.threadId);
      }
      if (error instanceof PeerError && error.code === "turn-failed") {
        const data = error.data as any;
        throw new CodexTurnExecutionError(data?.status === "interrupted" ? "interrupted" : "failed", error.message, data?.failureCode);
      }
      throw error;
    } finally {
      if (scope) operations.delete(scope);
      // A lost run RPC also owns pending UI callbacks, even when the native
      // turn survives. Retire that route before a fresh observer replays it.
      for (const [key, request] of interactionRequests) {
        const result = answeredInteractions.has(key) ? "failed" : "withdrawn";
        const handler = key.startsWith('["approval"') ? input?.onApprovalResult : input?.onUserInputResult;
        try { void Promise.resolve(handler?.(request, result)).catch(() => {}); } catch { /* UI failure cannot manufacture a native answer. */ }
      }
      interactionRequests.clear();
    }
  };
  const route = (method: string, args: unknown[], hostId?: string, write = false, input?: Record<string, any>) => registry.isPeer(hostId)
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
    async findNativeInputReceipts(scope, sources) {
      if (!registry.isPeer(scope.hostId)) return local.findNativeInputReceipts
        ? local.findNativeInputReceipts(scope, sources)
        : findNativeInputReceipts(local, scope, new Set(sources.map(source => source.clientUserMessageId)));
      const groups = new Map<string, { principal: PeerPrincipal; ids: Map<string, string> }>();
      for (const source of sources) {
        // Legacy records without exact identity cannot borrow another user's
        // device grant, even when background recovery has no ambient principal.
        if (!source.accountId || !source.conversationId || !source.actorId) continue;
        const principal = { accountId: source.accountId, conversationId: source.conversationId, actorId: source.actorId };
        const key = JSON.stringify(principal);
        const group = groups.get(key) ?? { principal, ids: new Map<string, string>() };
        for (const method of ["run", "steer", "submitThreadMessage"])
          group.ids.set(`peer-${peerOperationId(scope.hostId, method, principal, source.clientUserMessageId)}`, source.clientUserMessageId);
        groups.set(key, group);
      }
      const matches = new Map<string, Set<string>>();
      for (const { principal, ids } of groups.values()) {
        const proofs = await peerPrincipal.run(principal, () => findNativeInputReceipts({
          getHistoryPage: (id, page, host) => invoke("getHistoryPage", [id, page, host], host!)
        }, scope, new Set(ids.keys())));
        for (const [nativeId, turnId] of proofs) {
          const originalId = ids.get(nativeId)!;
          const turns = matches.get(originalId) ?? new Set<string>(); turns.add(turnId); matches.set(originalId, turns);
        }
      }
      return new Map([...matches].filter(([, turns]) => turns.size === 1).map(([id, turns]) => [id, [...turns][0]]));
    },
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
    getAccountRateLimits: (host?: string, model?: string) => registry.isPeer(host)
      ? invoke("getAccountRateLimits", [host, model], host!) : local.getAccountRateLimits(host, model),
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
        && (!input?.unassigned || state.projectMembership === "none")
        && (input?.persistence === "all" || state.persistence === (input?.persistence ?? "active"));
      return { backend: description.info.id, source: description.info.id === "exec" ? "cli-rollouts" : "app-server-storage",
        threads: visible ? [state] : [], hostIds: [host!], complete: true, warnings: [] };
    },
    async listThreads(input, host) { return registry.isPeer(host) ? (await overrides.listSessionCatalog!(input, host)).threads : local.listThreads(input, host); },
    async listProjects(host, observation) {
      if (!registry.isPeer(host)) return local.listProjects(host, observation);
      const description = describe(host!);
      if (description.thread) return { backend: description.info.id, projects: [] };
      if (!description.management) throw new PeerError("unsupported", "设备尚未启用项目目录，请更新 Connector。");
      return invoke<import("../codex/backend.js").CodexProjectCatalog>("listProjects", [], host!);
    },
    async warmUp(cwd, host) { if (!registry.isPeer(host)) await local.warmUp(cwd, host); },
    stageAttachments: async (files, input) => {
      if (registry.isPeer(input.hostId)) {
        if (!files.length) return [];
        if (!input.accountId || !input.conversationId || !input.threadId) throw new PeerError("scope", "Attachment staging requires a selected chat and thread");
        const principal = peerPrincipal.getStore();
        if (!principal || principal.accountId !== input.accountId || principal.conversationId !== input.conversationId
          || !registry.hosts(principal).includes(input.hostId!)) throw new PeerError("access", "File transfer has no authorized chat identity");
        if (!describe(input.hostId!).files) throw new PeerError("unsupported", "设备尚未启用文件传输，请更新 Connector。");
        const scope = { accountId: input.accountId, conversationId: input.conversationId, threadId: input.threadId };
        return uploadPeerFiles(files, input.scope, input.threadId, input.maxBytes,
          (method, payload) => registry.invokeFile(input.hostId!, method, payload, scope));
      }
      return local.stageAttachments ? local.stageAttachments(files, input) : [...files];
    },
    fetchOutputFile: async (remotePath, input) => {
      if (registry.isPeer(input.hostId)) {
        if (!describe(input.hostId).files) throw new PeerError("unsupported", "设备尚未启用文件传输，请更新 Connector。");
        if (!input.accountId || !input.conversationId || !input.threadId) throw new PeerError("scope", "Output transfer requires a selected chat and thread");
        const scope = { accountId: input.accountId, conversationId: input.conversationId, threadId: input.threadId };
        return downloadPeerFile(input.threadId, remotePath, input.maxBytes,
          (method, payload) => registry.invokeFile(input.hostId, method, payload, scope), input.directory);
      }
      if (local.fetchOutputFile) return local.fetchOutputFile(remotePath, input);
      throw new PeerError("unsupported", "This execution host has no output file transfer transport");
    },
    getGoal: (id, host) => route("getGoal", [id], host),
    setGoal: (id, value, host, assertCurrent) => registry.isPeer(host)
      ? invoke("setGoal", [id, value], host!, true, { threadId: id, assertCurrent }) : local.setGoal(id, value, host, assertCurrent),
    clearGoal: async (id, host, assertCurrent) => {
      if (registry.isPeer(host)) await invoke("clearGoal", [id], host!, true, { threadId: id, assertCurrent });
      else await local.clearGoal(id, host, assertCurrent);
    },
    createThread: (input, host) => registry.isPeer(host) ? manage("createThread", input, host!) : native("createThread", [input, host]),
    renameThread: (id, title, host, assertCurrent, clientUserMessageId) => registry.isPeer(host)
      ? manage("renameThread", { threadId: id, title, assertCurrent, clientUserMessageId }, host!) : native("renameThread", [id, title, host, assertCurrent]),
    async archiveThread(id, host, assertCurrent, clientUserMessageId) {
      if (registry.isPeer(host)) await manage("archiveThread", { threadId: id, assertCurrent, clientUserMessageId }, host!);
      else await local.archiveThread(id, host, assertCurrent);
    },
    unarchiveThread: (id, host, assertCurrent, clientUserMessageId) => registry.isPeer(host)
      ? manage("unarchiveThread", { threadId: id, assertCurrent, clientUserMessageId }, host!) : local.unarchiveThread(id, host, assertCurrent),
    async deleteThread(id, host, assertCurrent, clientUserMessageId) {
      if (registry.isPeer(host)) await manage("deleteThread", { threadId: id, assertCurrent, clientUserMessageId }, host!);
      else await local.deleteThread(id, host, assertCurrent);
    },
    recoverSystemError: (input, host) => registry.isPeer(host) ? Promise.resolve({ status: "unsupported", reason: "owner-unsupported" })
      : local.recoverSystemError ? local.recoverSystemError(input, host) : Promise.resolve({ status: "unsupported" }),
    readThreadProvenance: (id, host) => registry.isPeer(host) ? Promise.resolve(undefined) : local.readThreadProvenance?.(id, host) ?? Promise.resolve(undefined),
    readTurnLifecycle: async (id, turn, host) => {
      if (!registry.isPeer(host)) return local.readTurnLifecycle?.(id, turn, host) ?? { status: "unknown", source: "unknown" };
      return invoke<CodexTurnObservation>("readTurnLifecycle", [id, turn], host!);
    },
    readTurnActivities: (id, turn, host) => route("readTurnActivities", [id, turn, host], host),
    // These ports are new in the unified native adapter, but are not part of
    // the peer protocol yet. Never pass peer identities to a local/SSH core.
    interruptTurn: async (id, turn, host, assertCurrent) => {
      if (registry.isPeer(host)) await invoke("interruptTurn", [id, turn], host!, true, { threadId: id, assertCurrent });
      else await native("interruptTurn", [id, turn, host, assertCurrent]);
    },
    listSkills: async (cwd, host) => registry.isPeer(host) ? unsupported("skills", host!) : native("listSkills", [cwd, host]),
    listMcpServers: async (id, host) => registry.isPeer(host) ? unsupported("mcpServers", host!) : native("listMcpServers", [id, host]),
    observeThreadInteractions: (id, host, observer, consumer) => registry.isPeer(host)
      ? interactions.observe(id, host, observer, consumer) : native("observeThreadInteractions", [id, host, observer, consumer]),
    unobserveThreadInteractions: (id, host, consumer) => registry.isPeer(host)
      ? interactions.unobserve(id, host, consumer) : native("unobserveThreadInteractions", [id, host, consumer]),
    interactionSubscriptionReady: (id, host, consumer) => registry.isPeer(host) ? interactions.ready(id, host, consumer) : Boolean(local.interactionSubscriptionReady?.(id, host, consumer)),
    serverIdentity: async host => {
      if (registry.isPeer(host)) throw new PeerError("unsupported", "Connector 尚未开放原生进程诊断接口。");
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
    async close() { await interactions.close(); for (const op of operations) op.controller.abort(); await local.close(); }
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
