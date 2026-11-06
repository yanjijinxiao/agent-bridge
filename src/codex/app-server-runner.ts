import { guardNativeWrite, inheritWriteCheck } from "./write-guard.js";
import { nativePublicActivity, sensitiveCommand, type CodexPublicActivity } from "./public-item.js";
import { assertQueueAdmissionCurrent, CodexQueueAdmissionError, CodexRunAdmissionError, CodexInterventionError } from "./backend.js";
import { canRecoverSystemError, type CodexSystemRecoveryInput, type CodexSystemRecoveryResult } from "./backend.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { DiagnosticTail } from "./diagnostic-tail.js";
import path from "node:path";
import readline from "node:readline";
import { rolloutIdentity } from "./rollout-identity.js";
import { isInternalUserMessage } from "./public-user-message.js";
import { readNativeTurnLifecycle, observeOwnerTurn, readNativeThreadProvenance } from "./native-turn-lifecycle.js";
import { communicationError, isCodexCommunicationFailure, CodexCommunicationError } from "./communication-error.js";
import { parseUserInputRequest } from "./user-input.js";
import { automaticApprovalProgress } from "./approval-progress.js";
import { parseMcpForm, mcpFormResponse, safeElicitationUrl, type McpForm } from "./elicitation.js";
import type { CodexUserInputResultHandler, CodexUserInputResult } from "./backend.js";
import type { CodexApprovalRequest, CodexApprovalResult, CodexApprovalResultHandler } from "./approval.js";
import { desktopProjectHint, desktopSessionMembership, nativeSessionPresentation } from "./desktop-session-membership.js";
import { CodexNativeRequestError } from "./connection-errors.js";
import type { NativeInteractionObserver, NativeApproval, NativeUserInput } from "./interactions.js";
import { NativeAsyncQuestions } from "./native-async-questions.js";
import { codexFailureCode, lastCodexTurnFailure, type CodexFailureCode } from "./turn-failure.js";
import { codexTurnRecovery, codexRecoverySummary, type CodexTurnRecovery } from "./turn-recovery.js";
import { readDesktopSessionCatalog, isDesktopCatalogThread } from "./desktop-session-catalog.js";

import { resolveCodexCommand } from "./codex-command.js";
import { parseAccountRateLimits, type CodexAccountBalance } from "./account-balance.js";
import {
  appServerApprovalResult,
  isAppServerApprovalMethod,
  parseAppServerApproval,
  type CodexApprovalHandler
} from "./approval.js";
import type { CodexExecSandbox } from "./sandbox.js";
import type { AppServerTransport } from "./app-server-transport.js";
import {
  APP_SERVER_BACKEND_CAPABILITIES,
  CodexThreadStateError,
  CodexBackendCapabilityError,
  CodexTurnExecutionError,
  assertCodexThreadRunnable,
  assertCodexProjectBinding,
  assertCapacityResume,
  type CodexCapacityResumeInput,
  type CodexAppServerBackend,
  type CodexDynamicToolCall,
  type CodexDynamicToolHandler,
  type CodexHistoryPage,
  type CodexHistoryPageInput,
  type CodexHistoryMessage,
  type CodexModelOption,
  type CodexSkillOption,
  type CodexMcpServerOption,
  type CodexProject,
  type CodexProjectCatalog,
  type CodexSessionCatalog,
  type CodexRunResult,
  type CodexRunnerInput,
  type CodexRuntimeInfo,
  type CodexSteerInput,
  type CodexSteerResult,
  type CodexQueueAddInput,
  type CodexQueuePage,
  type CodexQueuedSubmission,
  type CodexQueuedRunInput,
  type CodexStopResult,
  type CodexThreadActiveFlag,
  type CodexThreadGoal,
  type CodexThreadGoalStatus,
  type CodexThreadListInput,
  type CodexThreadPersistence,
  type CodexThreadRuntimeStatus,
  type CodexThreadState,
  type CodexThreadCreateInput,
  type CodexTurnStatus,
  type CodexUserInputAnswer,
  type CodexUserInputHandler,
  type CodexUserInputQuestion,
  type CodexUserInputRequest
} from "./backend.js";

export type {
  CodexDynamicToolCall,
  CodexDynamicToolHandler,
  CodexHistoryMessage,
  CodexModelOption,
  CodexRunnerInput,
  CodexRuntimeInfo,
  CodexThreadGoal,
  CodexThreadGoalStatus,
  CodexUserInputAnswer,
  CodexUserInputHandler,
  CodexUserInputQuestion,
  CodexUserInputRequest
} from "./backend.js";
export type { AppServerTransport } from "./app-server-transport.js";

export type AppServerRunnerOptions = {
  /** Headless deployments use native storage, never a stale Desktop catalog. */
  catalogSource?: "desktop" | "native";
  codexHome?: string;
  hostId?: string;
  codexBin?: string;
  requestTimeoutMs?: number;
  sandbox?: CodexExecSandbox;
  transport?: AppServerTransport;
  /** Dedicated project observation: no task controls or native decisions. */
  metadataOnly?: boolean;
  /** Bulk display history is isolated from metadata and native execution. */
  historyOnly?: boolean;
};

type JsonRpcId = number | string;

type PendingRequest = {
  method: string;
  readOnly?: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TurnCompletion = {
  status: string;
  text: string;
  raw: string;
  error?: string;
  failureCode?: CodexFailureCode;
};

type TurnWaiter = {
  resolve: (value: CodexRunResult) => void;
  reject: (error: Error) => void;
};

type TurnStream = {
  onItem?: CodexRunnerInput["onItem"];
  onDelta?: (delta: string) => Promise<void> | void;
  onProgress?: (message: string) => Promise<void> | void;
  onRecovery?: (recovery: CodexTurnRecovery) => Promise<void> | void;
  chain: Promise<void>;
};

type QueuedTurnEvent = {
  type: "delta" | "progress";
  text: string;
} | { type: "recovery"; recovery: CodexTurnRecovery } | { type: "item"; activity: CodexPublicActivity };

type AppServerSandboxPolicy =
  | { readonly type: "dangerFullAccess" }
  | { readonly type: "readOnly" }
  | { readonly type: "workspaceWrite" };

type WireMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export class AppServerCodexRunner implements CodexAppServerBackend {
  readonly systemErrorLifecycleRecovery = true;
  readonly id = "app-server" as const;
  readonly capabilities = APP_SERVER_BACKEND_CAPABILITIES;
  private child?: ChildProcessWithoutNullStreams;
  private lines?: readline.Interface;
  private connectPromise?: Promise<void>;
  private initialized = false;
  private readonly approvalResults = new Map<string, CodexApprovalResultHandler>();
  private readonly approvalRequests = new Map<string, { request: CodexApprovalRequest; submitted: boolean; notify?: CodexApprovalResultHandler;
    observer?: NativeInteractionObserver }>();
  private readonly interactionObservers = new Map<string, NativeInteractionObserver>();
  private readonly interactionRefreshThreads = new Set<string>();
  private readonly asyncQuestions: NativeAsyncQuestions;
  private readonly observedApprovalIds = new Set<string>();
  private closed = false;
  private closePromise?: Promise<void>;
  private retiringTransport?: Promise<void>;
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly activeTurns = new Map<string, string>();
  private readonly itemHandlersByThread = new Map<string, NonNullable<CodexRunnerInput["onItem"]>>();
  private readonly approvalHandlersByThread = new Map<string, CodexApprovalHandler>();
  private readonly dynamicToolHandlersByThread = new Map<string, CodexDynamicToolHandler>();
  private readonly userInputHandlersByThread = new Map<string, CodexUserInputHandler>();
  private readonly userInputResultHandlersByThread = new Map<string, CodexUserInputResultHandler>();
  private readonly userInputRequests = new Map<string, { request: CodexUserInputRequest;
    submitted: boolean; notify?: CodexUserInputResultHandler; observer?: NativeInteractionObserver }>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly turnEvents = new Map<string, DiagnosticTail>();
  private readonly turnTexts = new Map<string, string>();
  private readonly completedTurns = new Map<string, TurnCompletion>();
  private readonly turnStreams = new Map<string, TurnStream>();
  private readonly queuedTurnEvents = new Map<string, QueuedTurnEvent[]>();
  private readonly turnRecoveries = new Map<string, CodexTurnRecovery>();
  private readonly turnErrorCodes = new Map<string, CodexFailureCode>();
  private readonly itemPhasesByTurn = new Map<string, Map<string, string>>();
  private readonly reasoningSummariesByTurn = new Map<string, Map<string, string>>();
  private readonly runtimeInfoByThread = new Map<string, CodexRuntimeInfo>();
  private readonly settingsObservers = new Map<string, Set<(value: CodexRuntimeInfo) => void>>();
  private readonly threadStates = new Map<string, CodexThreadState>();
  private operationLeases = 0;
  private readonly expectedTurnThreads = new Map<string, number>();
  private projectCatalogSupported?: boolean;
  private modelOptions?: CodexModelOption[];
  private readonly nativeQueueOrigins = new Map<string, CodexQueueAddInput>();
  private readonly nativeTurnClients = new Map<string, string>();
  private readonly subscribedThreads = new Set<string>();
  private readonly unconfirmedStarts = new Set<string>();
  private readonly responseWrites = new Set<object>();

  constructor(private readonly options: AppServerRunnerOptions = {}) {
    this.asyncQuestions = new NativeAsyncQuestions(options.hostId ?? "local",
      (threadId, observer) => this.interactionObservers.get(threadId) === observer,
      input => this.steer(input), threadId => this.interactionRefreshThreads.add(threadId));
  }

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    assertCodexProjectBinding(input);
    const absolute = (value: unknown): value is string => typeof value === "string"
      && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
    if (input.imagePaths?.some(file => !absolute(file))) throw new Error("Native image paths must be absolute");
    if (input.projectRoots?.some(root => !absolute(root))) throw new Error("Native project roots must be absolute");
    const settings = input.nativeSettings;
    if (settings) {
      if (input.sandbox !== undefined) throw new Error("Conflicting native sandbox settings");
      if (!["read-only", "workspace-write", "danger-full-access"].includes(settings.sandbox)
        || !["untrusted", "on-request", "never"].includes(settings.approvalPolicy)
        || !["user", "auto_review", "guardian_subagent"].includes(settings.approvalsReviewer))
        throw new Error("Invalid explicit native execution settings");
      if (!Array.isArray(settings.runtimeWorkspaceRoots) || settings.runtimeWorkspaceRoots.some(root => !absolute(root)))
        throw new Error("Native runtime workspace roots must be absolute");
    }
    this.operationLeases += 1;
    try {
      return await this.runWithLease(input);
    } finally {
      this.operationLeases -= 1;
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async resumeAfterCapacity(resume: CodexCapacityResumeInput): Promise<CodexRunResult> {
    this.operationLeases++;
    let accepted!: () => void, failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { accepted = resolve; failed = reject; });
    void ready.catch(() => undefined);
    try {
      const snapshot = await this.readThreadSnapshot(resume.threadId);
      assertCapacityResume(snapshot, resume.failedTurnId);
      return await this.runWithLease({ prompt: "", cwd: snapshot.state.cwd ?? "", threadId: resume.threadId,
        assertCurrent: resume.assertCurrent,
        onTurnStarted: async event => {
          try { await resume.onTurnStarted(event); accepted(); }
          catch (error) { failed(error); throw error; }
        }, onProgress: resume.onProgress, onRecovery: resume.onRecovery,
        onApproval: resume.onApproval ? async request => { await ready; return resume.onApproval!(request); } : undefined,
        onApprovalResult: resume.onApprovalResult,
        onUserInput: resume.onUserInput ? async request => { await ready; return resume.onUserInput!(request); } : undefined,
        onUserInputResult: resume.onUserInputResult ? async (request, result) => { await ready; await resume.onUserInputResult!(request, result); } : undefined }, resume);
    } catch (error) { failed(error); throw error;
    } finally { this.operationLeases--; await this.recyclePrivateTransportIfIdle(); }
  }

  private async runWithLease(input: CodexRunnerInput & Partial<Pick<CodexQueuedRunInput, "queuedSubmissionId" | "clientUserMessageId" | "onQueueStarting">>, resume?: CodexCapacityResumeInput): Promise<CodexRunResult> {
    await this.ensureConnected();
    input.assertCurrent?.();

    if (input.threadId) {
      try {
        if (resume) assertCapacityResume(await this.readThreadSnapshot(input.threadId), resume.failedTurnId);
        else {
          const state = await this.inspectThread(input.threadId);
          assertCodexThreadRunnable(state);
          if (state.runtimeStatus === "active" || state.latestTurnStatus === "inProgress") {
            // Native queue/add can drain before this client's dispatch read.
            // Reconcile only the already stored exact item, never start later.
            const consumed = input.queuedSubmissionId
              ? await this.findRecentlyConsumedTurn(input.threadId, input.clientUserMessageId) : undefined;
            if (consumed) return this.adoptQueuedTurn(input as CodexQueuedRunInput, consumed);
            throw new CodexRunAdmissionError("active", input.threadId);
          }
        }
        // inspectThread intentionally recycles a private stdio app-server so a
        // read-only probe cannot retain Desktop's writer lock. Reconnect for
        // the actual queued turn lifecycle.
        await this.ensureConnected();
      } catch (error) {
        throw normalizeThreadOperationError(error, input.threadId);
      }
    }

    // Project hints describe creation context. A continuation inherits native
    // membership, including an explicit removal or a move made by another peer.
    const nativeProjectId = !input.threadId && (input.projectId || input.projectName)
      ? await this.resolveProjectId(input.cwd, input.projectId, input.projectName, input.assertCurrent, input.projectRoots)
      : undefined;
    let threadResponse: Record<string, unknown>;
    try {
      // A missing start receipt can leave this client's subscription alive.
      // Read our subscription instead of acquiring the same writer twice.
      const alreadySubscribed = Boolean(input.threadId && !input.nativeSettings && this.subscribedThreads.has(input.threadId));
      threadResponse = await guardNativeWrite(input.assertCurrent, () => this.request(
        alreadySubscribed ? "thread/read" : input.threadId ? "thread/resume" : "thread/start",
        compactObject({
          ...(alreadySubscribed ? { includeTurns: false } : {}),
          ...(input.threadId && !alreadySubscribed ? { excludeTurns: true } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(!input.threadId ? { ephemeral: input.ephemeral } : {}),
          ...(input.nativeSettings ? { ...input.nativeSettings,
            runtimeWorkspaceRoots: [...input.nativeSettings.runtimeWorkspaceRoots] } : {}),
          cwd: !input.threadId || input.nativeSettings ? input.cwd : undefined,
          model: input.model,
          // Resume does not replace instructions on an already loaded native
          // thread. Keep its original policy and attach this client's current
          // application rules to the turn below instead.
          developerInstructions: input.threadId ? undefined : input.developerInstructions,
          ...(!input.threadId && nativeProjectId ? { projectId: nativeProjectId } : {}),
          ...(!input.threadId && input.projectBinding === "none" ? { projectId: null } : {}),
          ...(!input.threadId && input.dynamicTools ? { dynamicTools: input.dynamicTools } : {})
        })
      )) as Record<string, unknown>;
    } catch (error) {
      if (input.threadId) throw normalizeThreadOperationError(error, input.threadId);
      throw error;
    }
    const thread = nativeThread(threadResponse, input.threadId);
    const threadId = thread.id as string;
    this.subscribedThreads.add(threadId);
    this.expectedTurnThreads.set(threadId, (this.expectedTurnThreads.get(threadId) ?? 0) + 1);
    try {
    const currentProjectId = typeof thread?.projectId === "string" ? thread.projectId : undefined;
    if (!input.threadId && input.projectBinding === "none" && currentProjectId) {
      // Some servers may infer a project. The protocol uses an empty string (not
      // null) to clear metadata. Never reassign an existing bound thread here.
      await guardNativeWrite(input.assertCurrent, () => this.request("thread/metadata/update", { threadId, projectId: "" }));
      if (thread) thread.projectId = null;
    }
    const currentName = typeof thread?.name === "string" ? thread.name : undefined;
    const threadTitle = cleanThreadTitle(input.threadTitle);
    if (threadTitle && (!input.threadId || shouldRepairBridgeThreadName(currentName))) {
      await guardNativeWrite(input.assertCurrent, () => this.request("thread/name/set", { threadId, name: threadTitle }));
    }
    if (!input.threadId) {
      await input.onThreadCreated?.(threadId);
    }
    if (thread) {
      this.threadStates.set(threadId, parseThreadState(
        thread,
        input.ephemeral ? "ephemeral" : persistenceFromThread(thread)
      ));
    }
    this.runtimeInfoByThread.set(threadId, runtimeInfoFromThreadResponse(threadResponse));

    const runtimeInfo = this.runtimeInfoByThread.get(threadId);
    const collaborationModel = input.collaborationMode
      ? input.model ?? runtimeInfo?.model ?? (await this.getRuntimeInfo(input.cwd, threadId)).model
      : undefined;
    if (input.collaborationMode && !collaborationModel) {
      throw new Error("Codex collaboration mode requires a resolved model");
    }

    const turnParams = compactObject({
      threadId,
      input: resume ? [] : [{ type: "text", text: input.prompt, text_elements: [] },
        ...(input.imagePaths ?? []).map(image => ({ type: "localImage", path: image }))],
      clientUserMessageId: input.clientUserMessageId,
      ...(input.threadId && input.developerInstructions ? {
        additionalContext: { "codex-im-gateway": { kind: "application", value: input.developerInstructions } }
      } : {}),
      ...(resume ? { clientUserMessageId: resume.clientUserMessageId, turnTrigger: "capacity_retry_automatic" } : {}),
      // Resuming an already loaded thread only attaches a subscriber; its
      // existing execution settings can survive the resume options. Apply an
      // explicit UI choice atomically with the new turn as the native protocol
      // specifies. Ordinary continuation/capacity retry sends no overrides.
      cwd: resume || input.threadId && !input.nativeSettings ? undefined : input.cwd,
      sandboxPolicy: resume ? undefined : input.nativeSettings
        ? { ...appServerSandboxPolicy(input.nativeSettings.sandbox),
          ...(input.nativeSettings.sandbox === "workspace-write" ? { writableRoots: [...input.nativeSettings.runtimeWorkspaceRoots] } : {}) }
        : appServerSandboxPolicy(input.sandbox ?? (input.threadId ? undefined : this.options.sandbox)),
      ...(!resume && input.nativeSettings ? { approvalPolicy: input.nativeSettings.approvalPolicy,
        approvalsReviewer: input.nativeSettings.approvalsReviewer,
        runtimeWorkspaceRoots: [...input.nativeSettings.runtimeWorkspaceRoots] } : {}),
      model: input.model,
      effort: input.effort,
      outputSchema: input.outputSchema,
      ...(input.collaborationMode ? {
        collaborationMode: {
          mode: input.collaborationMode,
          settings: {
            model: collaborationModel,
            reasoning_effort: input.effort ?? runtimeInfo?.effort ?? null,
            developer_instructions: null
          }
        }
      } : {})
    });
    let turnResponse: Record<string, unknown>;
    // A start can race another accepted turn. Keep the prior turn's handlers
    // until this input is accepted; an explicit rejection must restore them.
    const restoreHandlers = [
      bindThreadHandler(this.itemHandlersByThread, threadId, input.onItem),
      bindThreadHandler(this.approvalHandlersByThread, threadId, input.onApproval),
      bindThreadHandler(this.approvalResults, threadId, input.onApprovalResult),
      bindThreadHandler(this.dynamicToolHandlersByThread, threadId, input.onDynamicToolCall),
      bindThreadHandler(this.userInputHandlersByThread, threadId, input.onUserInput),
      bindThreadHandler(this.userInputResultHandlersByThread, threadId, input.onUserInputResult)
    ];
    try {
      if (input.queuedSubmissionId) {
        // Resume itself can cause Codex to drain its native queue. Observe
        // that exact item instead of attempting a second start.
        const existing = await this.findQueuedTurn(input.threadId!, input.clientUserMessageId);
        if (existing) return await this.observeQueuedTurn(input as CodexQueuedRunInput, existing);
        const head = await this.queueRequest("thread/queue/list", { threadId, limit: 1 }) as { data?: CodexQueuedSubmission[] };
        if (head.data?.[0]?.id !== input.queuedSubmissionId) {
          // Queue removal can precede the history index by a few events.
          // Bounded read-only reconciliation, never another mutation.
          const consumed = await this.findRecentlyConsumedTurn(threadId, input.clientUserMessageId);
          if (consumed) return await this.observeQueuedTurn(input as CodexQueuedRunInput, consumed);
          throw new Error("原生队列已发生变化，未跳过队首或重复启动。");
        }
        await input.onQueueStarting?.();
        try {
          turnResponse = await guardNativeWrite(input.assertCurrent, () => this.queueRequest("thread/queue/start", { threadId, queuedSubmissionId: input.queuedSubmissionId })) as Record<string, unknown>;
        } catch (error) {
          if (error instanceof CodexBackendCapabilityError) throw error;
          const consumed = await this.findRecentlyConsumedTurn(threadId, input.clientUserMessageId);
          if (consumed) return await this.observeQueuedTurn(input as CodexQueuedRunInput, consumed);
          throw error;
        }
      } else {
        if (resume) {
          assertCapacityResume(await this.readThreadSnapshot(threadId), resume.failedTurnId);
          const queue = await this.listQueuedSubmissions(threadId);
          // An empty page with a continuation cursor is not an empty queue.
          if (queue.data.length || queue.nextCursor) throw new Error("Native queue takes precedence over capacity recovery");
          resume.assertCurrent();
        }
        turnResponse = await guardNativeWrite(input.assertCurrent, () => this.request("turn/start", turnParams)) as Record<string, unknown>;
      }
    } catch (error) {
      if (isCodexCommunicationFailure(error) && !(error instanceof CodexCommunicationError && error.submission === "not-submitted")) this.unconfirmedStarts.add(threadId);
      else for (const restore of restoreHandlers) restore();
      // An explicit native busy rejection has not accepted this input. Let the
      // source re-evaluate steer/native queue; never wait and submit it later.
      if (!isCodexCommunicationFailure(error) && isThreadBusyError(error)) throw new CodexRunAdmissionError("active", threadId);
      throw error;
    }
    const turn = turnResponse.turn as Record<string, unknown> | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : undefined;
    if (!turnId) {
      this.unconfirmedStarts.add(threadId);
      throw new CodexCommunicationError("submission", "turn/start", threadId, undefined, { code: "InvalidAcknowledgement" });
    }

    this.unconfirmedStarts.delete(threadId);
    // JSONL notifications can complete this exact turn before its start RPC
    // continuation runs. The acknowledgement must not resurrect terminal state.
    if (!this.completedTurns.has(turnKey(threadId, turnId))) {
      this.activeTurns.set(threadId, turnId);
      const previousState = this.threadStates.get(threadId);
      this.threadStates.set(threadId, {
        threadId,
        persistence: previousState?.persistence ?? (input.ephemeral ? "ephemeral" : "active"),
        runtimeStatus: previousState?.runtimeStatus === "systemError" ? "systemError" : "active",
        activeFlags: [],
        latestTurnStatus: "inProgress",
        activeTurnId: turnId,
        ...(this.turnRecoveries.has(turnKey(threadId, turnId)) ? { recovery: this.turnRecoveries.get(turnKey(threadId, turnId)) } : {}),
        ...(previousState?.cwd ? { cwd: previousState.cwd } : { cwd: input.cwd }),
        ...(previousState?.projectId ? { projectId: previousState.projectId } : {}),
        ...(previousState?.title ? { title: previousState.title } : {})
      });
    }
    // Bind the accepted identity/presentation before draining notifications
    // that can arrive ahead of the turn/start receipt.
    await input.onTurnStarted?.({ threadId, turnId });
    if (input.onDelta || input.onProgress || input.onRecovery || input.onItem) {
      const key = turnKey(threadId, turnId);
      this.turnStreams.set(key, {
        onItem: input.onItem,
        onDelta: input.onDelta,
        onProgress: input.onProgress,
        onRecovery: input.onRecovery,
        chain: Promise.resolve()
      });
      for (const event of this.queuedTurnEvents.get(key) ?? []) {
        this.enqueueTurnEvent(key, event);
      }
      this.queuedTurnEvents.delete(key);
    }
    try { return await this.waitForTurn(threadId, turnId); }
    catch (error) { throw communicationError(error, { phase: "observation", operation: "turn/observe", threadId, turnId }); }
    } finally {
      this.releaseExpectedTurnThread(threadId);
      // A native queued turn may start before this turn's delivery finishes.
      // Keep its subscription (and approval requests) on the same connection.
      if (!this.interactionObservers.has(threadId) && ![...this.nativeQueueOrigins.values()].some(origin => origin.threadId === threadId)
        && !this.activeTurns.has(threadId) && !this.unconfirmedStarts.has(threadId)) await this.unsubscribeThread(threadId);
      await this.recyclePrivateTransportIfIdle();
    }
  }

  private async unsubscribeThread(threadId: string): Promise<void> {
    if (this.closed) return; // Closing the transport already detaches its subscriptions.
    try {
      await this.request(
        "thread/unsubscribe",
        { threadId },
        Math.min(this.options.requestTimeoutMs ?? 600_000, 10_000)
      );
      this.subscribedThreads.delete(threadId);
    } catch (error) {
      // Releasing ownership is best-effort and must never replace the actual
      // turn result. A closed transport already releases all of its threads.
      console.warn(
        `[codex-im-gateway] Unable to release Codex session ${threadId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * A private stdio app-server keeps an unsubscribed thread loaded for its
   * inactivity grace period. While loaded, its OS writer lock prevents Codex
   * Desktop from opening the same task. Once the last Bridge turn is done,
   * close the private process so Desktop can take ownership immediately.
   *
   * Managed daemon and remote transports have a shared lifecycle and must not
   * be stopped by an individual Bridge client.
   */
  private async recyclePrivateTransportIfIdle(): Promise<void> {
    if (this.options.transport || this.operationLeases || this.activeTurns.size || this.pending.size || this.nativeQueueOrigins.size || this.unconfirmedStarts.size) return;
    const child = this.child;
    if (!child || child.exitCode !== null) return;

    const terminate = setTimeout(() => child.kill(), 1_000);
    const stopped = waitForProcessExit(child).finally(() => clearTimeout(terminate));
    this.retiringTransport = stopped;
    this.child = undefined;
    this.subscribedThreads.clear();
    this.initialized = false;
    this.lines?.close();
    this.lines = undefined;
    try {
      child.stdin.end();
    } catch {
      child.kill();
    }
    try { await stopped; }
    finally { if (this.retiringTransport === stopped) this.retiringTransport = undefined; }
  }

  async inspectThread(threadId: string, observation?: { includeTurns: false; timeoutMs: number }): Promise<CodexThreadState> {
    // Read membership when the response arrives, not before an IPC wait that
    // can overlap moving the chat out of its project.
    const membership = (state: CodexThreadState) => this.sessionMembership(true)(state);
    await this.ensureConnected();
    const activeAtRead = this.activeTurns.get(threadId);
    try {
      let response: Record<string, unknown>;
      try {
        response = await this.request("thread/read", { threadId, includeTurns: false }, observation?.timeoutMs) as Record<string, unknown>;
      } catch (error) {
        if (!/ephemeral threads do not support includeTurns/i.test(String(error))) throw error;
        response = await this.request("thread/read", { threadId, includeTurns: false }) as Record<string, unknown>;
      }
      const thread = nativeThread(response, threadId);
      // Execution preflight needs the latest turn's identity/failure, never its
      // item bodies or the entire growing conversation. Metadata-only readers
      // do not issue this additional RPC at all.
      let latest: Record<string, unknown> | undefined;
      if (!observation && thread.ephemeral !== true) {
        const page = await this.nativeTurns({ threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
        latest = isRecord(page.data[0]) ? page.data[0] : undefined;
      }
      const state = membership(parseThreadState({ ...thread, turns: latest ? [latest] : [] }, persistenceFromThread(thread)));
      const activeTurnId = this.activeTurns.get(threadId);
      // Fresh owner state outranks an old accepted-turn cache. Only a newer
      // start notification can supersede the read; history alone cannot do so.
      if (activeTurnId && (state.runtimeStatus === "active" || activeTurnId !== activeAtRead)) {
        state.activeTurnId = activeTurnId;
        state.latestTurnStatus = "inProgress";
        state.runtimeStatus = "active";
        state.recovery = this.turnRecoveries.get(turnKey(threadId, activeTurnId)) ?? state.recovery;
      }
      this.threadStates.set(threadId, state);
      return state;
    } catch (error) {
      if (isCodexCommunicationFailure(error)) throw communicationError(error, { phase: "preflight", operation: "thread/read", threadId });
      const lookups = await Promise.allSettled([this.findListedThread(threadId, true), this.findListedThread(threadId, false)]);
      const archived = lookups[0].status === "fulfilled" ? lookups[0].value : undefined;
      if (archived) {
        const state = membership(parseThreadState(archived, "archived"));
        this.threadStates.set(threadId, state);
        return state;
      }
      const active = lookups[1].status === "fulfilled" ? lookups[1].value : undefined;
      if (active) {
        const state = membership(parseThreadState(active, persistenceFromThread(active)));
        this.threadStates.set(threadId, state);
        return state;
      }
      // A failed catalog read is not evidence that the native thread vanished.
      const unavailable = lookups.find(result => result.status === "rejected");
      if (unavailable?.status === "rejected") throw unavailable.reason;
      if (isMissingOrArchivedThreadError(error)) {
        const state: CodexThreadState = {
          threadId,
          persistence: "missing",
          runtimeStatus: "unknown",
          activeFlags: []
        };
        this.threadStates.set(threadId, state);
        return state;
      }
      throw error;
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async listSessionCatalog(input: CodexThreadListInput = {}): Promise<CodexSessionCatalog> {
    if (this.options.catalogSource === "native") return {
      backend: this.id, source: "app-server-storage", hostIds: [this.options.hostId ?? "local"], complete: true,
      threads: await this.listThreads({ persistence: "active", ...input }), warnings: []
    };
    // Do not load threads or start a second app-server just to discover what
    // Desktop already indexes, including hosts with no saved project.
    const catalog = readDesktopSessionCatalog(this.options.codexHome, this.options.hostId, input);
    if (catalog) return catalog;
    await this.ensureConnected();
    try {
      const persistence = input.persistence ?? "active", limit = input.limit ?? Infinity;
      const listed: CodexThreadState[] = [];
      if (persistence !== "archived") listed.push(...await this.listThreadsByPersistence(input, false, limit, true));
      if (persistence !== "active") listed.push(...await this.listThreadsByPersistence(input, true, limit, true));
      const threads = [...new Map(listed.map(state => [state.threadId, state])).values()]
        .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")).slice(0, limit);
      return { backend: this.id, source: "app-server-storage", hostIds: [this.options.hostId ?? "local"], complete: true,
        threads: threads.map(state => ({ ...state,
          // A private reader's notLoaded/idle says nothing about Desktop.
          runtimeStatus: this.options.transport?.mode === "remote-daemon" || state.runtimeStatus === "active" || state.runtimeStatus === "systemError"
            ? state.runtimeStatus : "unknown"
        })),
        warnings: ["Codex App 目录不可用；当前显示 app-server 存储中符合 App 筛选规则的会话，不保证与 App 侧栏完全一致。ChatGPT 聊天不支持绑定。"] };
    } finally { await this.recyclePrivateTransportIfIdle(); }
  }

  async listThreads(input: CodexThreadListInput = {}): Promise<CodexThreadState[]> {
    await this.ensureConnected();
    const persistence = input.persistence ?? "all";
    const limit = input.limit === undefined ? Infinity : Math.max(1, input.limit);
    const results: CodexThreadState[] = [];
    if (persistence === "active" || persistence === "all") {
      results.push(...await this.listThreadsByPersistence(input, false, limit));
    }
    if (persistence === "archived" || persistence === "all") {
      results.push(...await this.listThreadsByPersistence(input, true, limit));
    }
    const deduped = new Map<string, CodexThreadState>();
    for (const state of results) {
      deduped.set(state.threadId, state);
      this.threadStates.set(state.threadId, state);
    }
    return [...deduped.values()]
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
      .slice(0, limit);
  }

  async createThread(input: CodexThreadCreateInput): Promise<CodexThreadState> {
    if (!input.cwd || !path.isAbsolute(input.cwd)) throw new Error("A confirmed absolute workspace is required to create a thread");
    this.operationLeases++;
    let threadId: string | undefined;
    try {
      await this.ensureConnected();
      // Metadata-only creation selects an existing native project. Never let a
      // stale selection create a replacement project as ordinary execution can.
      let projectId: string | undefined;
      if (input.projectId) {
        const canonicalId = this.projectIdentity();
        const project = (await this.requestProjects()).find(project => project.id === input.projectId || canonicalId(project.id) === input.projectId);
        if (!project) throw new Error("The selected native project no longer exists");
        projectId = project.id;
      } else if (input.projectName) throw new Error("Select an existing native project by identity");
      const response = await guardNativeWrite(input.assertCurrent, () => this.request("thread/start", compactObject({ cwd: input.cwd, ephemeral: false,
        ...(projectId ? { projectId } : input.projectBinding === "none" ? { projectId: null } : {}) }))) as Record<string, unknown>;
      const thread = response.thread as Record<string, unknown> | undefined;
      if (!thread || typeof thread.id !== "string") throw new Error("Codex did not return the new thread identity");
      threadId = thread.id; this.subscribedThreads.add(threadId);
      await input.onThreadCreated?.(threadId);
      if (input.projectBinding === "none" && thread.projectId) {
        await guardNativeWrite(input.assertCurrent, () => this.request("thread/metadata/update", { threadId, projectId: "" })); thread.projectId = null;
      }
      const title = cleanThreadTitle(input.title);
      if (title) { await guardNativeWrite(input.assertCurrent, () => this.request("thread/name/set", { threadId, name: title })); }
      const state = this.sessionMembership()(parseThreadState({ ...thread, cwd: input.cwd, ...(title ? { name: title } : {}) }, "active"));
      this.threadStates.set(threadId, state); return state;
    } finally {
      // Shared-core subscriptions remain available for the first input.
      // Explicit private stdio follows the normal idle-retirement policy;
      // the native metadata must remain resumable without placeholder input.
      this.operationLeases--; await this.recyclePrivateTransportIfIdle();
    }
  }

  async renameThread(threadId: string, title: string, assertCurrent?: () => void): Promise<CodexThreadState> {
    if (title.trim().length > 120) throw new Error("Thread name must contain at most 120 characters");
    const name = cleanThreadTitle(title);
    if (!name) throw new Error("A nonempty thread name is required");
    const state = await this.inspectThread(threadId);
    if (!["active", "archived"].includes(state.persistence) || state.internal) throw new Error("Thread is unavailable");
    await this.ensureConnected();
    try {
      await guardNativeWrite(assertCurrent, () => this.request("thread/name/set", { threadId, name }));
      const updated = { ...state, title: name }; this.threadStates.set(threadId, updated); return updated;
    } finally { await this.recyclePrivateTransportIfIdle(); }
  }

  async archiveThread(threadId: string, assertCurrent?: () => void): Promise<void> {
    await this.ensureConnected();
    try {
      await guardNativeWrite(assertCurrent, () => this.request("thread/archive", { threadId }));
      this.threadStates.set(threadId, {
        threadId,
        persistence: "archived",
        runtimeStatus: "notLoaded",
        activeFlags: []
      });
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async unarchiveThread(threadId: string, assertCurrent?: () => void): Promise<CodexThreadState> {
    await this.ensureConnected();
    try {
      const response = await guardNativeWrite(assertCurrent, () => this.request("thread/unarchive", { threadId })) as Record<string, unknown>;
      const thread = response.thread === undefined ? undefined : nativeThread(response, threadId);
      const state = thread ? this.sessionMembership()(parseThreadState(thread, "active")) : await this.inspectThread(threadId);
      this.threadStates.set(threadId, state);
      return state;
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async deleteThread(threadId: string, assertCurrent?: () => void): Promise<void> {
    await this.ensureConnected();
    try {
      await guardNativeWrite(assertCurrent, () => this.request("thread/delete", { threadId }));
      this.threadStates.set(threadId, {
        threadId,
        persistence: "missing",
        runtimeStatus: "unknown",
        activeFlags: []
      });
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  private async listThreadsByPersistence(
    input: CodexThreadListInput,
    archived: boolean,
    limit: number,
    desktopCatalogOnly = false
  ): Promise<CodexThreadState[]> {
    const states: CodexThreadState[] = [];
    const membership = this.sessionMembership(desktopCatalogOnly);
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const response = nativePage(await this.request("thread/list", compactObject({
        cursor,
        limit: Math.min(100, limit - states.length),
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        // Discovery is not scoped to the currently configured model provider.
        // Old CLI/Desktop sessions remain selectable after changing providers.
        modelProviders: [],
        ...(desktopCatalogOnly ? { useStateDbOnly: true } : {}),
        archived,
        // Explicit project membership can span worktrees with different cwd.
        cwd: input.projectId ? undefined : input.cwd
      }), Math.min(this.options.requestTimeoutMs ?? 15_000, 15_000)), "thread/list", cursor);
      for (const value of response.data) {
        if (!isRecord(value)) continue;
        if (desktopCatalogOnly && !isDesktopCatalogThread(value)) continue;
        const state = membership(parseThreadState(value, archived ? "archived" : persistenceFromThread(value)));
        if (state.internal || (input.unassigned && state.projectId)) continue;
        if (input.projectId && state.projectId !== input.projectId && value.projectId !== input.projectId) continue;
        states.push(state);
        if (states.length >= limit) break;
      }
      const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : undefined;
      if (states.length >= limit || !nextCursor) break;
      if (seenCursors.has(nextCursor)) throw new Error("Native thread catalog repeated cursor");
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return states;
  }

  private sessionMembership(legacyWorkspaceFallback = false): (state: CodexThreadState) => CodexThreadState {
    if (this.options.catalogSource === "native") return nativeSessionPresentation(this.options.codexHome, this.options.hostId);
    // A remote transport without a host identity must not consume local membership.
    if (this.options.transport?.mode === "remote-daemon" && !this.options.hostId) return (state) => state;
    return desktopSessionMembership(this.options.codexHome, this.options.hostId, legacyWorkspaceFallback);
  }

  private projectIdentity(): (id: string) => string {
    const membership = this.sessionMembership();
    // Reuse only the explicit host/home alias map. No thread assignment or
    // workspace inference may turn a project name/path into another identity.
    return id => membership({ threadId: "", projectId: id, projectMembership: "assigned",
      persistence: "active", runtimeStatus: "unknown", activeFlags: [] }).projectId ?? id;
  }

  private async findListedThread(threadId: string, archived: boolean): Promise<Record<string, unknown> | undefined> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
      do {
        const response = nativePage(await this.request("thread/list", compactObject({
          cursor,
          limit: 100,
          sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
          modelProviders: [],
          archived
        })), "thread/list", cursor);
        for (const value of response.data) {
          if (isRecord(value) && value.id === threadId) return value;
        }
        const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
          ? response.nextCursor
          : undefined;
        if (!nextCursor) break;
        if (seenCursors.has(nextCursor)) throw new Error("Native thread catalog repeated cursor");
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
    return undefined;
  }

  private async resolveProjectId(cwd: string, projectId?: string, projectName?: string, assertCurrent?: () => void, projectRoots?: readonly string[]): Promise<string | undefined> {
    const root = path.normalize(cwd);
    const legacy = projectId ? desktopProjectHint(projectId, this.options.codexHome, this.options.hostId) : undefined;
    const roots = [...new Set((projectRoots?.length ? projectRoots : legacy?.roots.length ? legacy.roots : [root]).map(value => path.normalize(value)))];
    const sameRoots = (candidate: AppServerProject) => candidate.roots.length === roots.length
      && candidate.roots.every(value => roots.includes(path.normalize(value)));
    if (this.projectCatalogSupported === false) return undefined;

    let projects: AppServerProject[];
    try {
      projects = await this.requestProjects();
      this.projectCatalogSupported = true;
    } catch (error) {
      if (!isUnsupportedProjectCatalogError(error)) throw error;
      // Older Desktop daemons do not expose project/list. thread/start still
      // accepts cwd and Desktop associates the new task with its remote project.
      this.projectCatalogSupported = false;
      return undefined;
    }
    const select = (catalog: AppServerProject[]) => {
      const explicit = projectId ? catalog.find(project => project.id === (legacy?.nativeId ?? projectId)) : undefined;
      if (explicit) return explicit;
      // A stale native id is not permission to choose a different project at
      // the same path. Only a current, same-host Desktop registry alias may
      // translate by its complete root set when no explicit mapping exists.
      if (projectId && (!legacy || legacy.nativeId)) throw new Error("Codex 项目身份已失效，请重新选择准确的项目；未按目录替换身份。");
      const candidates = catalog.filter(sameRoots);
      if (candidates.length > 1) throw new Error("此目录属于多个 Codex 项目，请指定准确的项目身份。");
      return candidates[0];
    };
    const match = select(projects);
    if (match) {
      return match.id;
    }
    if (!projectName) return undefined;

    const idempotencyKey = `codex-im-gateway:${crypto.createHash("sha256").update(JSON.stringify([this.options.hostId ?? "local", legacy ? projectId : null, roots])).digest("hex")}`;
    assertCurrent?.();
    try {
      const response = await guardNativeWrite(assertCurrent, () => this.request("project/create", {
        name: projectName,
        roots: roots.map(path => ({ path })),
        metadata: { source: "codex-im-gateway" },
        idempotencyKey
      })) as Record<string, unknown>;
      const project = parseAppServerProject(response.project);
      if (!project) throw new Error("Codex app-server did not return the created project");
      return project.id;
    } catch (error) {
      // A concurrent client may have registered the same root after our list.
      const retry = select(await this.requestProjects());
      if (!retry) throw error;
      return retry.id;
    }
  }

  async warmUp(cwd: string): Promise<void> {
    await this.getRuntimeInfo(cwd);
  }

  async listProjects(): Promise<CodexProjectCatalog> {
    await this.ensureConnected();
    try {
      if (this.projectCatalogSupported === false) {
        return { backend: "app-server", projects: [] };
      }
      let projects: AppServerProject[];
      try {
        projects = await this.requestProjects();
        this.projectCatalogSupported = true;
      } catch (error) {
        if (!isUnsupportedProjectCatalogError(error)) throw error;
        this.projectCatalogSupported = false;
        projects = [];
      }
      return {
        backend: "app-server",
        projects
      };
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  private async requestProjects(): Promise<AppServerProject[]> {
    const projects: AppServerProject[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = nativePage(await this.request("project/list", compactObject({ cursor, limit: 100 }), Math.min(this.options.requestTimeoutMs ?? 15_000, 15_000)), "project/list", cursor);
      for (const value of response.data) {
        const project = parseAppServerProject(value);
        if (project) projects.push(project);
      }
      const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : undefined;
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) throw new Error("Native project catalog repeated cursor");
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return projects;
  }

  async getHistory(threadId: string): Promise<CodexHistoryMessage[]> {
    this.operationLeases++;
    try {
      const state = await this.inspectThread(threadId, { includeTurns: false, timeoutMs: Math.min(this.options.requestTimeoutMs ?? 15_000, 15_000) });
      assertCodexThreadRunnable(state);
      const messages: CodexHistoryMessage[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.getHistoryPage(threadId, { cursor, limit: 100, sortDirection: "asc" });
        messages.push(...page.messages);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("Native turn history repeated cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return messages;
    } catch (error) {
      throw normalizeThreadOperationError(error, threadId);
    } finally {
      this.operationLeases--;
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async readThreadSnapshot(threadId: string): Promise<import("./backend.js").CodexThreadSnapshot> {
    // Keep observation reads on one connection and bound their payload.
    // A five-second follow tick must not reload an entire long-lived history.
    this.operationLeases++;
    try {
      const activeAtRead = this.activeTurns.get(threadId);
      const timeoutMs = Math.min(this.options.requestTimeoutMs ?? 15_000, 15_000);
      let state = await this.inspectThread(threadId, { includeTurns: false, timeoutMs });
      if (state.persistence === "missing" || state.persistence === "archived") return { state, turns: [] };
      await this.ensureConnected();
      const response = await this.nativeTurns({ threadId, limit: 20, sortDirection: "desc", itemsView: "summary" }, timeoutMs);
      const history = (response.data as Array<{ id: string; status: import("./backend.js").CodexTurnStatus; startedAt?: number; completedAt?: number | null }>).slice().reverse();
      // Native history reconstruction can label a newly consumed queue turn
      // interrupted before it has an end event. Even idle metadata after the
      // history read cannot certify that older view: the turn may have finished
      // in between. An explicit null completion time is not a terminal receipt.
      // Omitted fields from older servers retain their existing compatibility.
      const unconfirmedEnd = (turn: typeof history[number]) => turn.status !== "inProgress" && turn.completedAt === null;
      if (history.at(-1) && unconfirmedEnd(history.at(-1)!))
        throw new CodexCommunicationError("observation", "thread/snapshot", threadId, history.at(-1)!.id);
      // Older incomplete reconstructions cannot close a historical task either;
      // omitting them from this bounded view does not settle any pending turn.
      const turns = history.filter(turn => !unconfirmedEnd(turn));
      // A native queue can advance after the initial metadata read. History
      // reconstruction alone can briefly label its new running turn interrupted;
      // recheck the owner after history before treating any turn as terminal.
      state = await this.inspectThread(threadId, { includeTurns: false, timeoutMs });
      this.reconcileObservedTerminal(threadId, state, turns.find(turn => turn.id === activeAtRead), activeAtRead);
      const newerActive = this.activeTurns.get(threadId);
      if (newerActive && newerActive !== activeAtRead) {
        state.runtimeStatus = "active";
        state.activeTurnId = newerActive;
        state.latestTurnStatus = "inProgress";
        state.activeFlags = this.threadStates.get(threadId)?.activeFlags ?? [];
      }
      const failure = lastCodexTurnFailure(turns.at(-1));
      const activeId = state.activeTurnId ?? turns.filter(turn => turn.status === "inProgress").at(-1)?.id;
      const active = turns.find(turn => turn.id === activeId && turn.status === "inProgress");
      const recovery = state.runtimeStatus === "active" && active
        ? this.turnRecoveries.get(turnKey(threadId, active.id)) ?? codexTurnRecovery(threadId, active) : undefined;
      return { state: { ...state, lastTurnFailure: failure, recovery,
        ...(state.runtimeStatus === "active" && active ? { activeTurnId: active.id } : {}) }, turns: turns.map((turn) => ({
        id: turn.id, status: turn.status, ...(unixTimestampToIso(turn.startedAt) ? { startedAt: unixTimestampToIso(turn.startedAt) } : {}),
        messages: parseThreadHistory({ turns: [turn] })
      })) };
    } finally {
      this.operationLeases--;
      await this.recyclePrivateTransportIfIdle();
    }
  }

  private reconcileObservedTerminal(threadId: string, state: CodexThreadState,
    turn: Record<string, unknown> | undefined, activeAtRead: string | undefined): void {
    // A loaded, inactive owner plus the exact accepted terminal receipt can
    // repair a missed notification. notLoaded/history, a different turn, or a
    // start received during these reads cannot certify this run's ending.
    // Metadata-only notLoaded items cannot settle a run: doing so would lose
    // its final answer before the history reader fetched the summary items.
    if (!activeAtRead || this.activeTurns.get(threadId) !== activeAtRead || state.persistence !== "active"
      || !["idle", "systemError"].includes(state.runtimeStatus) || turn?.id !== activeAtRead
      || turn.itemsView === "notLoaded" || !Array.isArray(turn.items)
      || typeof turn.status !== "string" || !["completed", "failed", "interrupted"].includes(turn.status)) return;
    const params = {threadId, turn};
    this.handleNotification("turn/completed", params, JSON.stringify({method:"turn/completed", params, source:"owner-snapshot"}));
  }

  async recoverSystemError(input: CodexSystemRecoveryInput): Promise<CodexSystemRecoveryResult> {
    this.operationLeases++;
    try {
      if (input.lifecycle?.restoring) {
        if (!await this.restoreRecoveryPersistence(input, input.lifecycle.archiveConfirmed === true))
          return { status: "deferred", reason: "unconfirmed" };
      }
      let before = await this.readThreadSnapshot(input.threadId);
      input.assertCurrent();
      if (before.state.threadId !== input.threadId || !canRecoverSystemError(before, input.failedTurnId))
        return { status: "deferred", reason: "changed", state: before.state };
      if (this.activeTurns.has(input.threadId) || this.unconfirmedStarts.has(input.threadId))
        return { status: "deferred", reason: "unconfirmed" };
      let queue: CodexQueuePage;
      try { queue = await this.listQueuedSubmissions(input.threadId); }
      catch (error) {
        if (error instanceof CodexBackendCapabilityError) return { status: "unsupported", reason: "owner-unsupported" };
        throw error;
      }
      if ([...this.nativeQueueOrigins.values()].some(origin => origin.threadId === input.threadId)
        || queue.data.length || queue.nextCursor)
        return { status: "deferred", reason: "busy" };
      // A resumed active Goal can start inference autonomously. State repair
      // must never become implicit permission to continue that objective.
      if (input.lifecycle && (await this.getGoal(input.threadId))?.status === "active")
        return { status: "deferred", reason: "busy" };
      // Rehydrate the exact native identity with inherited settings. No
      // turn/start, injected history, empty prompt or private-reader fallback.
      await this.ensureConnected();
      const current = await this.readThreadSnapshot(input.threadId);
      input.assertCurrent();
      if (current.state.threadId !== input.threadId || !canRecoverSystemError(current, input.failedTurnId)
        || current.state.runtimeStatus !== before.state.runtimeStatus || this.activeTurns.has(input.threadId)
        || this.unconfirmedStarts.has(input.threadId)) return { status: "deferred", reason: "changed", state: current.state };
      if (before.state.runtimeStatus === "systemError") {
        if (input.lifecycle && !input.lifecycle.restoring) {
          // A retained native owner prevents idle-unload indefinitely. The
          // native archive/unarchive lifecycle releases exactly this failed
          // runtime without executing a turn. Rollback intent must be durable
          // BEFORE archive, and restoring active persistence is mandatory even
          // if the source lease changes after that write.
          const journal = input.lifecycle.beforeArchive();
          if (journal) await journal;
          let acknowledged = false;
          try {
            await guardNativeWrite(input.assertCurrent, () => this.request("thread/archive", { threadId: input.threadId }, 5_000));
            acknowledged = true; const receipt = input.lifecycle.archived(); if (receipt) await receipt;
          } finally { await this.restoreRecoveryPersistence(input, acknowledged); }
          input.assertCurrent();
          before = await this.readThreadSnapshot(input.threadId);
          input.assertCurrent();
          if (before.state.threadId !== input.threadId || !canRecoverSystemError(before, input.failedTurnId)
            || before.state.runtimeStatus !== "notLoaded") return { status: "deferred", reason: "changed", state: before.state };
          const afterRestoreQueue = await this.listQueuedSubmissions(input.threadId);
          input.assertCurrent();
          if (afterRestoreQueue.data.length || afterRestoreQueue.nextCursor || (await this.getGoal(input.threadId))?.status === "active")
            return { status: "deferred", reason: "busy" };
        } else {
        // Resume on a loaded errored thread does not clear its native status.
        // Release only this connection's subscription; native idle unload
        // decides when it is safe. Never kill a shared server or other owner.
        const released = await guardNativeWrite(input.assertCurrent, () => this.request("thread/unsubscribe", { threadId: input.threadId }, 5_000)) as { status?: string };
        if (!["notLoaded", "notSubscribed", "unsubscribed"].includes(released?.status ?? ""))
          return { status: "deferred", reason: "unconfirmed" };
        this.subscribedThreads.delete(input.threadId);
        input.assertCurrent();
        return { status: "deferred", reason: "awaiting-unload", state: before.state };
        }
      }
      const response = await guardNativeWrite(input.assertCurrent, () => this.request("thread/resume", { threadId: input.threadId, excludeTurns: true }, 5_000)) as { thread?: { id?: string } };
      if (response?.thread?.id !== input.threadId) return { status: "deferred", reason: "unconfirmed" };
      this.subscribedThreads.add(input.threadId);
      input.assertCurrent();
      const after = await this.readThreadSnapshot(input.threadId);
      input.assertCurrent();
      return after.state.persistence === "active" && ["idle", "active"].includes(after.state.runtimeStatus)
        ? { status: "recovered", state: after.state }
        : { status: "failed", reason: "still-system-error", state: after.state };
    } finally { this.operationLeases--; await this.recyclePrivateTransportIfIdle(); }
  }

  private async restoreRecoveryPersistence(input: CodexSystemRecoveryInput, archiveConfirmed: boolean): Promise<boolean> {
    const state = (await this.readThreadSnapshot(input.threadId)).state;
    if (state.threadId !== input.threadId) throw Error("Recovery restore identity changed");
    let confirmed = archiveConfirmed;
    if (state.persistence === "archived") {
      await this.request("thread/unarchive", { threadId: input.threadId }, 5_000);
      confirmed = true;
    }
    const actual = (await this.readThreadSnapshot(input.threadId)).state;
    if (actual.threadId === input.threadId && actual.persistence === "active" && confirmed) {
      const receipt = input.lifecycle!.restored(); if (receipt) await receipt; return true;
    }
    // A timed-out archive may still be executing. Do not clear the durable
    // restoration obligation, or repeat archive, merely because a read is active.
    return false;
  }

  async readNativeTurnLifecycle(threadId: string, turnId: string): Promise<import("./backend.js").CodexTurnObservation> {
    // A remote daemon's path belongs to that remote filesystem. Never read a
    // same-named local file or invent an SSH route for this observation.
    if (this.options.transport?.mode === "remote-daemon") return { status: "unknown", source: "unknown" };
    this.operationLeases++;
    try {
      await this.ensureConnected();
      const response = await this.request("thread/read", { threadId, includeTurns: false }) as { thread?: { id?: string; path?: string } };
      if (response.thread?.id !== threadId || !response.thread.path || !path.isAbsolute(response.thread.path))
        return { status: "unknown", source: "unknown" };
      return await readNativeTurnLifecycle(response.thread.path, threadId, turnId);
    } finally { this.operationLeases--; await this.recyclePrivateTransportIfIdle(); }
  }
  async readThreadProvenance(threadId: string): Promise<import("./backend.js").CodexThreadProvenance | undefined> {
    if (this.options.transport?.mode === "remote-daemon") return;
    this.operationLeases++;
    try {
      await this.ensureConnected();
      const response = await this.request("thread/read", { threadId, includeTurns: false }, Math.min(this.options.requestTimeoutMs ?? 15000, 15000)) as { thread?: { id?: string; path?: string } };
      if (response.thread?.id !== threadId || !response.thread.path || !path.isAbsolute(response.thread.path)) return;
      return await readNativeThreadProvenance(response.thread.path, threadId);
    } finally { this.operationLeases--; await this.recyclePrivateTransportIfIdle(); }
  }

  private async nativeTurns(params: Record<string, unknown>, timeoutMs?: number): Promise<ReturnType<typeof nativePage>> {
    try { return nativePage(await this.request("thread/turns/list", params, timeoutMs), "thread/turns/list", params.cursor as string | undefined); }
    catch (error) {
      // Current native servers explicitly distinguish an unmaterialized empty
      // thread from missing/malformed history. Never normalize another error.
      const expected = `app-server thread/turns/list failed (-32600): thread ${params.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`;
      if (params.cursor || !(error instanceof Error) || error.message !== expected) throw error;
      const thread = nativeThread(await this.request("thread/read", { threadId: params.threadId, includeTurns: false }, timeoutMs) as Record<string, unknown>, String(params.threadId));
      const state = parseThreadState(thread, persistenceFromThread(thread));
      if (state.persistence !== "active" || state.activeTurnId || state.activeFlags.length || !["idle", "notLoaded"].includes(state.runtimeStatus)) throw error;
      return { data: [] };
    }
  }

  async getHistoryPage(
    threadId: string,
    input: CodexHistoryPageInput = {}
  ): Promise<CodexHistoryPage> {
    await this.ensureConnected();
    try {
      const response = await this.nativeTurns(compactObject({
        threadId,
        cursor: input.cursor,
        limit: Math.max(1, Math.min(input.limit ?? 20, 100)),
        sortDirection: input.sortDirection ?? "desc",
        // Explicit history preserves commentary as well as final replies.
        // The router confines this bulk read to the history-only connection.
        itemsView: "full"
      }));
      const turns = response.data.slice();
      if ((input.sortDirection ?? "desc") === "desc") turns.reverse();
      return {
        messages: parseThreadHistory({ turns }),
        ...(typeof response.nextCursor === "string" && response.nextCursor
          ? { nextCursor: response.nextCursor }
          : {}),
        ...(typeof response.backwardsCursor === "string" && response.backwardsCursor
          ? { backwardsCursor: response.backwardsCursor }
          : {})
      };
    } catch (error) {
      throw normalizeThreadOperationError(error, threadId);
    } finally {
      await this.recyclePrivateTransportIfIdle();
    }
  }

  async steer(input: CodexSteerInput): Promise<CodexSteerResult> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("介入内容不能为空。");
    await this.ensureConnected();

    let turnId = input.expectedTurnId ?? this.activeTurns.get(input.threadId);
    if (!turnId) {
      const state = await this.inspectThread(input.threadId);
      assertCodexThreadRunnable(state);
      turnId = state.activeTurnId;
      await this.ensureConnected();
    }
    if (!turnId) {
      throw new Error(`Codex session ${input.threadId} 当前没有正在执行的任务，无法介入。`);
    }

    try {
      const response = await guardNativeWrite(input.assertCurrent, () => this.request("turn/steer", {
        threadId: input.threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        expectedTurnId: turnId,
        ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {})
      })) as Record<string, unknown>;
      if (response.turnId !== turnId) throw new CodexCommunicationError("submission", "turn/steer", input.threadId, undefined,
        { code: "InvalidAcknowledgement" });
      return { status: "accepted", threadId: input.threadId, turnId };
    } catch (error) {
      throw normalizeSteerError(error, input.threadId, turnId);
    }
  }

  async addQueuedSubmission(input: CodexQueueAddInput): Promise<CodexQueuedSubmission> {
    if (!input.prompt.trim() || !input.clientUserMessageId) throw new Error("Queue input and client message id are required");
    if (input.enqueueOnly || ((this.options.transport?.mode === "remote-daemon" || this.options.transport?.mode === "daemon-proxy") && !this.activeTurns.has(input.threadId))) {
      // Native queue storage observes cross-process revisions. Its live owner
      // consumes the item; this client must not resume, change permissions, or
      // retain execution handlers for that external owner's turn.
      const result = await this.queueOperation("thread/queue/add", {
        threadId: input.threadId, clientUserMessageId: input.clientUserMessageId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }]
      }, inheritWriteCheck(input.assertCurrent, () => assertQueueAdmissionCurrent(input))) as { queuedSubmission?: CodexQueuedSubmission };
      if (!result.queuedSubmission?.id || result.queuedSubmission.clientUserMessageId !== input.clientUserMessageId)
        throw new Error("Native queue acknowledgement is incomplete; do not resubmit");
      return result.queuedSubmission;
    }
    // add can start immediately on a loaded idle thread. Retain the transport
    // and approval origin BEFORE writing, even before the add ack arrives.
    this.nativeQueueOrigins.set(input.clientUserMessageId, input);
    this.operationLeases++;
    let result: { queuedSubmission?: CodexQueuedSubmission };
    try {
      await this.ensureConnected();
      // thread/resume subscribes without submitting a prompt. An idle loaded
      // thread can auto-consume add, so subscribe before that external write.
      // Never reconfigure an already running turn to attach its queue.
      if (!this.subscribedThreads.has(input.threadId)) {
        await guardNativeWrite(inheritWriteCheck(input.assertCurrent, () => {}), () => this.request("thread/resume", { threadId: input.threadId, excludeTurns: true }));
        this.subscribedThreads.add(input.threadId);
      }
      result = await guardNativeWrite(inheritWriteCheck(input.assertCurrent, () => assertQueueAdmissionCurrent(input)), () => this.queueRequest("thread/queue/add", {
        threadId: input.threadId, clientUserMessageId: input.clientUserMessageId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }]
      })) as { queuedSubmission?: CodexQueuedSubmission };
    }
    catch (error) {
      if (error instanceof CodexBackendCapabilityError || error instanceof CodexQueueAdmissionError) {
        this.nativeQueueOrigins.delete(input.clientUserMessageId);
        if (this.subscribedThreads.has(input.threadId) && !this.activeTurns.has(input.threadId)
          && ![...this.nativeQueueOrigins.values()].some(origin => origin.threadId === input.threadId)) {
          await this.unsubscribeThread(input.threadId);
        }
      }
      throw error;
    }
    finally { this.operationLeases--; await this.recyclePrivateTransportIfIdle(); }
    if (!result.queuedSubmission?.id || result.queuedSubmission.clientUserMessageId !== input.clientUserMessageId) {
      throw new Error("Native queue acknowledgement is incomplete; do not resubmit");
    }
    return result.queuedSubmission;
  }

  async listQueuedSubmissions(threadId: string, cursor?: string): Promise<CodexQueuePage> {
    const result = await this.queueOperation("thread/queue/list", compactObject({ threadId, cursor, limit: 100 })) as {
      data?: CodexQueuedSubmission[]; nextCursor?: string | null;
    };
    if (!Array.isArray(result.data)) throw new Error("Invalid native queue list response");
    return { data: result.data, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  }

  async deleteQueuedSubmission(threadId: string, queuedSubmissionId: string, _hostId?: string, assertCurrent?: () => void): Promise<boolean> {
    let item: CodexQueuedSubmission | undefined, cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.listQueuedSubmissions(threadId, cursor);
      item = page.data.find(x => x.id === queuedSubmissionId); cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Native queue pagination repeated cursor");
      if (cursor) cursors.add(cursor);
    } while (!item && cursor);
    const result = await this.queueOperation("thread/queue/delete", { threadId, queuedSubmissionId }, assertCurrent) as { deleted?: boolean };
    if (result.deleted && item) this.nativeQueueOrigins.delete(item.clientUserMessageId);
    if (result.deleted && this.subscribedThreads.has(threadId) && !this.activeTurns.has(threadId)
      && ![...this.nativeQueueOrigins.values()].some(origin => origin.threadId === threadId)) {
      await this.unsubscribeThread(threadId);
      await this.recyclePrivateTransportIfIdle();
    }
    return result.deleted === true;
  }

  async runQueuedSubmission(input: CodexQueuedRunInput): Promise<CodexRunResult> {
    this.operationLeases++;
    this.expectedTurnThreads.set(input.threadId, (this.expectedTurnThreads.get(input.threadId) ?? 0) + 1);
    try {
      await this.ensureConnected();
      if (input.observeOnly) {
        const turnId = input.acceptedTurnId;
        if (!turnId) throw new CodexInterventionError("只读恢复缺少原生轮次，未启动任务。");
        let observed = observeOwnerTurn(await this.readThreadSnapshot(input.threadId), input.threadId, turnId);
        if (observed.source === "unknown") observed = await this.readNativeTurnLifecycle(input.threadId, turnId);
        if (observed.status === "unknown" || observed.status === "inProgress" || observed.source === "unknown")
          throw new CodexCommunicationError("observation", "queue/observe", input.threadId, turnId);
        await input.onTurnStarted?.({ threadId: input.threadId, turnId, status: observed.status });
        if (observed.status !== "completed") throw new CodexTurnExecutionError(observed.status, "原生轮次已确认结束", observed.failureCode);
        return { threadId: input.threadId, turnId, text: observed.text || "任务已完成。", raw: "" };
      }
      const existing = await this.findQueuedTurn(input.threadId, input.clientUserMessageId, input.acceptedTurnId);
      if (existing) return await this.adoptQueuedTurn(input, existing);
      if (input.acceptedTurnId) throw new Error("已接收的原生队列轮次暂时无法核对，未重复启动。");
      if (!input.queuedSubmissionId) throw new Error("缺少待执行项 ID，未启动任务。");
      return await this.runWithLease({ ...input, prompt: "" });
    }
    finally {
      this.releaseExpectedTurnThread(input.threadId);
      if (this.subscribedThreads.has(input.threadId) && !this.activeTurns.has(input.threadId)
        && ![...this.nativeQueueOrigins.values()].some(origin => origin.threadId === input.threadId)) {
        await this.unsubscribeThread(input.threadId);
      }
      this.operationLeases--; await this.recyclePrivateTransportIfIdle();
    }
  }

  private async adoptQueuedTurn(input: CodexQueuedRunInput, turn: Record<string, unknown>): Promise<CodexRunResult> {
    // Native history and the loaded owner are separate snapshots: a queue
    // summary can already look terminal while this subscription still owns
    // its active turn. Keep waiting for that exact turn's final event instead
    // of treating the transitional view as a failed read-only recovery.
    if (this.subscribedThreads.has(input.threadId) && this.activeTurns.get(input.threadId) === turn.id) {
      return this.observeQueuedTurn(input, { ...turn, status: "inProgress" });
    }
    if (turn.status !== "inProgress") return this.runQueuedSubmission({ ...input, observeOnly: true, acceptedTurnId: String(turn.id) });
    if (!this.subscribedThreads.has(input.threadId)) {
      if (input.onItem) this.itemHandlersByThread.set(input.threadId, input.onItem);
      if (input.onApproval) this.approvalHandlersByThread.set(input.threadId, input.onApproval);
      this.bindUserInputHandlers(input.threadId, input);
      await this.request("thread/resume", { threadId: input.threadId, excludeTurns: true });
      this.subscribedThreads.add(input.threadId);
      const refreshed = await this.findQueuedTurn(input.threadId, undefined, String(turn.id));
      if (!refreshed) throw new Error("已接收的轮次无法核对，未重复启动。");
      return this.observeQueuedTurn(input, refreshed);
    }
    return this.observeQueuedTurn(input, turn);
  }

  private async findQueuedTurn(threadId: string, clientId?: string, turnId?: string): Promise<Record<string, unknown> | undefined> {
    if (!clientId && !turnId) return undefined;
    const cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await this.request("thread/turns/list", compactObject({ threadId, cursor, limit: 100,
        sortDirection: "desc", itemsView: "summary" }), Math.min(this.options.requestTimeoutMs ?? 15_000, 15_000)) as {
        data: Array<Record<string, unknown>>; nextCursor?: string;
      };
      const turn = page.data.find(t => turnId ? t.id === turnId : Array.isArray(t.items)
        && t.items.some(i => i.type === "userMessage" && i.clientId === clientId));
      if (turn) return turn;
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Native turn history repeated cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return undefined;
  }

  private async findRecentlyConsumedTurn(threadId: string, clientId?: string): Promise<Record<string, unknown> | undefined> {
    if (!clientId) return undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const turn = await this.findQueuedTurn(threadId, clientId);
      if (turn) return turn;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return undefined;
  }

  private async observeQueuedTurn(input: CodexQueuedRunInput, turn: Record<string, unknown>): Promise<CodexRunResult> {
    const turnId = String(turn.id), key = turnKey(input.threadId, turnId);
    const status = normalizeTurnStatus(turn.status);
    if (!status) throw new CodexCommunicationError("observation", "queue/observe", input.threadId, turnId);
    if (turn.status === "inProgress") {
      if (input.onItem) this.itemHandlersByThread.set(input.threadId, input.onItem);
      if (input.onApproval) this.approvalHandlersByThread.set(input.threadId, input.onApproval);
      this.bindUserInputHandlers(input.threadId, input);
    }
    await input.onTurnStarted?.({ threadId: input.threadId, turnId, status });
    this.turnStreams.set(key, { onItem: input.onItem, onDelta: input.onDelta, onProgress: input.onProgress, onRecovery: input.onRecovery, chain: Promise.resolve() });
    for (const event of this.queuedTurnEvents.get(key) ?? []) this.enqueueTurnEvent(key, event);
    this.queuedTurnEvents.delete(key);
    if (this.completedTurns.has(key)) return await this.waitForTurn(input.threadId, turnId);
    if (turn.status !== "inProgress") {
      if (input.clientUserMessageId) this.nativeQueueOrigins.delete(input.clientUserMessageId);
      return await new Promise<CodexRunResult>((resolve, reject) => {
        void this.finishTurn(input.threadId, key, { status: String(turn.status), text: extractAgentMessageFromTurn(turn),
          failureCode: turn.status === "failed" ? codexFailureCode(turn.error) : undefined,
          raw: JSON.stringify(turn), error: typeof (turn.error as { message?: string })?.message === "string"
            ? (turn.error as { message: string }).message : undefined }, resolve, reject);
      });
    }
    return await this.waitForTurn(input.threadId, turnId);
  }

  private async queueOperation(method: string, params: Record<string, unknown>, assertCurrent?: () => void): Promise<unknown> {
    this.operationLeases++;
    try { await this.ensureConnected(); return await guardNativeWrite(assertCurrent, () => this.queueRequest(method, params)); }
    finally { this.operationLeases--; await this.recyclePrivateTransportIfIdle(); }
  }

  private async queueRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    try { return await this.request(method, params, Math.min(this.options.requestTimeoutMs ?? 30_000, 30_000)); }
    catch (error) {
      if (/method not found|unknown (?:method|variant)|experimental.*(?:disabled|unsupported)/i.test(String(error))) {
        throw new CodexBackendCapabilityError("nativeQueue", "app-server");
      }
      throw error;
    }
  }

  async getRuntimeInfo(cwd: string, threadId?: string): Promise<CodexRuntimeInfo> {
    await this.ensureConnected();
    if (threadId) {
      // thread/read reports current loaded settings or the last persisted
      // native settings. Never substitute cached/global values for this thread.
      const thread = nativeThread(await this.request("thread/read", { threadId, includeTurns: false }), threadId);
      return { ...runtimeInfoFromThreadResponse(thread),
        ...(this.runtimeInfoByThread.get(threadId)?.collaborationMode
          ? { collaborationMode: this.runtimeInfoByThread.get(threadId)!.collaborationMode } : {}) };
    }
    const response = await this.request("config/read", { cwd, includeLayers: false }) as Record<string, unknown>;
    const config = response.config as Record<string, unknown> | undefined;
    return compactRuntimeInfo({
      model: config?.model,
      effort: config?.model_reasoning_effort,
      provider: config?.model_provider ?? config?.modelProvider
    });
  }

  async updateThreadSettings(threadId: string, patch: import("./backend.js").CodexThreadSettingsPatch,
    assertCurrent?: import("./write-guard.js").CodexWriteGuard): Promise<CodexRuntimeInfo> {
    this.operationLeases++;
    try {
      await this.ensureConnected();
      // Subscribe to the same owner to receive the settings-applied event.
      // A freshly created persistent thread can briefly precede its rollout
      // index. Retry only that explicit read/attach rejection, never a settings
      // write or an ambiguous transport failure, and never create a turn.
      let response: Record<string, unknown>;
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          response = await guardNativeWrite(assertCurrent, () => this.request("thread/resume", { threadId, excludeTurns: true })) as Record<string, unknown>;
          break;
        } catch (error) {
          if (!/no rollout found for thread id/i.test(String(error)) || Date.now() >= deadline) throw error;
          nativeThread(await this.request("thread/read", { threadId, includeTurns: false }), threadId);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      nativeThread(response, threadId); this.subscribedThreads.add(threadId);
      const current = runtimeInfoFromThreadResponse(response);
      const mode = patch.collaborationMode === "toggle"
        ? current.collaborationMode === "plan" ? "default" : current.collaborationMode === "default" ? "plan" : undefined
        : patch.collaborationMode;
      if (patch.collaborationMode && (!mode || !current.model)) throw new Error("原生会话未返回完整计划模式设置，未修改设置。");
      const params = compactObject({ threadId, model: patch.model, effort: patch.effort,
        ...(mode ? { collaborationMode: { mode, settings: {
          model: patch.model ?? current.model, reasoning_effort: patch.effort ?? current.effort ?? null, developer_instructions: null
        } } } : {}) });
      const matches = (value: CodexRuntimeInfo) => (!patch.model || value.model === patch.model)
        && (!patch.effort || value.effort === patch.effort) && (!mode || value.collaborationMode === mode);
      if (matches(current)) { assertCurrent?.(); return current; }
      let observe!: (value: CodexRuntimeInfo) => void;
      let timer!: ReturnType<typeof setTimeout>;
      const applied = new Promise<CodexRuntimeInfo>((resolve, reject) => {
        observe = value => { if (matches(value)) resolve(value); };
        timer = setTimeout(() => reject(new Error("设置请求已提交，但原生生效回执尚未确认；请查询当前设置，未自动重发。")), 5000);
      });
      void applied.catch(() => {});
      const observers = this.settingsObservers.get(threadId) ?? new Set();
      observers.add(observe); this.settingsObservers.set(threadId, observers);
      try {
        try { await guardNativeWrite(assertCurrent, () => this.request("thread/settings/update", params)); }
        catch (error) {
          if (/method not found|unknown (?:method|variant)|experimental.*(?:disabled|unsupported)/i.test(String(error)))
            throw new Error("当前 Codex 不支持原生会话设置接口，请升级 Codex；Gateway 未保存替代设置。");
          throw error;
        }
        return await applied;
      } finally {
        clearTimeout(timer); observers.delete(observe);
        if (!observers.size) this.settingsObservers.delete(threadId);
      }

    } finally { this.operationLeases--; await this.recyclePrivateTransportIfIdle(); }
  }

  async listModels(): Promise<CodexModelOption[]> {
    if (this.modelOptions) {
      return structuredClone(this.modelOptions);
    }
    await this.ensureConnected();
    const models: CodexModelOption[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = nativePage(await this.request("model/list", compactObject({
        cursor,
        includeHidden: false,
        limit: 100
      })), "model/list", cursor);
      const data = response.data;
      for (const item of data) {
        const option = parseModelOption(item);
        if (option && !models.some((candidate) => candidate.model === option.model)) {
          models.push(option);
        }
      }
      const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : undefined;
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) throw new Error("Native model catalog repeated cursor");
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    this.modelOptions = models;
    return structuredClone(models);
  }

  async getAccountRateLimits(model?: string): Promise<CodexAccountBalance> {
    await this.ensureConnected();
    return parseAccountRateLimits(await this.request("account/rateLimits/read", {}), model);
  }

  async listSkills(cwd: string): Promise<CodexSkillOption[]> {
    await this.ensureConnected();
    const page = nativePage(await this.request("skills/list", { cwds: [cwd], forceReload: false }, undefined, true), "skills/list");
    const entries = page.data.filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.cwd === "string" && path.normalize(entry.cwd) === path.normalize(cwd));
    if (entries.length !== 1) throw new Error("Native skill directory does not match the requested directory");
    const entry = entries[0];
    if (!Array.isArray(entry.skills) || !Array.isArray(entry.errors) || entry.errors.length)
      throw new Error("Native skill catalog is unavailable");
    const skills: CodexSkillOption[] = [];
    for (const value of entry.skills) {
      if (!isRecord(value) || typeof value.enabled !== "boolean") throw new Error("Invalid native skill catalog entry");
      const skill = value;
      if (!skill.enabled) continue;
      if (typeof skill.name !== "string" || !skill.name.trim() || typeof skill.path !== "string" || !skill.path.trim()
        || typeof skill.scope !== "string") throw new Error("Invalid native skill catalog entry");
      // Native scopes may intentionally contain the same name. Selection must
      // retain its concrete file, rather than hiding one or rejecting all.
      const id = JSON.stringify([skill.name, skill.path]);
      if (skills.some(item => item.id === id)) continue;
      const display = isRecord(skill.interface) ? skill.interface.displayName : undefined;
      skills.push({ id, name: skill.name, label: typeof display === "string" && display.trim() ? display : skill.name,
        description: typeof skill.description === "string" ? skill.description : "", path: skill.path, scope: skill.scope });
    }
    return skills;
  }

  async listMcpServers(threadId?: string): Promise<CodexMcpServerOption[]> {
    await this.ensureConnected();
    const servers: CodexMcpServerOption[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = nativePage(await this.request("mcpServerStatus/list", compactObject({ threadId, cursor, limit: 100, detail: "full" }), undefined, true), "mcpServerStatus/list", cursor);
      for (const item of page.data) {
        if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim() || typeof item.authStatus !== "string"
          || !isRecord(item.tools)) throw new Error("Invalid native MCP catalog entry");
        if (servers.some(server => server.id === item.name)) throw new Error("Native MCP catalog repeated server identity");
        const tools = Object.values(item.tools as Record<string, unknown>).map(value => {
          if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) throw new Error("Invalid native MCP tool catalog entry");
          return { name: value.name, description: typeof value.description === "string" ? value.description : "" };
        });
        // Authentication state is public; capabilities, opaque _meta and
        // connection configuration are not catalog display fields.
        servers.push({ id: item.name, label: item.name, authStatus: item.authStatus, tools });
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Native MCP catalog repeated cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return servers;
  }

  async getGoal(threadId: string): Promise<CodexThreadGoal | undefined> {
    await this.ensureConnected();
    const response = await this.request("thread/goal/get", { threadId }) as { goal?: unknown };
    return parseThreadGoal(response.goal);
  }

  async setGoal(
    threadId: string,
    input: { objective?: string; status?: CodexThreadGoalStatus; tokenBudget?: number },
    assertCurrent?: () => void
  ): Promise<CodexThreadGoal | undefined> {
    await this.ensureConnected();
    const response = await guardNativeWrite(assertCurrent, () => this.request("thread/goal/set", {
      threadId,
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {})
    })) as { goal?: unknown };
    return parseThreadGoal(response.goal);
  }

  async clearGoal(threadId: string, assertCurrent?: () => void): Promise<void> {
    await this.ensureConnected();
    await guardNativeWrite(assertCurrent, () => this.request("thread/goal/clear", { threadId }));
  }

  async stop(threadId?: string, assertCurrent?: () => void): Promise<CodexStopResult> {
    if (threadId) await this.ensureConnected();
    if (!this.initialized || !this.child || this.child.exitCode !== null) {
      return "not-active";
    }

    let target = threadId && this.activeTurns.has(threadId)
      ? { threadId, turnId: this.activeTurns.get(threadId) as string }
      : undefined;
    if (threadId && !target) {
      const state = await this.inspectThread(threadId);
      assertCodexThreadRunnable(state);
      if (state.latestTurnStatus === "inProgress" && state.activeTurnId) {
        target = { threadId, turnId: state.activeTurnId };
      }
      await this.ensureConnected();
    }
    if (!threadId) {
      target = Array.from(this.activeTurns.entries(), ([activeThreadId, turnId]) => ({
        threadId: activeThreadId,
        turnId
      })).at(-1);
    }
    if (!target) {
      return "not-active";
    }

    await guardNativeWrite(assertCurrent, () => this.request("turn/interrupt", target));
    return "interrupted";
  }

  async interruptTurn(threadId: string, turnId: string, assertCurrent?: () => void): Promise<void> {
    if (!threadId || !turnId) throw new Error("Exact native thread and turn identity are required");
    await this.ensureConnected();
    await guardNativeWrite(assertCurrent, () => this.request("turn/interrupt", { threadId, turnId }));
  }

  async readTurnActivities(threadId: string, turnId: string): Promise<CodexPublicActivity[]> {
    await this.ensureConnected();
    const seen = new Set<string>(); let cursor: string | undefined;
    do {
      const page = nativePage(await this.request("thread/turns/list", compactObject({ threadId,
        cursor, limit: 100, sortDirection: "desc", itemsView: "full" }), undefined, true), "thread/turns/list", cursor);
      const turn = page.data.find(value => isRecord(value) && value.id === turnId);
      if (isRecord(turn)) {
        if (!Array.isArray(turn.items)) throw new Error("Native turn activity is unavailable");
        return turn.items.flatMap(item => {
          const completed = !isRecord(item) || !["inProgress", "in_progress"].includes(String(item.status));
          const activity = nativePublicActivity(item, completed);
          return activity ? [activity] : [];
        });
      }
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error("Native turn activity repeated cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    throw new Error("Exact native turn activity could not be reconciled");
  }

  hasInFlightWork(): boolean {
    return Boolean(this.operationLeases || this.activeTurns.size || this.unconfirmedStarts.size || this.nativeQueueOrigins.size);
  }

  get executionLifetime(): "gateway" | "independent" {
    return this.options.transport?.mode === "daemon-proxy" || this.options.transport?.mode === "remote-daemon" ? "independent" : "gateway";
  }

  hasRestartBlockingWork(): boolean {
    if (this.executionLifetime === "gateway") return this.hasInFlightWork();
    // A daemon owns execution and pending human requests. Durable uncertain
    // receipts are reconciled after reconnect, never an indefinite restart latch.
    // Protect live RPC handoffs and response flushes, not native resolution waits.
    const reads = new Set(["initialize", "server/diagnostics", "thread/read", "thread/list", "thread/turns/list", "thread/queue/list", "project/list", "config/read", "model/list", "account/read", "account/rateLimits/read", "thread/goal/get"]);
    return this.responseWrites.size > 0
      || [...this.pending.values()].some(request => !request.readOnly && !reads.has(request.method));
  }

  async serverIdentity(): Promise<{ processId: number }> {
    await this.ensureConnected();
    const result = await this.request("server/diagnostics", {}) as { process?: { id?: unknown } };
    if (!Number.isSafeInteger(result.process?.id) || Number(result.process?.id) <= 0) throw new Error("Invalid native server process identity");
    return { processId: Number(result.process!.id) };
  }

  interactionSubscriptionReady(threadId: string): boolean {
    return this.initialized && this.child?.exitCode === null && this.subscribedThreads.has(threadId)
      && this.interactionObservers.has(threadId) && !this.interactionRefreshThreads.has(threadId);
  }

  /** Native resume subscribes to the SAME loaded core and replays its pending
   * requests. No settings override and no user input are sent. */
  async observeThreadInteractions(threadId: string, observer: NativeInteractionObserver): Promise<void> {
    if (this.options.metadataOnly || this.options.historyOnly) throw new Error("Read-only observers cannot subscribe to interactions");
    const previous = this.interactionObservers.get(threadId);
    if (previous && previous !== observer) await this.unobserveThreadInteractions(threadId);
    this.interactionObservers.set(threadId, observer);
    if (this.interactionSubscriptionReady(threadId)) return;
    await this.ensureConnected();
    this.interactionRefreshThreads.delete(threadId);
    try {
      const result = await this.request("thread/resume", { threadId, excludeTurns: true }, 5_000, true) as { thread?: { id?: string } };
      if (result.thread?.id !== threadId) throw new Error("Native interaction subscription identity mismatch");
      if (this.interactionObservers.get(threadId) !== observer) return;
      this.subscribedThreads.add(threadId);
      const state = await this.inspectThread(threadId);
      if (state.runtimeStatus === "active" && state.activeTurnId) {
        this.activeTurns.set(threadId, state.activeTurnId);
        const page = nativePage(await this.request("thread/turns/list", { threadId, limit: 1, itemsView: "summary", sortDirection: "desc" }, 5_000), "thread/turns/list");
        const turn = page.data.filter(isRecord).find(t => t.id === state.activeTurnId && t.status === "inProgress");
        if (!turn || !Array.isArray(turn.items) || turn.items.some(item => !isRecord(item) || typeof item.id !== "string" || typeof item.type !== "string"))
          throw new Error("Native interaction snapshot must contain the active turn and an items array");
        if (this.interactionObservers.get(threadId) === observer)
          this.asyncQuestions.observe(threadId, state.activeTurnId, turn.items, observer, true);
      }
      // Resume replays requests, but a lost initial replay can otherwise mark a
      // waiting-approval thread subscribed forever without its human prompt.
      if (state.activeFlags.includes("waitingOnApproval") && ![...this.approvalRequests.values()].some(pending =>
        pending.request.threadId === threadId && pending.observer === observer)) this.interactionRefreshThreads.add(threadId);
    } catch (error) { this.interactionRefreshThreads.add(threadId); throw error; }
  }

  async unobserveThreadInteractions(threadId: string): Promise<void> {
    const observer = this.interactionObservers.get(threadId);
    this.interactionObservers.delete(threadId); this.interactionRefreshThreads.delete(threadId);
    this.asyncQuestions.end(threadId);
    for (const [key, request] of this.approvalRequests) if (request.observer === observer && request.request.threadId === threadId)
      this.resolveApproval(key, request.submitted ? "failed" : "withdrawn");
    for (const [key, request] of this.userInputRequests) if (request.observer === observer && request.request.threadId === threadId)
      this.resolveUserInput(key, request.submitted ? "failed" : "withdrawn");
    if (!this.expectedTurnThreads.has(threadId) && ![...this.nativeQueueOrigins.values()].some(o => o.threadId === threadId)
      && this.subscribedThreads.has(threadId)) await this.unsubscribeThread(threadId);
  }

  detachIndependentObservations(): void {
    if (this.executionLifetime !== "independent" || this.hasRestartBlockingWork()) return;
    this.failTransport(new CodexCommunicationError("observation", "turn/observe"), true);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const child = this.child;
    this.closed = true;
    const stopped = Promise.all([child ? waitForProcessExit(child) : Promise.resolve(), this.retiringTransport]).then(() => {});
    this.failTransport(new Error("Codex app-server runner closed"), true);
    this.closePromise = stopped;
    return stopped;
  }

  private async ensureConnected(): Promise<void> {
    while (this.retiringTransport) await this.retiringTransport;
    if (this.closed) {
      throw new Error("Codex app-server runner is closed");
    }
    if (this.initialized && this.child?.exitCode === null && !this.child.stdin.destroyed) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.startAppServer().finally(() => {
        this.connectPromise = undefined;
      });
    }
    await this.connectPromise;
  }

  private async startAppServer(): Promise<void> {
    await this.options.transport?.prepare?.();
    if (this.closed) throw new Error("Codex app-server runner closed during initialization");
    const localCommand = resolveCodexCommand(this.options.codexBin ?? "codex");
    const command = this.options.transport?.command ?? localCommand.command;
    const args = this.options.transport?.args
      ?? [...localCommand.argsPrefix, "app-server", "--stdio"];
    const child = spawn(command, [...args], {
      ...(this.options.codexHome && this.options.transport?.mode !== "remote-daemon"
        ? { env: { ...process.env, CODEX_HOME: this.options.codexHome } } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
    this.child = child;
    this.observedApprovalIds.clear();
    this.stderr = "";
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => { if (this.child === child) this.handleMessage(line); });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-20_000);
    });
    child.once("error", (error) => this.handleChildFailure(child, error));
    child.stdin.on("error", error => {
      // A relay can close its read pipe before the process exits. Stream errors
      // are asynchronous, so send()'s try/catch cannot handle EPIPE. Retire only
      // this client process; an independent native core keeps its own lifetime.
      if (this.child === child) this.failTransport(error, true);
    });
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      const suffix = detail ? `: ${detail}` : "";
      this.handleChildFailure(
        child,
        new Error(
          `Codex app-server${this.options.transport?.label ? ` (${this.options.transport.label})` : ""} ` +
          `exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${suffix}`
        )
      );
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: this.options.metadataOnly ? "codex-im-gateway-metadata" : this.options.historyOnly ? "codex-im-gateway-history" : "codex-im-gateway",
          title: "Codex IM Gateway",
          version: "0.4.0"
        },
        capabilities: {
          experimentalApi: true,
          mcpServerOpenaiFormElicitation: true,
          requestAttestation: false
        }
      }, Math.min(Math.max(this.options.requestTimeoutMs ?? 600_000, 5_000), 60_000));
      this.notify("initialized", {});
      this.initialized = true;
    } catch (error) {
      this.failTransport(error instanceof Error ? error : new Error(String(error)), true);
      throw error;
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs ?? 600_000,
    readOnly = false
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`app-server request ${method} timed out after ${timeoutMs}ms`);
        this.pending.delete(id);
        const submitting = ["turn/start", "turn/steer", "thread/queue/start", "thread/queue/add", "thread/settings/update"].includes(method);
        const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
        if (["turn/start", "thread/queue/start"].includes(method) && threadId) this.unconfirmedStarts.add(threadId);
        reject(communicationError(error, { phase: submitting ? "submission" : "preflight", operation: method, threadId }));
        // One missing RPC receipt is not a broken transport or a failed task.
        // Keep the connection alive for late execution/approval notifications.
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer, readOnly });
      try {
        this.send({ id, method, params });
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        clearTimeout(timer);
        this.pending.delete(id);
        reject(communicationError(normalizedError, { phase: "preflight", operation: method,
          threadId: typeof params.threadId === "string" ? params.threadId : undefined }));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: WireMessage): void {
    if (this.options.metadataOnly && (!message.method || !["initialize", "initialized", "thread/read", "thread/list", "project/list", "config/read"].includes(message.method)
      || message.method === "thread/read" && message.params?.includeTurns !== false)) {
      throw new Error("Metadata-only connection cannot submit task controls or approval decisions");
    }
    if (this.options.historyOnly && (!message.method
      || !["initialize", "initialized", "thread/read", "thread/list", "thread/turns/list"].includes(message.method)
      || message.method === "thread/read" && message.params?.includeTurns !== false
      || message.method === "thread/turns/list" && (!["summary", "full"].includes(String(message.params?.itemsView))
        || typeof message.params?.limit !== "number" || message.params.limit < 1 || message.params.limit > 100))) {
      throw new Error("History-only connection cannot submit task controls, approval decisions or unbounded history hydration");
    }
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed) {
      throw new Error("Codex app-server stdio transport is not connected");
    }
    const child = this.child, response = message.method === undefined ? {} : undefined;
    if (response) this.responseWrites.add(response);
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, error => {
        if (response) this.responseWrites.delete(response);
        if (error && this.child === child) this.failTransport(error, true);
      });
    } catch (error) {
      if (response) this.responseWrites.delete(response);
      throw error;
    }
  }

  private handleMessage(raw: string): void {
    let message: WireMessage;
    try {
      message = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }
    if (!isRecord(message) || message.method !== undefined && typeof message.method !== "string"
      || message.params !== undefined && !isRecord(message.params)) return;

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.handleNotification(message.method, message.params ?? {}, raw);
      return;
    }
    if (message.id === undefined) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const code = typeof message.error.code === "number" && Number.isSafeInteger(message.error.code) ? message.error.code : undefined;
      pending.reject(new CodexNativeRequestError(pending.method, code, message.error.message ?? "unknown error"));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>, raw: string): void {
    if (method === "thread/settings/updated" && typeof params.threadId === "string" && isRecord(params.threadSettings)) {
      const settings = runtimeInfoFromThreadResponse(params.threadSettings);
      this.runtimeInfoByThread.set(params.threadId, settings);
      for (const observer of this.settingsObservers.get(params.threadId) ?? []) observer(settings);
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn;
      // A malformed terminal event is not evidence of success, failure, or
      // withdrawal. Keep the accepted identity and pending interactions until
      // a valid terminal event (or native reconciliation) establishes the result.
      if (!isRecord(turn) || typeof turn.status !== "string" || !["completed", "failed", "interrupted"].includes(turn.status)) {
        if (typeof params.threadId === "string" && isRecord(turn) && typeof turn.id === "string") {
          this.emitProgress(turnKey(params.threadId, turn.id), "收到的任务结束状态尚未确认，正在等待原生状态同步。");
        }
        return;
      }
    }
    const observer = typeof params.threadId === "string" ? this.interactionObservers.get(params.threadId) : undefined;
    if (observer && typeof params.turnId === "string" && this.activeTurns.get(String(params.threadId)) === params.turnId
      && ["item/started", "item/completed"].includes(method)
      && params.item && typeof params.item === "object") this.asyncQuestions.observe(String(params.threadId), params.turnId, [params.item], observer);
    if (method === "turn/completed" && typeof params.threadId === "string") {
      const turn = params.turn as { id?: string } | undefined;
      if (turn?.id) this.asyncQuestions.end(params.threadId, turn.id);
    }
    if (method === "item/autoApprovalReview/started" || method === "item/autoApprovalReview/completed") {
      const { threadId, turnId } = params;
      if (this.options.metadataOnly || this.options.historyOnly || typeof threadId !== "string" || typeof turnId !== "string"
        || this.activeTurns.get(threadId) !== turnId) return;
      const key = turnKey(threadId, turnId);
      if (!this.turnStreams.has(key) && !this.expectedTurnThreads.has(threadId) && !this.interactionObservers.has(threadId)) return;
      const progress = automaticApprovalProgress(method, params);
      if (progress) this.emitProgress(key, progress);
      return;
    }
    if (method === "error") {
      const { threadId, turnId } = params;
      // Error notifications are not completion events. Only the native active
      // identity can update a card; a late/foreign error cannot resurrect it.
      if (typeof threadId !== "string" || typeof turnId !== "string"
        || this.activeTurns.get(threadId) !== turnId || typeof params.willRetry !== "boolean") return;
      const key = turnKey(threadId, turnId);
      const recovery: CodexTurnRecovery = { threadId, turnId, code: codexFailureCode(params.error), willRetry: params.willRetry };
      const previous = this.turnRecoveries.get(key);
      this.turnRecoveries.set(key, recovery);
      this.turnErrorCodes.set(key, recovery.code);
      const state = this.threadStates.get(threadId);
      if (state) this.threadStates.set(threadId, { ...state, recovery });
      if (previous?.code === recovery.code && previous.willRetry === recovery.willRetry) return;
      const event: QueuedTurnEvent = { type: "recovery", recovery };
      if (this.turnStreams.has(key)) this.enqueueTurnEvent(key, event);
      else this.queueTurnEvent(key, event);
      return;
    }
    if (method === "serverRequest/resolved") {
      const key = JSON.stringify([params.threadId, typeof params.requestId, params.requestId]);
      const approval = this.approvalRequests.get(key);
      if (approval) this.resolveApproval(key, approval.submitted ? "confirmed" : "withdrawn");
      const pending = this.userInputRequests.get(key);
      if (pending) this.resolveUserInput(key, pending.submitted ? "confirmed" : "withdrawn");
      return;
    }
    if (method === "turn/started") {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const turn = params.turn as { id?: string } | undefined;
      if (threadId && turn?.id) {
        for (const [key, pending] of this.userInputRequests) if (pending.request.threadId === threadId && pending.request.turnId !== turn.id) this.resolveUserInput(key, "withdrawn");
        this.activeTurns.set(threadId, turn.id);
        this.unconfirmedStarts.delete(threadId);
      }
    }
    if (method === "thread/status/changed") {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (threadId) {
        const previous = this.threadStates.get(threadId);
        this.threadStates.set(threadId, {
          threadId,
          persistence: previous?.persistence ?? "active",
          ...parseRuntimeStatus(params.status),
          ...(previous?.latestTurnStatus ? { latestTurnStatus: previous.latestTurnStatus } : {}),
          ...(previous?.activeTurnId ? { activeTurnId: previous.activeTurnId } : {}),
          ...(previous?.recovery ? { recovery: previous.recovery } : {}),
          ...(previous?.cwd ? { cwd: previous.cwd } : {}),
          ...(previous?.projectId ? { projectId: previous.projectId } : {}),
          ...(previous?.title ? { title: previous.title } : {}),
          ...(previous?.preview ? { preview: previous.preview } : {}),
          ...(previous?.updatedAt ? { updatedAt: previous.updatedAt } : {})
        });
      }
      return;
    }

    if (["thread/archived", "thread/unarchived", "thread/deleted", "thread/closed"].includes(method)) {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (threadId) {
        const previous = this.threadStates.get(threadId);
        const persistence: CodexThreadPersistence = method === "thread/archived"
          ? "archived"
          : method === "thread/deleted"
            ? "missing"
            : previous?.persistence === "ephemeral"
              ? "ephemeral"
              : "active";
        this.threadStates.set(threadId, {
          threadId,
          persistence,
          runtimeStatus: "notLoaded",
          activeFlags: [],
          ...(previous?.cwd ? { cwd: previous.cwd } : {}),
          ...(previous?.projectId ? { projectId: previous.projectId } : {}),
          ...(previous?.title ? { title: previous.title } : {}),
          ...(previous?.preview ? { preview: previous.preview } : {}),
          ...(previous?.updatedAt ? { updatedAt: previous.updatedAt } : {})
        });
      }
      return;
    }

    if (method === "item/started") {
      const key = turnKeyFromParams(params);
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "userMessage" && typeof item.clientId === "string" && key) {
        const origin = this.nativeQueueOrigins.get(item.clientId);
        if (origin) {
          const turnId = String(params.turnId), threadId = String(params.threadId);
          this.nativeTurnClients.set(key, item.clientId);
          this.activeTurns.set(threadId, turnId);
          if (origin.onApproval) this.approvalHandlersByThread.set(threadId, origin.onApproval);
          this.bindUserInputHandlers(threadId, origin);
          void Promise.resolve().then(() => origin.onAccepted?.(turnId)).catch(() => {
            console.warn("[codex-im-gateway] native turn acknowledgement callback failed; no input replayed");
          });
        }
      }
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      if (key && itemId && item?.type === "agentMessage" && typeof item.phase === "string") {
        const phases = this.itemPhasesByTurn.get(key) ?? new Map<string, string>();
        phases.set(itemId, item.phase);
        this.itemPhasesByTurn.set(key, phases);
      }
      if (key) this.emitPublicItem(key, item, false);
      const progress = describeItemProgress(item, false);
      if (key && progress) this.emitProgress(key, progress);
      return;
    }

    if (method === "item/reasoning/summaryTextDelta") {
      const key = turnKeyFromParams(params);
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!key || !itemId || !delta) return;
      const summaries = this.reasoningSummariesByTurn.get(key) ?? new Map<string, string>();
      // Native summaries have independent parts. Concatenating the tail of
      // one Markdown heading with the next produced "coverage**Fetching...".
      const partId = `${itemId}:${typeof params.summaryIndex === "number" ? params.summaryIndex : 0}`;
      const summary = `${summaries.get(partId) ?? ""}${delta}`;
      summaries.set(partId, summary);
      this.reasoningSummariesByTurn.set(key, summaries);
      if (summary.trim()) this.emitProgress(key, `🤔 ${boundedText(summary, 600)}`);
      return;
    }

    if (method === "item/agentMessage/delta") {
      const key = turnKeyFromParams(params);
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!key || !itemId || !delta || this.itemPhasesByTurn.get(key)?.get(itemId) === "commentary") {
        return;
      }
      this.clearTurnRecovery(key);
      if (this.turnStreams.has(key)) {
        this.enqueueTurnEvent(key, { type: "delta", text: delta });
      } else {
        this.queueTurnEvent(key, { type: "delta", text: delta });
      }
      return;
    }

    if (method === "item/completed") {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
      if (!threadId || !turnId) {
        return;
      }
      const key = turnKey(threadId, turnId);
      this.appendTurnEvent(key, raw);
      const item = params.item as Record<string, unknown> | undefined;
      this.emitPublicItem(key, item, true);
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "commentary") {
          const progress = item.text.trim();
          if (progress) {
            this.emitProgress(key, progress);
          }
        } else {
          this.clearTurnRecovery(key);
          this.turnTexts.set(key, item.text);
        }
      } else {
        const progress = describeItemProgress(item, true);
        if (progress) this.emitProgress(key, progress);
      }
      return;
    }

    if (method !== "turn/completed") {
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turn = params.turn as Record<string, unknown> | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : undefined;
    if (!threadId || !turnId) {
      return;
    }
    const cachedState = this.threadStates.get(threadId);
    const currentTurn = this.activeTurns.get(threadId)
      ?? (cachedState?.runtimeStatus === "active" ? cachedState.activeTurnId : undefined);
    const expectedCompletion = this.expectedTurnThreads.has(threadId) || this.unconfirmedStarts.has(threadId)
      || [...this.nativeQueueOrigins.values()].some(origin => origin.threadId === threadId)
      || this.turnStreams.has(turnKey(threadId, turnId));
    const ownsThreadState = !currentTurn || currentTurn === turnId;
    if (ownsThreadState) this.unconfirmedStarts.delete(threadId);
    for (const [key, pending] of this.userInputRequests) if (pending.request.threadId === threadId
      && pending.request.turnId === turnId) this.resolveUserInput(key, pending.submitted ? "failed" : "withdrawn");
    const key = turnKey(threadId, turnId);
    this.appendTurnEvent(key, raw);
    const status = turn!.status as string; // Validated before changing any task or interaction state.
    const errorValue = turn?.error as Record<string, unknown> | undefined;
    const completion: TurnCompletion = {
      status,
      text: this.turnTexts.get(key) ?? extractAgentMessageFromTurn(turn),
      raw: this.turnEvents.get(key)?.text() ?? "",
      failureCode: status === "failed" ? errorValue ? codexFailureCode(errorValue) : this.turnErrorCodes.get(key) ?? "upstream-error" : undefined,
      error: typeof errorValue?.message === "string" ? errorValue.message : undefined
    };
    this.turnRecoveries.delete(key);
    this.turnErrorCodes.delete(key);
    if (this.activeTurns.get(threadId) === turnId) this.activeTurns.delete(threadId);
    const nativeClientId = this.nativeTurnClients.get(key);
    if (nativeClientId) { this.nativeQueueOrigins.delete(nativeClientId); this.nativeTurnClients.delete(key); }
    const previousState = this.threadStates.get(threadId);
    if (ownsThreadState) {
      this.threadStates.set(threadId, {
        threadId,
        persistence: previousState?.persistence ?? "active",
        runtimeStatus: status === "failed" && previousState?.runtimeStatus === "systemError" ? "systemError" : "idle",
        activeFlags: [],
        ...(normalizeTurnStatus(status) ? { latestTurnStatus: normalizeTurnStatus(status) } : {}),
        ...(status === "failed" ? { lastTurnFailure: { turnId, code: completion.failureCode! } } : {}),
        ...(previousState?.cwd ? { cwd: previousState.cwd } : {}),
        ...(previousState?.projectId ? { projectId: previousState.projectId } : {}),
        ...(previousState?.title ? { title: previousState.title } : {}),
        ...(previousState?.preview ? { preview: previousState.preview } : {})
      });
      this.itemHandlersByThread.delete(threadId);
      this.approvalHandlersByThread.delete(threadId);
      this.approvalResults.delete(threadId);
      this.dynamicToolHandlersByThread.delete(threadId);
      this.userInputHandlersByThread.delete(threadId);
      this.userInputResultHandlersByThread.delete(threadId);
    }
    for (const [approvalKey, pending] of this.approvalRequests) {
      if (pending.request.threadId === threadId && (pending.request.turnId === turnId
        || ownsThreadState && pending.request.turnId === undefined))
        this.resolveApproval(approvalKey, pending.submitted ? "failed" : "withdrawn");
    }
    const waiter = this.turnWaiters.get(key);
    if (!waiter) {
      // Completion may precede a local start acknowledgement. Retain that
      // race, but do not keep every unrelated daemon turn's payload forever.
      if (expectedCompletion) this.completedTurns.set(key, completion);
      else this.clearTurnPayload(key);
      return;
    }
    this.turnWaiters.delete(key);
    void this.finishTurn(threadId, key, completion, waiter.resolve, waiter.reject);
  }

  private releaseExpectedTurnThread(threadId: string): void {
    const count = this.expectedTurnThreads.get(threadId) ?? 0;
    if (count > 1) this.expectedTurnThreads.set(threadId, count - 1);
    else this.expectedTurnThreads.delete(threadId);
  }

  private waitForTurn(threadId: string, turnId: string): Promise<CodexRunResult> {
    const key = turnKey(threadId, turnId);
    const completed = this.completedTurns.get(key);
    if (completed) {
      this.completedTurns.delete(key);
      return new Promise((resolve, reject) => {
        void this.finishTurn(threadId, key, completed, resolve, reject);
      });
    }

    return new Promise((resolve, reject) => {
      // A turn is an agent job, not a request/response RPC. Once app-server
      // accepts it, let it run until Codex completes it, the user interrupts
      // it, or the underlying transport actually disconnects.
      this.turnWaiters.set(key, { resolve, reject });
    });
  }

  private async finishTurn(
    threadId: string,
    key: string,
    completion: TurnCompletion,
    resolve: (value: CodexRunResult) => void,
    reject: (error: Error) => void
  ): Promise<void> {
    const turnId = key.slice(threadId.length + 1);
    // Completion can beat the start acknowledgement on the JSONL transport.
    if (this.activeTurns.get(threadId) === turnId) this.activeTurns.delete(threadId);
    const stream = this.turnStreams.get(key);
    this.turnStreams.delete(key);
    await stream?.chain;
    this.clearTurnPayload(key);
    if (completion.status === "completed") {
      resolve({ text: completion.text, threadId, turnId: key.slice(threadId.length + 1), raw: completion.raw });
      return;
    }
    if (completion.status === "interrupted") {
      reject(new CodexTurnExecutionError("interrupted", "Codex app-server turn was interrupted"));
      return;
    }
    reject(new CodexTurnExecutionError("failed", completion.error ?? `Codex app-server turn ended with status ${completion.status}`, completion.failureCode));
  }

  private appendTurnEvent(key: string, raw: string): void {
    const events = this.turnEvents.get(key) ?? new DiagnosticTail();
    events.append(raw + "\n");
    this.turnEvents.set(key, events);
  }

  private clearTurnPayload(key: string): void {
    this.completedTurns.delete(key);
    this.turnEvents.delete(key);
    this.turnTexts.delete(key);
    this.queuedTurnEvents.delete(key);
    this.itemPhasesByTurn.delete(key);
    this.reasoningSummariesByTurn.delete(key);
  }

  private queueTurnEvent(key: string, event: QueuedTurnEvent): void {
    const [threadId, turnId] = key.split("\u0000");
    const interested = this.expectedTurnThreads.has(threadId) || this.unconfirmedStarts.has(threadId)
      || [...this.nativeQueueOrigins.values()].some(origin => origin.threadId === threadId);
    if (!interested) {
      const observer = this.interactionObservers.get(threadId);
      const text = event.type === "progress" ? event.text : event.type === "recovery" ? codexRecoverySummary(event.recovery) : undefined;
      if (observer?.onProgress && text && this.activeTurns.get(threadId) === turnId) void Promise.resolve().then(() =>
        observer.onProgress?.({ hostId: this.options.hostId ?? "local", threadId, turnId }, text)).catch(() => {});
      return;
    }
    const queued = this.queuedTurnEvents.get(key) ?? [];
    queued.push(event);
    this.queuedTurnEvents.set(key, queued);
  }

  private emitPublicItem(key: string, item: unknown, completed: boolean): void {
    const threadId = key.slice(0, key.indexOf("\u0000"));
    if (!this.turnStreams.get(key)?.onItem && !this.itemHandlersByThread.has(threadId)) return;
    const activity = nativePublicActivity(item, completed);
    if (!activity) return;
    const event: QueuedTurnEvent = { type: "item", activity };
    if (this.turnStreams.has(key)) this.enqueueTurnEvent(key, event);
    else this.queueTurnEvent(key, event);
  }

  private emitProgress(key: string, text: string): void {
    this.clearTurnRecovery(key);
    if (this.turnStreams.has(key)) {
      this.enqueueTurnEvent(key, { type: "progress", text });
    } else {
      this.queueTurnEvent(key, { type: "progress", text });
    }
  }

  private enqueueTurnEvent(key: string, event: QueuedTurnEvent): void {
    const stream = this.turnStreams.get(key);
    if (!stream) return;
    stream.chain = stream.chain
      .then(() => event.type === "item" ? stream.onItem?.(event.activity) : event.type === "recovery"
        ? stream.onRecovery ? stream.onRecovery(event.recovery) : stream.onProgress?.(codexRecoverySummary(event.recovery))
        : event.type === "progress" ? stream.onProgress?.(event.text) : stream.onDelta?.(event.text))
      .then(() => undefined)
      .catch((error) => {
        console.warn(`Codex ${event.type} callback failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private clearTurnRecovery(key: string): void {
    this.turnRecoveries.delete(key);
    const threadId = key.slice(0, key.indexOf("\u0000"));
    const state = this.threadStates.get(threadId);
    if (state?.recovery && turnKey(threadId, state.recovery.turnId) === key) {
      this.threadStates.set(threadId, { ...state, recovery: undefined });
    }
  }

  private handleServerRequest(message: WireMessage): void {
    // Requests observed from a shared native owner remain its responsibility.
    // A read-only client must not even decline somebody else's approval.
    if (this.options.metadataOnly || this.options.historyOnly) return;
    const id = message.id as JsonRpcId;
    if (isAppServerApprovalMethod(message.method)) {
      const method = message.method;
      const params = message.params ?? {};
      const threadId = typeof params.threadId === "string" ? params.threadId : "";
      const scoped = method === "mcpServer/elicitation/request"
        ? { ...params, turnId: params.turnId ?? this.activeTurns.get(threadId) ?? `mcp-thread-scope:${typeof id}:${id}` } : params;
      const form = method === "mcpServer/elicitation/request" ? parseMcpForm(scoped) : undefined;
      if (form) { this.handleUserInputRequest(id, {}, form); return; }
      const request = parseAppServerApproval(method, scoped);
      const observer = this.interactionObservers.get(threadId);
      const envelope: NativeApproval | undefined = request ? { hostId: this.options.hostId ?? "local", requestId: id, method, request } : undefined;
      const activeHandler = request ? this.approvalHandlersByThread.get(request.threadId) : undefined;
      const handler = activeHandler ?? (envelope && observer ? () => observer.onApproval(envelope) : undefined);
      if (!request || !handler) {
        if (method === "mcpServer/elicitation/request") {
          const turnId = typeof scoped.turnId === "string" ? scoped.turnId : this.activeTurns.get(threadId);
          const url = safeElicitationUrl(params);
          if (threadId && turnId) this.emitProgress(turnKey(threadId, turnId), url
            ? `当前工具需要在浏览器完成验证：${url}。打开页面不等于已批准或完成验证。`
            : "当前工具有尚未适配或需要安全认证的交互，未自动批准、未收集密码或验证码。请求保持待处理，请从原工具提供的安全页面处理。");
          if (observer && turnId) void Promise.resolve().then(() => observer.onUnsupportedInteraction?.({
            hostId: this.options.hostId ?? "local", threadId, turnId, requestId: id, method,
            reason: url ? "authentication" : "schema-unsupported", ...(url ? { safeUrl: url } : {})
          })).catch(() => {});
          console.warn("[codex-im-gateway] MCP interaction unsupported; native request retained, no payload logged");
          return;
        }
        // A shared core broadcasts to multiple clients. Missing local context
        // never authorizes declining another client's native interaction.
        if (observer && typeof params.turnId === "string") {
          const turnId = params.turnId;
          void Promise.resolve().then(() => observer.onUnsupportedInteraction?.({
            hostId: this.options.hostId ?? "local", threadId, turnId, requestId: id, method, reason: "schema-unsupported"
          })).catch(() => {});
        }
        return;
      }
      const key = JSON.stringify([request.threadId, typeof id, id]);
      if (this.approvalRequests.has(key) || this.observedApprovalIds.has(key)) return;
      this.observedApprovalIds.add(key);
      while (this.observedApprovalIds.size > 2000) this.observedApprovalIds.delete(this.observedApprovalIds.values().next().value!);
      const owner = this.child;
      request.hostId = this.options.hostId ?? "local";
      request.nativeKey = JSON.stringify(["app-server", owner?.pid, request.hostId, method, key]);
      const pending = { request, submitted: false, observer: activeHandler ? undefined : observer,
        notify: activeHandler ? this.approvalResults.get(request.threadId) : (envelope && observer
          ? (_request: CodexApprovalRequest, result: import("./approval.js").CodexApprovalResult) => observer.onResult?.(envelope, result) : undefined) };
      this.approvalRequests.set(key, pending);
      Promise.resolve().then(() => this.child === owner && this.approvalRequests.get(key) === pending ? handler(request) : undefined)
        .then((decision) => {
          if (this.child !== owner || this.approvalRequests.get(key) !== pending) return;
          if (decision === undefined) {
            this.approvalRequests.delete(key); this.observedApprovalIds.delete(key);
            // A retired origin must not shadow the independent observer on replay.
            if (activeHandler && this.approvalHandlersByThread.get(threadId) === activeHandler) this.approvalHandlersByThread.delete(threadId);
            this.interactionRefreshThreads.add(request.threadId); return;
          }
          if (pending.observer && this.interactionObservers.get(threadId) !== pending.observer) {
            this.resolveApproval(key, "withdrawn"); return;
          }
          pending.submitted = true;
          this.send({ id, result: appServerApprovalResult(method, request, decision) });
        })
        .catch((error) => {
          this.resolveApproval(key, "failed");
          this.observedApprovalIds.delete(key); this.interactionRefreshThreads.add(threadId);
          console.warn("[codex-im-gateway] approval route unavailable; native request retained without a synthetic decision");
        });
      return;
    }
    switch (message.method) {
      case "execCommandApproval":
      case "applyPatchApproval":
        return;
      case "item/tool/requestUserInput":
        this.handleUserInputRequest(id, message.params ?? {});
        return;
      case "item/tool/call":
        this.handleDynamicToolRequest(id, message.params ?? {});
        return;
      case "currentTime/read":
        this.send({ id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } });
        return;
      default:
        if (typeof message.params?.threadId !== "string" || !this.expectedTurnThreads.has(message.params.threadId)) return;
        if (typeof message.params?.threadId === "string") {
          const turnId = this.activeTurns.get(message.params.threadId);
          if (turnId) this.emitProgress(turnKey(message.params.threadId, turnId), "当前任务遇到未支持的原生交互；已记录脱敏诊断，未代答或批准。");
        }
        this.send({
          id,
          error: { code: -32601, message: `Unsupported app-server request: ${message.method ?? "unknown"}` }
        });
    }
  }

  private handleDynamicToolRequest(id: JsonRpcId, params: Record<string, unknown>): void {
    const owner = this.child;
    const call = parseDynamicToolCall(params);
    const handler = call ? this.dynamicToolHandlersByThread.get(call.threadId) : undefined;
    if (!call || !handler) {
      if (!call || !this.expectedTurnThreads.has(call.threadId)) return;
      this.send({
        id,
        result: {
          contentItems: [{ type: "inputText", text: "当前会话没有启用该动态工具。" }],
          success: false
        }
      });
      return;
    }
    const respond = (text: string, success: boolean) => {
      if (this.child !== owner) return;
      try { this.send({ id, result: { contentItems: [{ type: "inputText", text }], success } }); }
      catch { console.warn("[codex-im-gateway] dynamic tool response transport unavailable; response not replayed"); }
    };
    Promise.resolve().then(() => this.child === owner ? handler(call) : undefined)
      .then(text => { if (text !== undefined) respond(text, true); },
        error => respond(error instanceof Error ? error.message : String(error), false));
  }

  private handleUserInputRequest(id: JsonRpcId, params: Record<string, unknown>, form?: McpForm): void {
    const parsed = form?.request ?? parseUserInputRequest(params);
    const request = parsed ? { ...parsed, requestId: id } : undefined;
    const observer = this.interactionObservers.get(request?.threadId ?? String(params.threadId ?? ""));
    const envelope: NativeUserInput | undefined = request ? { hostId: this.options.hostId ?? "local", requestId: id,
      method: "item/tool/requestUserInput", request, ...(form ? { mcpForm: form } : {}) } : undefined;
    const activeHandler = request ? this.userInputHandlersByThread.get(request.threadId) : undefined;
    const handler = activeHandler ?? (envelope && observer?.onUserInput ? () => observer.onUserInput!(envelope) : undefined);
    if (!request || !handler) {
      if (observer && typeof params.turnId === "string") {
        const turnId = params.turnId;
        void Promise.resolve().then(() => observer.onUnsupportedInteraction?.({
          hostId: this.options.hostId ?? "local", threadId: String(params.threadId), turnId,
          requestId: id, method: "item/tool/requestUserInput", reason: "schema-unsupported"
        })).catch(() => {});
      }
      console.warn("[codex-im-gateway] user-input request has no valid channel handler; left unanswered");
      return;
    }
    const key = JSON.stringify([request.threadId, typeof id, id]);
    if (this.userInputRequests.has(key)) return;
    const pending = { request, submitted: false, observer: activeHandler ? undefined : observer,
      notify: activeHandler ? this.userInputResultHandlersByThread.get(request.threadId)
      : (envelope && observer ? (_request: CodexUserInputRequest, result: CodexUserInputResult) => observer.onUserInputResult?.(envelope, result) : undefined) };
    this.userInputRequests.set(key, pending);
    Promise.resolve().then(() => this.userInputRequests.get(key) === pending ? handler(request) : undefined).then(answers => {
      if (this.userInputRequests.get(key) !== pending) return;
      if (answers === undefined) {
        this.userInputRequests.delete(key);
        if (activeHandler && this.userInputHandlersByThread.get(request.threadId) === activeHandler) this.userInputHandlersByThread.delete(request.threadId);
        this.interactionRefreshThreads.add(request.threadId); return;
      }
      if (pending.observer && this.interactionObservers.get(request.threadId) !== pending.observer) {
        this.resolveUserInput(key, "withdrawn"); return;
      }
      pending.submitted = true;
      this.send({ id, result: form ? mcpFormResponse(form, answers) : { answers } });
    }).catch(() => {
      this.resolveUserInput(key, "failed");
      this.interactionRefreshThreads.add(request.threadId);
    });
  }

  private bindUserInputHandlers(threadId: string, input: Pick<CodexRunnerInput, "onUserInput" | "onUserInputResult" | "onApprovalResult">): void {
    if (input.onApprovalResult) this.approvalResults.set(threadId, input.onApprovalResult);
    if (input.onUserInput) this.userInputHandlersByThread.set(threadId, input.onUserInput);
    if (input.onUserInputResult) this.userInputResultHandlersByThread.set(threadId, input.onUserInputResult);
  }

  private resolveApproval(key: string, result: CodexApprovalResult): void {
    const pending = this.approvalRequests.get(key);
    if (!pending) return;
    this.approvalRequests.delete(key);
    if (!pending.submitted) this.observedApprovalIds.delete(key);
    void Promise.resolve().then(() => pending.notify?.(pending.request, result)).catch(() => {
      console.warn("[codex-im-gateway] approval resolution notice unavailable");
    });
  }

  private resolveUserInput(key: string, result: CodexUserInputResult): void {
    const pending = this.userInputRequests.get(key);
    if (!pending) return;
    this.userInputRequests.delete(key);
    void Promise.resolve().then(() => pending.notify?.(pending.request, result)).catch(() => {
      console.warn("[codex-im-gateway] user-input resolution notice failed");
    });
  }

  private handleChildFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) {
      return;
    }
    this.failTransport(error, false);
  }

  private failTransport(error: Error, kill: boolean): void {
    this.asyncQuestions.disconnect();
    for (const [key, request] of this.approvalRequests) this.resolveApproval(key, request.submitted ? "failed" : "withdrawn");
    this.approvalResults.clear();
    const child = this.child;
    this.child = undefined;
    this.initialized = false;
    this.lines?.close();
    this.lines = undefined;
    if (kill && child?.exitCode === null) {
      child.kill();
    }
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const [key, waiter] of this.turnWaiters.entries()) {
      this.turnWaiters.delete(key);
      waiter.reject(error);
    }
    this.activeTurns.clear();
    this.unconfirmedStarts.clear();
    this.responseWrites.clear();
    this.nativeQueueOrigins.clear();
    this.nativeTurnClients.clear();
    this.subscribedThreads.clear();
    this.observedApprovalIds.clear();
    this.itemHandlersByThread.clear();
    this.approvalHandlersByThread.clear();
    this.dynamicToolHandlersByThread.clear();
    this.userInputHandlersByThread.clear();
    for (const [key, pending] of this.userInputRequests) this.resolveUserInput(key, pending.submitted ? "failed" : "suspended");
    this.userInputResultHandlersByThread.clear();
    this.turnEvents.clear();
    this.turnTexts.clear();
    this.completedTurns.clear();
    this.turnStreams.clear();
    this.queuedTurnEvents.clear();
    this.turnRecoveries.clear();
    this.turnErrorCodes.clear();
    this.itemPhasesByTurn.clear();
    this.reasoningSummariesByTurn.clear();
    this.runtimeInfoByThread.clear();
    this.threadStates.clear();
    this.projectCatalogSupported = undefined;
    this.modelOptions = undefined;
  }
}

function describeItemProgress(item: Record<string, unknown> | undefined, completed: boolean): string | undefined {
  if (!item || typeof item.type !== "string") return undefined;
  const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
  const succeeded = !status || status === "completed" || status === "success" || status === "succeeded";
  const icon = completed ? succeeded ? "✅" : "❌" : "🔎";
  switch (item.type) {
    case "reasoning": {
      if (!completed) return undefined;
      const summary = reasoningSummaryText(item.summary);
      return summary ? `🤔 ${boundedText(summary, 600)}` : undefined;
    }
    case "commandExecution": {
      const command = safeCommandPreview(item.command);
      if (!completed) return `${icon} 正在执行命令${command ? `：${command}` : ""}`;
      const exitCode = typeof item.exitCode === "number" ? `，退出码 ${item.exitCode}` : "";
      const duration = formatDuration(item.durationMs);
      return `${icon} 命令${succeeded ? "完成" : "失败"}${command ? `：${command}` : ""}${exitCode}${duration}`;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.flatMap((value) => {
        if (!isRecord(value)) return [];
        const change = value;
        return typeof change.path === "string" ? [change.path] : [];
      });
      const suffix = paths.length ? `：${paths.slice(0, 3).map(shortPath).join("、")}${paths.length > 3 ? ` 等 ${paths.length} 个文件` : ""}` : "";
      return `${completed ? icon : "✏️"} ${completed ? `文件修改${succeeded ? "完成" : "失败"}` : "正在修改文件"}${suffix}`;
    }
    case "mcpToolCall": {
      const server = typeof item.server === "string" ? item.server : "MCP";
      const tool = typeof item.tool === "string" ? item.tool : "工具";
      return `${completed ? icon : "🔌"} ${completed ? `工具调用${succeeded ? "完成" : "失败"}` : "正在调用工具"}：${boundedText(`${server}/${tool}`, 120)}`;
    }
    case "dynamicToolCall": {
      const tool = typeof item.tool === "string" ? item.tool : "动态工具";
      return `${completed ? icon : "🧩"} ${completed ? `动态工具${succeeded ? "完成" : "失败"}` : "正在调用动态工具"}：${boundedText(tool, 120)}`;
    }
    case "collabToolCall": {
      const tool = typeof item.tool === "string" ? item.tool : "协作任务";
      return `${completed ? icon : "👥"} ${completed ? `协作步骤${succeeded ? "完成" : "失败"}` : "正在执行协作步骤"}：${boundedText(tool, 120)}`;
    }
    case "webSearch": {
      const query = typeof item.query === "string" ? boundedText(item.query, 180) : "";
      return `${completed ? icon : "🌐"} ${completed ? "网页检索完成" : "正在检索网页"}${query ? `：${query}` : ""}`;
    }
    case "imageView": {
      const imagePath = typeof item.path === "string" ? shortPath(item.path) : "";
      return `${completed ? icon : "🖼️"} ${completed ? "图片检查完成" : "正在检查图片"}${imagePath ? `：${imagePath}` : ""}`;
    }
    case "contextCompaction":
      return completed ? "✅ 上下文整理完成" : "🧹 正在整理长会话上下文";
    default:
      return undefined;
  }
}

function reasoningSummaryText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!part || typeof part !== "object") return [];
    const record = part as Record<string, unknown>;
    return typeof record.text === "string" ? [record.text] : [];
  }).join("\n").trim();
}

function safeCommandPreview(value: unknown): string {
  const command = Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string").join(" ")
    : typeof value === "string" ? value : "";
  if (!command) return "";
  // A progress label does not need shell argument fidelity. Redacting a value
  // token-by-token leaks quoted assignments, JSON fields and argv credentials;
  // omit the whole preview when credential syntax is present instead.
  if (sensitiveCommand(command)) return "参数已隐藏（含敏感字段）";
  return `\`${boundedText(command.replace(/\s+/g, " ").trim(), 220).replaceAll("`", "'")}\``;
}

function shortPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return boundedText(parts.slice(-2).join("/") || normalized, 100);
}

function boundedText(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function formatDuration(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  return value < 1_000 ? `，${Math.round(value)}ms` : `，${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function appServerSandboxPolicy(sandbox: CodexExecSandbox | undefined): AppServerSandboxPolicy | undefined {
  switch (sandbox) {
    case undefined:
      return undefined;
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { type: "workspaceWrite" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
  }
}

function parseDynamicToolCall(params: Record<string, unknown>): CodexDynamicToolCall | undefined {
  if (
    typeof params.callId !== "string"
    || typeof params.threadId !== "string"
    || typeof params.turnId !== "string"
    || typeof params.tool !== "string"
  ) {
    return undefined;
  }
  return {
    callId: params.callId,
    threadId: params.threadId,
    turnId: params.turnId,
    tool: params.tool,
    arguments: params.arguments,
    ...(typeof params.namespace === "string" ? { namespace: params.namespace } : {})
  };
}


function parseThreadGoal(value: unknown): CodexThreadGoal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const goal = value as Record<string, unknown>;
  if (
    typeof goal.threadId !== "string"
    || typeof goal.objective !== "string"
    || !isGoalStatus(goal.status)
    || typeof goal.tokensUsed !== "number"
    || typeof goal.timeUsedSeconds !== "number"
    || typeof goal.createdAt !== "number"
    || typeof goal.updatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(typeof goal.tokenBudget === "number" ? { tokenBudget: goal.tokenBudget } : {})
  };
}

function isGoalStatus(value: unknown): value is CodexThreadGoalStatus {
  return value === "active"
    || value === "paused"
    || value === "blocked"
    || value === "usageLimited"
    || value === "budgetLimited"
    || value === "complete";
}

function bindThreadHandler<T>(handlers: Map<string, T>, threadId: string, current: T | undefined): () => void {
  if (current === undefined) return () => {};
  const previous = handlers.get(threadId);
  handlers.set(threadId, current);
  return () => {
    if (handlers.get(threadId) !== current) return;
    if (previous === undefined) handlers.delete(threadId); else handlers.set(threadId, previous);
  };
}

function isThreadBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already.*(active|running)|turn.*(active|in progress|running)|thread.*busy/i.test(message);
}

function isUnsupportedProjectCatalogError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /project\/list/i.test(message)
    && /unknown variant|unknown method|method not found|unsupported|not implemented|expected one of/i.test(message);
}

function turnKeyFromParams(params: Record<string, unknown>): string | undefined {
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
  return threadId && turnId ? turnKey(threadId, turnId) : undefined;
}

type AppServerProject = {
  id: string;
  name: string;
  roots: string[];
};

function parseAppServerProject(value: unknown): AppServerProject | undefined {
  const project = value as Record<string, unknown> | undefined;
  if (!project || typeof project.id !== "string" || !project.id) return undefined;
  const roots = Array.isArray(project.roots)
    ? project.roots.flatMap((value) => {
      if (!isRecord(value)) return [];
      const root = value;
      return typeof root.path === "string" && root.path ? [root.path] : [];
    })
    : [];
  return {
    id: project.id,
    name: typeof project.name === "string" ? project.name : project.id,
    roots
  };
}

function cleanThreadTitle(value?: string): string | undefined {
  const title = value?.replace(/\s+/g, " ").trim();
  if (!title) return undefined;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

function shouldRepairBridgeThreadName(value?: string): boolean {
  if (!value?.trim()) return true;
  return /^(?:WeChat|Codex channel) bridge rule:|^\[codex-(?:weixin|channel-bridge)-private-knowledge]/i.test(value.trim());
}

function parseModelOption(value: unknown): CodexModelOption | undefined {
  if (!isRecord(value)) return undefined;
  const model = value as Record<string, unknown>;
  const modelId = typeof model.model === "string" && model.model
    ? model.model
    : typeof model.id === "string" ? model.id : "";
  if (!modelId || model.hidden === true) return undefined;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((value) => {
      if (!isRecord(value)) return [];
      const effort = value;
      return typeof effort.reasoningEffort === "string" && effort.reasoningEffort
        ? [{
          effort: effort.reasoningEffort,
          description: typeof effort.description === "string" ? effort.description : ""
        }]
        : [];
    })
    : [];
  return {
    model: modelId,
    displayName: typeof model.displayName === "string" && model.displayName ? model.displayName : modelId,
    description: typeof model.description === "string" ? model.description : "",
    isDefault: model.isDefault === true,
    ...(Array.isArray(model.serviceTiers) ? { serviceTiers: model.serviceTiers.flatMap(value => isRecord(value)
      && typeof value.id === "string" && typeof value.name === "string" ? [{ id: value.id, name: value.name }] : []) } : {}),
    ...(typeof model.defaultReasoningEffort === "string" && model.defaultReasoningEffort
      ? { defaultEffort: model.defaultReasoningEffort }
      : {}),
    supportedEfforts: efforts
  };
}

function runtimeInfoFromThreadResponse(response: Record<string, unknown>): CodexRuntimeInfo {
  return compactRuntimeInfo({
    model: response.model,
    effort: response.reasoningEffort ?? response.effort,
    provider: response.modelProvider ?? response.model_provider,
    collaborationMode: isRecord(response.collaborationMode) ? response.collaborationMode.mode : undefined
  });
}

function compactRuntimeInfo(input: { model?: unknown; effort?: unknown; provider?: unknown; collaborationMode?: unknown }): CodexRuntimeInfo {
  return {
    ...(input.collaborationMode === "default" || input.collaborationMode === "plan" ? { collaborationMode: input.collaborationMode } : {}),
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
    ...(typeof input.effort === "string" && input.effort ? { effort: input.effort } : {}),
    ...(typeof input.provider === "string" && input.provider ? { provider: input.provider } : {})
  };
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nativeThread(value: unknown, expectedId?: string): Record<string, unknown> {
  const thread = isRecord(value) && isRecord(value.thread) ? value.thread : undefined;
  if (!thread || typeof thread.id !== "string" || !thread.id.trim()) throw new Error("Codex app-server did not return a thread id");
  if (expectedId !== undefined && thread.id !== expectedId) throw new Error("Native thread identity mismatch");
  return thread;
}

/** An invalid page is not an empty catalog or proof that discovery completed. */
function nativePage(value: unknown, operation: string, cursor?: string): {
  data: unknown[]; nextCursor?: string; backwardsCursor?: string;
} {
  if (!isRecord(value) || !Array.isArray(value.data)
    || [value.nextCursor, value.backwardsCursor].some(item => item !== undefined && item !== null && typeof item !== "string"))
    throw new Error(`Invalid native ${operation} page`);
  const nextCursor = typeof value.nextCursor === "string" && value.nextCursor ? value.nextCursor : undefined;
  if (nextCursor && nextCursor === cursor) throw new Error(`Native ${operation} repeated cursor`);
  return { data: value.data, ...(nextCursor ? { nextCursor } : {}),
    ...(typeof value.backwardsCursor === "string" && value.backwardsCursor ? { backwardsCursor: value.backwardsCursor } : {}) };
}

function persistenceFromThread(thread: Record<string, unknown>): CodexThreadPersistence {
  if (thread.ephemeral === true) return "ephemeral";
  const rolloutPath = typeof thread.path === "string"
    ? thread.path.replaceAll("\\", "/").toLowerCase()
    : "";
  return rolloutPath.includes("/archived_sessions/") ? "archived" : "active";
}

function parseRuntimeStatus(value: unknown): {
  runtimeStatus: CodexThreadRuntimeStatus;
  activeFlags: CodexThreadActiveFlag[];
} {
  const status = isRecord(value) ? value : undefined;
  const type = typeof value === "string"
    ? value
    : typeof status?.type === "string"
      ? status.type
      : undefined;
  const runtimeStatus: CodexThreadRuntimeStatus = type === "notLoaded"
    || type === "idle"
    || type === "active"
    || type === "systemError"
    ? type
    : "unknown";
  const activeFlags = Array.isArray(status?.activeFlags)
    ? status.activeFlags.filter((flag): flag is CodexThreadActiveFlag => (
      flag === "waitingOnApproval" || flag === "waitingOnUserInput"
    ))
    : [];
  return { runtimeStatus, activeFlags };
}

function normalizeTurnStatus(value: unknown): CodexTurnStatus | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.replaceAll(/[-_\s]/g, "").toLowerCase()) {
    case "inprogress":
    case "running":
    case "started":
      return "inProgress";
    case "completed":
    case "complete":
      return "completed";
    case "interrupted":
    case "aborted":
    case "cancelled":
    case "canceled":
      return "interrupted";
    case "failed":
    case "error":
      return "failed";
    default:
      return undefined;
  }
}

function parseThreadState(
  thread: Record<string, unknown>,
  persistence: CodexThreadPersistence
): CodexThreadState {
  const threadId = typeof thread.id === "string" ? thread.id : "";
  const turns = Array.isArray(thread.turns) ? thread.turns.filter(isRecord) : [];
  const latestTurn = turns.at(-1);
  const latestTurnStatus = normalizeTurnStatus(latestTurn?.status);
  const parsedRuntime = parseRuntimeStatus(thread.status);
  // A historical tail is independent of the runtime owner's current state.
  // Unknown/new native status must not become idle/active merely from history.
  const runtimeStatus = parsedRuntime.runtimeStatus;
  const updatedAt = unixTimestampToIso(
    thread.updatedAt ?? latestTurn?.completedAt ?? latestTurn?.startedAt ?? thread.createdAt
  );
  const preview = typeof thread.preview === "string" && thread.preview.trim() && !isInternalUserMessage(thread.preview)
    ? boundedText(thread.preview.replace(/\s+/g, " "), 240)
    : extractLastUserMessageFromTurn(latestTurn);
  const projectId = typeof thread.projectId === "string" && thread.projectId.trim() ? thread.projectId : undefined;
  return {
    threadId,
    persistence,
    runtimeStatus,
    ...(rolloutIdentity({ source: thread.source, thread_source: thread.threadSource ?? thread.thread_source }).internal ? { internal: true } : {}),
    activeFlags: parsedRuntime.activeFlags,
    ...(latestTurnStatus ? { latestTurnStatus } : {}),
    ...(lastCodexTurnFailure(latestTurn) ? { lastTurnFailure: lastCodexTurnFailure(latestTurn) } : {}),
    ...(runtimeStatus === "active" && codexTurnRecovery(threadId, latestTurn)
      ? { recovery: codexTurnRecovery(threadId, latestTurn) } : {}),
    ...(latestTurnStatus === "inProgress" && typeof latestTurn?.id === "string"
      ? { activeTurnId: latestTurn.id }
      : {}),
    ...(typeof thread.cwd === "string" ? { cwd: thread.cwd } : {}),
    ...(projectId ? { projectId } : {}),
    // Native membership is an explicit protocol fact. ID translation and IDE
    // access consume this discriminator as well as the ID; an omitted field
    // from an older/partial response is not evidence of project removal.
    projectMembership: projectId ? "assigned" : thread.projectId === null ? "none" : "unknown",
    ...(typeof thread.name === "string" && thread.name.trim() ? { title: thread.name.trim() } : {}),
    ...(preview ? { preview } : {}),
    ...(updatedAt ? { updatedAt } : {})
  };
}

function extractLastUserMessageFromTurn(turn: Record<string, unknown> | undefined): string | undefined {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isRecord(item) || item.type !== "userMessage") continue;
    const text = extractUserMessageText(item.content);
    if (text) return boundedText(text.replace(/\s+/g, " "), 240);
  }
  return undefined;
}

function unixTimestampToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  // Finite protocol numbers may still exceed Date's representable range.
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function normalizeThreadOperationError(error: unknown, threadId: string): Error {
  if (error instanceof CodexThreadStateError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/already has an active writer/i.test(message)) return new CodexCommunicationError("preflight", "app-server/ownership", threadId, undefined, error);
  if (/archiv|unarchive|已归档/i.test(message)) {
    return new CodexThreadStateError(
      "archived",
      threadId,
      `Codex session ${threadId} 已归档。请先在 Codex App 中恢复该 session 后再重试。`
    );
  }
  if (/not found|no rollout|does not exist|不存在|unknown thread|missing thread/i.test(message)) {
    return new CodexThreadStateError(
      "missing",
      threadId,
      `Codex session ${threadId} 不存在或已被删除，请重新选择 session。`
    );
  }
  if (/system.?error/i.test(message)) {
    return new CodexThreadStateError(
      "system-error",
      threadId,
      `Codex session ${threadId} 当前处于系统错误状态，请先在 Codex App 中打开并修复。`
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function normalizeSteerError(error: unknown, threadId: string, expectedTurnId: string): Error {
  const normalized = normalizeThreadOperationError(error, threadId);
  if (normalized instanceof CodexThreadStateError) return normalized;
  const message = normalized.message;
  if (/no active turn|not.*active|没有.*(?:任务|turn)|already completed/i.test(message)) {
    return new Error(`Codex session ${threadId} 的任务已经结束，无法介入；请把消息作为下一轮发送。`);
  }
  if (/expectedTurnId|expected turn|different turn|mismatch/i.test(message)) {
    return new Error(`Codex session ${threadId} 的活动任务已变化（原 turn ${expectedTurnId}），请刷新后重试。`);
  }
  if (/not steerable|review turn|compact turn|active_turn_not_steerable/i.test(message)) {
    return new Error(`Codex session ${threadId} 当前任务类型不支持运行中介入，请等待完成或先停止任务。`);
  }
  return normalized;
}

function isMissingOrArchivedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /archiv|unarchive|not found|no rollout|does not exist|不存在|unknown thread|missing thread/i.test(message);
}

function extractAgentMessageFromTurn(turn: Record<string, unknown> | undefined): string {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as Record<string, unknown>;
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

export function parseThreadHistory(thread: Record<string, unknown> | undefined): CodexHistoryMessage[] {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages: CodexHistoryMessage[] = [];
  for (const rawTurn of turns) {
    if (!isRecord(rawTurn)) continue;
    const turn = rawTurn;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const userCreatedAt = unixSecondsToIso(turn.startedAt);
    const assistantCreatedAt = unixSecondsToIso(turn.completedAt ?? turn.startedAt);
    for (const rawItem of items) {
      if (!isRecord(rawItem)) continue;
      const item = rawItem;
      const id = typeof item.id === "string" ? item.id : `${String(turn.id ?? "turn")}:${messages.length}`;
      if (item.type === "userMessage") {
        const text = extractUserMessageText(item.content);
        if (text) {
          messages.push({ id, role: "user", text,
            ...(typeof item.clientId === "string" ? { clientUserMessageId: item.clientId } : {}),
            ...(typeof turn.id === "string" ? { turnId: turn.id } : {}),
            ...(["inProgress", "completed", "interrupted", "failed"].includes(String(turn.status))
              ? { turnStatus: turn.status as CodexTurnStatus } : {}),
            ...(userCreatedAt ? { createdAt: userCreatedAt } : {}) });
        }
        continue;
      }
      if (
        item.type === "agentMessage"
        && typeof item.text === "string"
        && item.text.trim()
      ) {
        messages.push({
          id,
          role: "assistant",
          text: item.text.trim(),
          ...(item.phase === "commentary" ? { kind: "progress" as const } : {}),
          ...(assistantCreatedAt ? { createdAt: assistantCreatedAt } : {})
        });
      }
    }
  }
  return messages;
}

function extractUserMessageText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  const text = value.map((raw) => {
    if (!isRecord(raw)) return "";
    const item = raw;
    if (item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
    if (item.type === "localImage" && typeof item.path === "string") {
      return `[本机图片: ${item.path}]`;
    }
    if (item.type === "image" && typeof item.url === "string") {
      return `[图片: ${item.url}]`;
    }
    return "";
  }).filter(Boolean).join("\n").trim();
  return isInternalUserMessage(text) ? "" : text;
}

function unixSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** A replacement executor must not race the previous process's writer lock. */
function waitForProcessExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let forced: NodeJS.Timeout | undefined;
    const cleanup = () => { clearTimeout(graceful); if (forced) clearTimeout(forced); child.removeListener("exit", exited); };
    const exited = () => { cleanup(); resolve(); };
    const graceful = setTimeout(() => {
      child.kill("SIGKILL");
      forced = setTimeout(() => { cleanup(); reject(Error("Codex client process did not exit; replacement was not started")); }, 5_000);
    }, 5_000);
    child.once("exit", exited);
  });
}
