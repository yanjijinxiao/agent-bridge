import path from "node:path";
import { AppServerCodexRunner } from "./app-server-runner.js";
import { resolveLocalAppServerTransport, type AppServerConnectionMode } from "./app-server-daemon.js";
import type { CodexExecSandbox } from "./sandbox.js";
import { resolveRemoteCodexTransport } from "./remote-host.js";
import { CodexMetadataReader, type MetadataConnection } from "./metadata-reader.js";
import { CodexHistoryReader, type HistoryConnection } from "./history-reader.js";
import { stageRemoteFiles, type StageInboundFiles } from "./inbound-files.js";
import { observeOwnerTurn } from "./native-turn-lifecycle.js";
import { CodexCommunicationError, isCodexCommunicationFailure } from "./communication-error.js";
import { assertCapacityResume, assertCodexThreadRunnable, assertQueueAdmissionCurrent, CodexBackendCapabilityError,
  CodexInterventionError, CodexQueueAdmissionError, CodexRunAdmissionError, CodexTurnExecutionError } from "./backend.js";
import type { CodexAppServerBackend, CodexBridgeBackend, CodexCapacityResumeInput, CodexExecutionScope,
  CodexHistoryPageInput, CodexMetadataObservation, CodexNativeQueue, CodexQueuedRunInput, CodexQueueAddInput,
  CodexRunnerInput, CodexRunResult, CodexSteerInput, CodexSystemRecoveryInput, CodexThreadGoalStatus,
  CodexThreadListInput, CodexThreadMessageInput, EphemeralCodexRunnerInput } from "./backend.js";
import type { NativeInteractionObserver } from "./interactions.js";

/** Old spellings can be recognized during migration; they are not adapters. */
export type CodexBackend = "auto" | "app-server" | "exec";
export type CodexAppServerGatewayOptions = {
  backend?: CodexBackend;
  appServerTransport?: AppServerConnectionMode;
  codexBin?: string; execSandbox?: CodexExecSandbox; timeoutMs?: number; codexHome?: string;
  appServerBackend?: CodexAppServerBackend;
  remoteTransportResolver?: typeof resolveRemoteCodexTransport;
  stageAttachments?: StageInboundFiles;
  metadataConnectionFactory?: (hostId: string) => MetadataConnection;
  historyConnectionFactory?: (hostId: string) => HistoryConnection;
  onThreadMutation?: (threadId: string, hostId: string) => void;
};

/** A single complete protocol adapter. Desktop and CLI are peers of the same
 * service; read isolation and host transport never choose another executor. */
export class CodexAppServerGateway implements CodexBridgeBackend {
  readonly systemErrorLifecycleRecovery = true;
  private readonly appServer: CodexAppServerBackend;
  private readonly remoteAppServers = new Map<string, CodexAppServerBackend>();
  private readonly remoteTransports = new Map<string, ReturnType<typeof resolveRemoteCodexTransport>>();
  private readonly metadataReader: CodexMetadataReader;
  private readonly statusReader: CodexMetadataReader;
  private readonly historyReader?: CodexHistoryReader;
  private readonly observations = new Map<string, Promise<unknown>>();
  private readonly admittingRuns = new Set<string>();
  private readonly restartRuns = new Set<{ scope?: CodexExecutionScope }>();
  private closed = false;

  constructor(private readonly options: CodexAppServerGatewayOptions = {}) {
    if (options.backend === "exec") throw new CodexInterventionError("Gateway 已统一使用原生 App Server；CLI 环境也使用 codex app-server，未执行 codex exec。");
    const selectedTransport = options.appServerTransport ?? "auto";
    const mode = selectedTransport === "auto" && options.codexBin
      && !/^codex(?:\.exe)?$/i.test(path.basename(options.codexBin)) ? "stdio" : selectedTransport;
    const transport = resolveLocalAppServerTransport({ mode,
      codexHome: options.codexHome, codexBin: options.codexBin ?? "codex" });
    const connection = (hostId = "local", observer?: "metadata" | "history") => new AppServerCodexRunner({
      codexHome: options.codexHome, codexBin: options.codexBin, hostId, sandbox: options.execSandbox,
      catalogSource: "native", metadataOnly: observer === "metadata", historyOnly: observer === "history",
      requestTimeoutMs: observer === "history" ? Math.min(options.timeoutMs ?? 15_000, 15_000) : options.timeoutMs,
      transport: hostId === "local" ? transport : this.remoteTransport(hostId)
    });
    this.appServer = options.appServerBackend ?? connection();
    // Stdio has one process and no attach endpoint. Restricted read views must
    // share that connection; spawning another reader would create another core.
    // Daemon transports isolate JSONL readers while attaching the same core.
    const localStdio = !transport && !options.appServerBackend;
    const metadata = options.metadataConnectionFactory ?? ((host: string) => host === "local" && (localStdio || options.appServerBackend) ? {
      inspectThread: (id: string, observation: CodexMetadataObservation) => this.appServer.inspectThread(id, observation),
      listProjects: () => this.appServer.listProjects(),
      getRuntimeInfo: (cwd: string, id?: string) => this.appServer.getRuntimeInfo(cwd, id),
      close() {}
    } : connection(host, "metadata"));
    this.metadataReader = new CodexMetadataReader(metadata);
    this.statusReader = new CodexMetadataReader(metadata);
    if (options.historyConnectionFactory || !options.appServerBackend) this.historyReader = new CodexHistoryReader(
      options.historyConnectionFactory ?? ((host: string) => host === "local" && localStdio ? {
        readThreadSnapshot: (id: string) => this.appServer.readThreadSnapshot(id),
        getHistory: (id: string) => this.appServer.getHistory(id),
        getHistoryPage: (id: string, input?: CodexHistoryPageInput) => this.appServer.getHistoryPage(id, input),
        close() {}
      } : connection(host, "history")));
  }

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    this.mutating(input.threadId, input.hostId);
    const key = (value: string) => JSON.stringify([input.hostId ?? "local", value]);
    const keys = new Set([input.queueKey, input.threadId].filter((value): value is string => Boolean(value)).map(key));
    if ([...keys].some(scope => this.admittingRuns.has(scope))) throw new CodexRunAdmissionError("handoff", input.threadId);
    for (const scope of keys) this.admittingRuns.add(scope);
    const release = () => { for (const scope of keys) this.admittingRuns.delete(scope); keys.clear(); };
    return this.execution(async lease => {
      try {
        input.assertCurrent?.();
        return await this.appServerFor(input.hostId).run(this.observeAcceptance({ ...input,
          onThreadCreated: async threadId => {
            const scope = key(threadId);
            if (this.admittingRuns.has(scope) && !keys.has(scope)) throw new CodexRunAdmissionError("handoff", threadId);
            keys.add(scope); this.admittingRuns.add(scope);
            await input.onThreadCreated?.(threadId);
          },
          onTurnStarted: async event => { try { await input.onTurnStarted?.(event); } finally { release(); } }
        }, lease));
      } finally { release(); }
    });
  }

  stageAttachments: StageInboundFiles = async (files, input) => {
    if (!files.length || !input.hostId || input.hostId === "local") return files;
    return this.options.stageAttachments ? this.options.stageAttachments(files, input)
      : stageRemoteFiles(files, input.scope, input.maxBytes, this.remoteTransport(input.hostId));
  };

  async steer(input: CodexSteerInput, hostId?: string) {
    this.mutating(input.threadId, hostId); return this.appServerFor(hostId).steer(input);
  }
  async submitThreadMessage(input: CodexThreadMessageInput, hostId?: string) {
    this.mutating(input.threadId, hostId);
    const state = await this.inspectThread(input.threadId, hostId); assertCodexThreadRunnable(state);
    if (state.threadId !== input.threadId || state.persistence !== "active" || state.runtimeStatus !== "active" || !state.activeTurnId)
      throw new CodexInterventionError("没有可确认的活动轮次，消息未提交；未新建任务或自动排队。");
    input.assertCurrent?.(); return this.appServerFor(hostId).steer({ ...input, expectedTurnId: state.activeTurnId });
  }
  async stop(threadId?: string, hostId?: string, assertCurrent?: () => void) {
    assertCurrent?.(); this.mutating(threadId, hostId); return this.appServerFor(hostId).stop(threadId, assertCurrent);
  }
  async runEphemeral(input: EphemeralCodexRunnerInput) {
    return this.execution(() => this.appServer.run({ ...input, ephemeral: true, sandbox: "read-only" }));
  }
  async resumeAfterCapacity(input: CodexCapacityResumeInput) {
    return this.execution(async lease => {
      const snapshot = await this.readThreadSnapshot(input.threadId, input.hostId); assertCapacityResume(snapshot, input.failedTurnId);
      if ((await this.listQueuedSubmissions(input.threadId, undefined, input.hostId)).data.length) throw new CodexInterventionError("原生队列已有输入，容量恢复未抢先执行。");
      input.assertCurrent(); const backend = this.appServerFor(input.hostId);
      if (!backend.resumeAfterCapacity) throw new CodexInterventionError("当前原生服务不支持容量恢复，未切换执行器。");
      const watched = this.observeAcceptance({ ...input, prompt: "", cwd: "" }, lease);
      return backend.resumeAfterCapacity({ ...input, onTurnStarted: watched.onTurnStarted! });
    });
  }
  async recoverSystemError(input: CodexSystemRecoveryInput, hostId = "local") {
    const backend = this.appServerFor(hostId);
    return backend.recoverSystemError ? backend.recoverSystemError(input) : { status: "unsupported" as const, reason: "owner-unsupported" as const };
  }

  private nativeQueue(hostId?: string): CodexAppServerBackend & CodexNativeQueue {
    const backend = this.appServerFor(hostId);
    if (!backend.addQueuedSubmission || !backend.listQueuedSubmissions || !backend.deleteQueuedSubmission || !backend.runQueuedSubmission)
      throw new CodexBackendCapabilityError("nativeQueue", "app-server");
    return backend as CodexAppServerBackend & CodexNativeQueue;
  }
  async addQueuedSubmission(input: CodexQueueAddInput, hostId?: string) {
    this.mutating(input.threadId, hostId);
    try { const state = await this.inspectThread(input.threadId, hostId); assertCodexThreadRunnable(state);
      if (state.threadId !== input.threadId) throw Error("队列目标身份不匹配"); }
    catch (error) { throw new CodexQueueAdmissionError(error); }
    assertQueueAdmissionCurrent(input); return this.nativeQueue(hostId).addQueuedSubmission(input);
  }
  listQueuedSubmissions(threadId: string, cursor?: string, hostId?: string) { return this.nativeQueue(hostId).listQueuedSubmissions(threadId, cursor); }
  deleteQueuedSubmission(threadId: string, queuedSubmissionId: string, hostId?: string, assertCurrent?: () => void) {
    assertCurrent?.(); return this.nativeQueue(hostId).deleteQueuedSubmission(threadId, queuedSubmissionId, undefined, assertCurrent);
  }
  async runQueuedSubmission(input: CodexQueuedRunInput) {
    return this.execution(async lease => {
      if (input.observeOnly) {
        if (!input.acceptedTurnId) throw new CodexInterventionError("只读恢复缺少原生轮次，未启动任务。");
        const observed = await this.readTurnLifecycle(input.threadId, input.acceptedTurnId, input.hostId);
        if (observed.status === "unknown" || observed.status === "inProgress" || observed.source === "unknown")
          throw new CodexCommunicationError("observation", "queue/observe", input.threadId, input.acceptedTurnId);
        await input.onTurnStarted?.({ threadId: input.threadId, turnId: input.acceptedTurnId, status: observed.status });
        if (observed.status !== "completed") throw new CodexTurnExecutionError(observed.status, "原生轮次已确认结束", observed.failureCode);
        return { threadId: input.threadId, turnId: input.acceptedTurnId, text: observed.text || "任务已完成。", raw: "" };
      }
      assertCodexThreadRunnable(await this.inspectThread(input.threadId, input.hostId));
      const watched = this.observeAcceptance({ ...input, prompt: "" }, lease);
      return this.nativeQueue(input.hostId).runQueuedSubmission({ ...input, onTurnStarted: watched.onTurnStarted });
    });
  }
  async readTurnLifecycle(threadId: string, turnId: string, hostId?: string) {
    try { const observed = observeOwnerTurn(await this.readThreadSnapshot(threadId, hostId), threadId, turnId);
      if (observed.source !== "unknown") return observed; }
    catch (error) { if (!isCodexCommunicationFailure(error)) throw error; }
    return this.appServerFor(hostId).readNativeTurnLifecycle?.(threadId, turnId) ?? { status: "unknown" as const, source: "unknown" as const };
  }
  readThreadProvenance(threadId: string, hostId?: string) { return this.appServerFor(hostId).readThreadProvenance?.(threadId) ?? Promise.resolve(undefined); }

  warmUp(cwd: string, hostId?: string) { return this.appServerFor(hostId).warmUp(cwd); }
  listProjects(hostId?: string, observation?: Pick<CodexMetadataObservation, "timeoutMs">) {
    return observation ? this.metadataReader.projects(hostId ?? "local", observation.timeoutMs) : this.appServerFor(hostId).listProjects();
  }
  inspectThread(threadId: string, hostId = "local", observation?: CodexMetadataObservation) {
    if (observation) return this.once(["inspect", hostId, threadId, observation], () => (observation.purpose === "status" ? this.statusReader : this.metadataReader).inspect(threadId, hostId, observation));
    return this.once(["preflight", hostId, threadId], async () => {
      const state = this.options.appServerBackend && !this.options.metadataConnectionFactory && hostId === "local"
        ? await this.appServer.inspectThread(threadId, { includeTurns: false, timeoutMs: 5000 })
        : await this.metadataReader.inspect(threadId, hostId, { includeTurns: false, timeoutMs: 5000 });
      return state.runtimeStatus === "active" && !state.activeTurnId ? this.appServerFor(hostId).inspectThread(threadId) : state;
    });
  }
  readThreadSnapshot(threadId: string, hostId = "local") {
    return this.once(["snapshot", hostId, threadId], () => this.historyReader
      ? this.historyReader.snapshot(threadId, hostId, Math.min(this.options.timeoutMs ?? 15000, 15000)) : this.appServerFor(hostId).readThreadSnapshot(threadId));
  }
  getHistory(threadId: string, hostId = "local") { return this.historyReader ? this.historyReader.history(threadId, hostId, this.options.timeoutMs ?? 60000) : this.appServerFor(hostId).getHistory(threadId); }
  getHistoryPage(threadId: string, input?: CodexHistoryPageInput, hostId = "local") { return this.historyReader ? this.historyReader.page(threadId, input, hostId, Math.min(this.options.timeoutMs ?? 15000, 15000)) : this.appServerFor(hostId).getHistoryPage(threadId, input); }
  getRuntimeInfo(cwd: string, threadId?: string, hostId = "local", observation?: Pick<CodexMetadataObservation, "timeoutMs" | "purpose">) {
    return observation ? (observation.purpose === "status" ? this.statusReader : this.metadataReader).runtime(cwd, threadId, hostId, observation.timeoutMs) : this.appServerFor(hostId).getRuntimeInfo(cwd, threadId);
  }
  listThreads(input?: CodexThreadListInput, hostId?: string) { return this.appServerFor(hostId).listThreads(input); }
  listSessionCatalog(input?: CodexThreadListInput, hostId?: string) { return this.appServerFor(hostId).listSessionCatalog(input); }
  listModels(hostId?: string) { return this.appServerFor(hostId).listModels(); }
  getAccountRateLimits(hostId?: string) { return this.appServerFor(hostId).getAccountRateLimits(); }
  getGoal(threadId: string, hostId?: string) { return this.appServerFor(hostId).getGoal(threadId); }
  async setGoal(threadId: string, input: { objective?: string; status?: CodexThreadGoalStatus; tokenBudget?: number }, hostId?: string, assertCurrent?: () => void) { assertCurrent?.(); this.mutating(threadId, hostId); return this.appServerFor(hostId).setGoal(threadId, input, assertCurrent); }
  async clearGoal(threadId: string, hostId?: string, assertCurrent?: () => void) { assertCurrent?.(); this.mutating(threadId, hostId); return this.appServerFor(hostId).clearGoal(threadId, assertCurrent); }
  archiveThread(threadId: string, hostId?: string) { this.mutating(threadId, hostId); return this.appServerFor(hostId).archiveThread(threadId); }
  unarchiveThread(threadId: string, hostId?: string) { this.mutating(threadId, hostId); return this.appServerFor(hostId).unarchiveThread(threadId); }
  deleteThread(threadId: string, hostId?: string) { this.mutating(threadId, hostId); return this.appServerFor(hostId).deleteThread(threadId); }
  backendInfo(hostId?: string) { const backend = this.appServerFor(hostId); return { id: backend.id, capabilities: backend.capabilities }; }
  observeThreadInteractions(threadId: string, hostId: string, observer: NativeInteractionObserver) {
    const backend = this.appServerFor(hostId);
    if (!backend.observeThreadInteractions) throw new CodexInterventionError("原生交互订阅接口不可用。");
    return backend.observeThreadInteractions(threadId, observer);
  }
  unobserveThreadInteractions(threadId: string, hostId: string) { return this.appServerFor(hostId).unobserveThreadInteractions?.(threadId) ?? Promise.resolve(); }
  interactionSubscriptionReady(threadId: string, hostId: string) { return this.appServerFor(hostId).interactionSubscriptionReady?.(threadId) ?? false; }
  serverIdentity(hostId?: string) { const backend = this.appServerFor(hostId); if (!backend.serverIdentity) throw new Error("Native server diagnostics unavailable"); return backend.serverIdentity(); }
  hasInFlightWork() { return Boolean(this.restartRuns.size || this.admittingRuns.size || this.appServer.hasInFlightWork?.() || [...this.remoteAppServers.values()].some(b => b.hasInFlightWork?.())); }
  isIndependentObservation(scope: CodexExecutionScope) { return [...this.restartRuns].some(r => r.scope?.hostId === scope.hostId && r.scope.threadId === scope.threadId && r.scope.turnId === scope.turnId); }
  hasRestartBlockingWork() { return [...this.restartRuns].some(r => !r.scope) || [this.appServer, ...this.remoteAppServers.values()].some(b => b.hasRestartBlockingWork?.() ?? b.hasInFlightWork?.() ?? false); }
  detachIndependentObservations() { for (const backend of [this.appServer, ...this.remoteAppServers.values()]) backend.detachIndependentObservations?.(); }
  async close() { this.closed = true; await Promise.all([this.metadataReader.close(), this.statusReader.close(), this.historyReader?.close(), this.appServer.close(), ...[...this.remoteAppServers.values()].map(b => b.close())]); this.remoteAppServers.clear(); this.remoteTransports.clear(); }

  private mutating(threadId?: string, hostId = "local") { if (this.closed) throw new Error("Codex runner is closed"); if (threadId) this.options.onThreadMutation?.(threadId, hostId); }
  private async execution<T>(execute: (lease: { scope?: CodexExecutionScope }) => Promise<T>): Promise<T> { const lease = {}; this.restartRuns.add(lease); try { return await execute(lease); } finally { this.restartRuns.delete(lease); } }
  private observeAcceptance(input: CodexRunnerInput, lease: { scope?: CodexExecutionScope }): CodexRunnerInput {
    return { ...input, onTurnStarted: async event => { await input.onTurnStarted?.(event);
      if (this.appServerFor(input.hostId).executionLifetime === "independent" && !input.ephemeral && !input.dynamicTools?.length && !input.onDynamicToolCall && (event.status === undefined || event.status === "inProgress"))
        lease.scope = { hostId: input.hostId ?? "local", threadId: event.threadId, turnId: event.turnId }; } };
  }
  private once<T>(scope: unknown[], read: () => Promise<T>): Promise<T> { const key = JSON.stringify(scope), pending = this.observations.get(key); if (pending) return pending as Promise<T>;
    const work = Promise.resolve().then(read).finally(() => { if (this.observations.get(key) === work) this.observations.delete(key); }); this.observations.set(key, work); return work; }
  private appServerFor(hostId = "local"): CodexAppServerBackend { if (hostId === "local") return this.appServer; let backend = this.remoteAppServers.get(hostId);
    if (!backend) { backend = new AppServerCodexRunner({ hostId, codexHome: this.options.codexHome, catalogSource: "native", transport: this.remoteTransport(hostId), requestTimeoutMs: this.options.timeoutMs, sandbox: this.options.execSandbox }); this.remoteAppServers.set(hostId, backend); } return backend; }
  private remoteTransport(hostId: string) { let transport = this.remoteTransports.get(hostId); if (!transport) { transport = (this.options.remoteTransportResolver ?? resolveRemoteCodexTransport)(hostId, { codexHome: this.options.codexHome }); this.remoteTransports.set(hostId, transport); } return transport; }
}
