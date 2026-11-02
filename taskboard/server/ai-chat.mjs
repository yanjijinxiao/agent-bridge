import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";

import { ApiError } from "./database.mjs";
import { discoverAiCatalog, resolveAiWorkspace } from "./ai-chat-catalog.mjs";
import { buildCodexPrompt } from "./ai-chat-process.mjs";
import { createTaskboardNativeBackend } from "./native-backend.mjs";
import { aiSubmission, findAiSubmission, readAiSubmission } from "./ai-chat-submissions.mjs";

const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const ERROR_CONTENT_LIMIT = 65_536;
const CODEX_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function cappedError(value) {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return message.slice(0, ERROR_CONTENT_LIMIT);
}

export class AiChatService {
  constructor(options) {
    this.database = options.database;
    this.projectCatalog = options.projectCatalog ?? options.database;
    this.codexExecutable = options.codexExecutable;
    this.codexStatePath = options.codexStatePath;
    this.manageTaskboardSkillPath = options.manageTaskboardSkillPath;
    this.processEnv = options.processEnv ?? process.env;
    this.nativeBackend = options.nativeBackend ?? createTaskboardNativeBackend(options);
    this.ownsBackend = !options.nativeBackend;
    this.closed = false;
    this.paused = false;
    this.pendingInteractions = new Map();
    this.active = new Map();
    this.listeners = new Map();
    this.completions = new Map();
  }

  listThreads() {
    return this.database.listAiChatThreads();
  }

  getThread(threadId) {
    const thread = this.database.getAiChatThread(threadId);
    if (!thread) {
      throw new ApiError(
        404,
        "AI_CHAT_THREAD_NOT_FOUND",
        `AI chat thread '${threadId}' does not exist`,
      );
    }
    return thread;
  }

  getThreadSnapshot(threadId) {
    this.recover();
    const thread = this.getThread(threadId);
    return {
      thread,
      events: this.database.listAiChatEvents(threadId),
      runs: this.database.listAiChatRuns(threadId),
      interactions: [...this.pendingInteractions.values()].filter(item => item.threadId === threadId).map(item => item.public),
    };
  }

  getRun(runId) {
    const run = this.database.getAiChatRun(runId);
    if (!run) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${runId}' does not exist`);
    }
    return run;
  }

  subscribe(threadId, listener) {
    let listeners = this.listeners.get(threadId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(threadId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(threadId);
    };
  }

  async getCatalog(projectId) {
    return discoverAiCatalog({
      nativeBackend: this.nativeBackend,
      codexStatePath: this.codexStatePath,
      database: this.projectCatalog,
      projectId,
      processEnv: this.processEnv,
    });
  }

  async createThread(input) {
    const submission = aiSubmission(input, "thread", input.projectId);
    const existing = findAiSubmission(this.database, submission);
    if (existing) return existing;
    const [catalog, resolved] = await Promise.all([
      this.getCatalog(input.projectId),
      resolveAiWorkspace(input.projectId, this.codexStatePath, this.projectCatalog),
    ]);
    const model = this.#resolveModel(catalog, input.model);
    const reasoningEffort = input.reasoningEffort ?? model.defaultReasoningEffort;
    this.#validateReasoningEffort(model, reasoningEffort);
    const sandbox = input.sandbox ?? "workspace-write";
    this.#validateSandbox(sandbox);

    let issue;
    if (input.issueId !== undefined) {
      issue = this.database.getTask(input.issueId);
      if (!issue || issue.projectId !== input.projectId || issue.archivedAt != null) {
        throw new ApiError(
          404,
          "AI_CHAT_ISSUE_NOT_FOUND",
          `Task '${input.issueId}' is not an active task in project '${input.projectId}'`,
        );
      }
    }

    const confirmed = findAiSubmission(this.database, submission);
    if (confirmed) return confirmed;
    return this.database.createAiChatThread({
      submission,
      title: input.title ?? issue?.identifier ?? "New conversation",
      origin: {
        projectId: resolved.project.id,
        projectName: resolved.project.name,
        workspacePath: resolved.workspacePath,
        ...(issue ? { issueId: issue.id, issueIdentifier: issue.identifier } : {}),
      },
      model: model.slug,
      reasoningEffort,
      sandbox,
    });
  }

  async updateThread(threadId, changes) {
    let thread = this.getThread(threadId);
    const changesSettings = ["model", "reasoningEffort", "sandbox"].some(
      (key) => Object.hasOwn(changes, key),
    );
    const wasActive = changesSettings && this.#threadIsActive(thread);

    if (Object.hasOwn(changes, "sandbox")) this.#validateSandbox(changes.sandbox);
    if (Object.hasOwn(changes, "model") || Object.hasOwn(changes, "reasoningEffort")) {
      const catalog = await this.getCatalog(thread.origin.projectId);
      thread = this.getThread(threadId);
      const model = this.#resolveModel(catalog, changes.model ?? thread.model);
      const reasoningEffort = changes.reasoningEffort ?? thread.reasoningEffort;
      this.#validateReasoningEffort(model, reasoningEffort);
    }
    if (wasActive || (changesSettings && this.#threadIsActive(thread))) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }

    return this.database.updateAiChatThread(threadId, changes);
  }

  deleteThread(threadId) {
    const thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    return this.database.deleteAiChatThread(threadId);
  }

  async startTurn(threadId, input) {
    if (this.closed || this.paused) throw new ApiError(503, "SERVICE_CLOSED", "Taskboard native handoffs are paused");
    this.#validateTurnInput(input);
    const submission = aiSubmission(input, "turn", threadId);
    const existing = findAiSubmission(this.database, submission);
    if (existing) return existing;
    let thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    this.#validateTurnInput(input);
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }

    const [catalog, resolved] = await Promise.all([
      this.getCatalog(thread.origin.projectId),
      resolveAiWorkspace(thread.origin.projectId, this.codexStatePath, this.projectCatalog),
    ]);

    thread = this.getThread(threadId);
    const confirmed = findAiSubmission(this.database, submission);
    if (confirmed) return confirmed;
    this.#assertReadyToSpawn(thread, input, catalog, resolved);

    const skillIds = input.skillIds ?? [];
    const availableSkills = new Map(
      catalog.skills
        .filter((skill) => skill.id !== "manage-taskboard")
        .map((skill) => [skill.id, skill]),
    );
    for (const skillId of skillIds) {
      if (!availableSkills.has(skillId)) {
        throw new ApiError(400, "INVALID_SKILL", `Unknown or unavailable skill '${skillId}'`);
      }
    }
    const selectedSkills = skillIds.map((skillId) => availableSkills.get(skillId));

    const attachments = input.attachments ?? [];
    const {
      temporaryDirectory,
      attachmentPaths,
      imagePaths,
    } = await this.#writeTurnAttachments(attachments);
    try {
      // Attachment preparation yields even for an empty list. Use the latest
      // stored settings and active-run identity at the final spawn boundary.
      thread = this.getThread(threadId);
      const confirmed = findAiSubmission(this.database, submission);
      if (confirmed) { if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }); return confirmed; }
      this.#assertReadyToSpawn(thread, input, catalog, resolved);
      const prompt = buildCodexPrompt(
        thread,
        {
          message: input.message,
          skills: selectedSkills,
          attachmentPaths,
        },
        this.manageTaskboardSkillPath,
      );
      const receipt = { version: 1, phase: "prepared", nativeThreadId: thread.codexThreadId,
        nativeTurnId: null, temporaryDirectory, clientUserMessageId: submission?.id ?? crypto.randomUUID() };
      const userEventData = {};
      if (skillIds.length > 0) userEventData.skillIds = skillIds;
      if (attachments.length > 0) {
        userEventData.attachments = attachments.map(({ filename, contentType, size }) => ({
          filename,
          contentType,
          size,
        }));
      }
      const userEvent = {
        id: crypto.randomUUID(),
        type: "user_message",
        role: "user",
        content: input.message,
        data: Object.keys(userEventData).length > 0 ? userEventData : undefined,
      };
      const run = this.database.createAiChatRun({ threadId, nativeReceipt: receipt, userEvent, submission });
      this.#emit(threadId, { type: "ai.run", run });
      this.#emit(threadId, { type: "ai.event" });

      this.#startNative(run, receipt, { prompt, cwd: resolved.workspacePath,
        imagePaths, threadId: thread.codexThreadId ?? undefined, model: thread.model, effort: thread.reasoningEffort,
        nativeSettings: {
          sandbox: thread.sandbox === "danger-full-access" ? "danger-full-access" : "workspace-write",
          approvalPolicy: thread.sandbox === "danger-full-access" ? "never" : "on-request",
          approvalsReviewer: thread.sandbox === "read-only" ? "user" : "auto_review",
          runtimeWorkspaceRoots: [resolved.workspacePath, ...resolved.addDirectories],
        },
      });
      return run;
    } catch (error) {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  /** Resume observation only. A prepared/unknown receipt never authorizes replay. */
  getSubmission(id) { return readAiSubmission(this.database, id); }

  recover() {
    if (this.closed || this.paused) return;
    for (const run of this.database.listNativeRunningAiChatRuns()) {
      const active = this.active.get(run.id);
      if (active) {
        if (active.needsInteractionRefresh && !active.refreshingInteractions && active.observer) {
          active.needsInteractionRefresh = false; active.refreshingInteractions = true;
          void this.nativeBackend.observeThreadInteractions(active.receipt.nativeThreadId, "local", active.observer, "taskboard")
            .catch(() => { if (!this.closed) active.needsInteractionRefresh = true; })
            .finally(() => { active.refreshingInteractions = false; });
        }
        continue;
      }
      const receipt = this.database.getAiChatNativeReceipt(run.id);
      if (!receipt?.nativeThreadId) {
        this.#uncertain(run, "提交回执待核对，未自动重发。原生会话身份尚未确认。");
        continue;
      }
      this.#startNative(run, receipt);
    }
  }

  #activity(run, activity) {
    if (this.closed || this.database.getAiChatRun(run.id)?.status !== "running") return;
    const identity = activity.data?.itemId;
    const event = this.database.insertAiChatEvent({ ...activity, threadId: run.threadId, runId: run.id,
      ...(identity ? { id: `native:${run.id}:${createHash("sha256").update(`${activity.type}:${identity}`).digest("hex")}` } : {}) });
    this.#emit(run.threadId, { type: "ai.event", event });
  }

  #uncertain(run, message) {
    if (this.closed) return;
    const previous = this.database.getAiChatRun(run.id);
    if (previous?.status !== "running" || previous.error === message) return;
    const updated = this.database.updateAiChatRun(run.id, { error: message });
    this.#emit(run.threadId, { type: "ai.run", run: updated });
  }

  #interaction(run, kind, request) {
    if (this.closed) return Promise.resolve(undefined);
    const receipt = this.database.getAiChatNativeReceipt(run.id);
    if (receipt?.nativeThreadId !== request.threadId || receipt.nativeTurnId && receipt.nativeTurnId !== request.turnId) return Promise.resolve(undefined);
    const id = createHash("sha256").update(JSON.stringify([run.id, kind, request.nativeKey ?? request.requestId ?? request.itemId])).digest("hex");
    const existing = this.pendingInteractions.get(id);
    if (existing && !existing.public.submitted) return existing.promise;
    // Only a fresh native pending-request observation can offer another answer
    // after an uncertain flush. Never return a promise resolved to the old one.
    if (existing) this.pendingInteractions.delete(id);
    const { promise, resolve } = Promise.withResolvers();
    const publicRequest = kind === "approval" ? {
      kind, id, runId: run.id, title: request.reason || "Codex 请求批准", command: request.command,
      options: (request.options ?? []).map(({ id, label, description }) => ({ id, label, description })),
    } : { kind, id, runId: run.id, questions: request.questions };
    this.pendingInteractions.set(id, { id, threadId: run.threadId, runId: run.id, nativeTurnId: request.turnId,
      public: publicRequest, request, resolve, promise });
    this.#emit(run.threadId, { type: "ai.event" });
    return promise;
  }

  #interactionResult(run, request, result) {
    if (this.closed) return;
    for (const [id, pending] of this.pendingInteractions) {
      if (pending.runId !== run.id || pending.request.itemId !== request.itemId || pending.request.turnId !== request.turnId
        || (pending.request.nativeKey ?? pending.request.requestId) !== (request.nativeKey ?? request.requestId)) continue;
      if (["confirmed", "withdrawn", "suspended"].includes(result)) this.pendingInteractions.delete(id);
      else {
        pending.public.error = "原生服务未确认答案，正在核对原请求；不会自动重发答案。";
        const active = this.active.get(run.id);
        if (active) active.needsInteractionRefresh = true;
      }
    }
    this.#emit(run.threadId, { type: "ai.event" });
  }

  answerInteraction(threadId, id, answer) {
    if (this.closed || this.paused) throw new ApiError(503, "SERVICE_CLOSED", "Taskboard native handoffs are paused");
    this.getThread(threadId);
    const pending = this.pendingInteractions.get(id);
    const receipt = pending && this.database.getAiChatNativeReceipt(pending.runId);
    if (!pending || pending.threadId !== threadId || pending.public.submitted
      || this.database.getAiChatRun(pending.runId)?.status !== "running" || receipt.nativeTurnId !== pending.nativeTurnId)
      throw new ApiError(409, "INTERACTION_CHANGED", "原生交互已变化，请刷新后核对。");
    if (pending.public.kind === "approval") {
      if (typeof answer !== "string" || !pending.public.options.some(option => option.id === answer))
        throw new ApiError(400, "INVALID_ANSWER", "请选择原生请求提供的审批选项。");
    } else {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)
        || Object.keys(answer).some(id => !pending.request.questions.some(question => question.id === id))
        || pending.request.questions.some(question => !Array.isArray(answer[question.id]?.answers)
          || answer[question.id].answers.length > 20 || answer[question.id].answers.some(value => typeof value !== "string" || value.length > 100000)))
        throw new ApiError(400, "INVALID_ANSWER", "请按原生问题填写答案。");
    }
    // Answers, especially secret fields, are never written to event history.
    pending.public.submitted = true;
    pending.resolve(answer);
    this.#emit(threadId, { type: "ai.event" });
    return { status: "submitted" };
  }

  #startNative(run, receipt, submission) {
    const record = { threadId: run.threadId, receipt };
    this.active.set(run.id, record);
    const current = () => {
      if (this.closed || this.paused || this.active.get(run.id) !== record)
        throw Object.assign(new Error("Taskboard source detached before native handoff"), { submission: "not-submitted" });
    };
    const callbacks = {
      assertCurrent: current,
      clientUserMessageId: receipt.clientUserMessageId,
      onThreadCreated: async nativeThreadId => {
        current(); receipt.nativeThreadId = nativeThreadId;
        this.database.saveAiChatNativeReceipt(run.id, receipt);
        this.database.updateAiChatThread(run.threadId, { codexThreadId: nativeThreadId });
        await this.nativeBackend.observeThreadInteractions(nativeThreadId, "local", record.observer, "taskboard");
      },
      onTurnStarted: event => {
        current();
        if (receipt.nativeThreadId && receipt.nativeThreadId !== event.threadId
          || receipt.nativeTurnId && receipt.nativeTurnId !== event.turnId) throw new Error("Native accepted identity mismatch");
        Object.assign(receipt, { phase: "accepted", nativeThreadId: event.threadId, nativeTurnId: event.turnId });
        this.database.saveAiChatNativeReceipt(run.id, receipt);
        const accepted = this.database.updateAiChatRun(run.id, { error: null });
        this.#emit(run.threadId, { type: "ai.run", run: accepted });
      },
      onItem: activity => this.#activity(run, activity),
      onProgress: content => this.#activity(run, { type: "progress", role: "activity", content, data: {} }),
      onApproval: request => this.#interaction(run, "approval", request),
      onApprovalResult: (request, result) => this.#interactionResult(run, request, result),
      onUserInput: request => this.#interaction(run, "user-input", request),
      onUserInputResult: (request, result) => this.#interactionResult(run, request, result),
    };
    record.observer = {
      onApproval: envelope => callbacks.onApproval(envelope.request),
      onResult: (envelope, result) => callbacks.onApprovalResult(envelope.request, result),
      onUserInput: envelope => callbacks.onUserInput(envelope.request),
      onUserInputResult: (envelope, result) => callbacks.onUserInputResult(envelope.request, result),
    };
    // Interaction consumers share one native subscription. Keeping UI answers
    // in the observer fanout also lets an IM binding observe this same task.
    const { onApproval, onApprovalResult, onUserInput, onUserInputResult, ...executionCallbacks } = callbacks;
    const completion = (async () => {
      try {
        let result;
        if (submission) {
          current(); receipt.phase = "submitting";
          this.database.saveAiChatNativeReceipt(run.id, receipt);
          if (receipt.nativeThreadId) await this.nativeBackend.observeThreadInteractions(receipt.nativeThreadId, "local", record.observer, "taskboard");
          current();
          result = await this.nativeBackend.run({ ...submission, ...executionCallbacks });
        } else {
          // No prompt or queue id: this API can only adopt the exact stored
          // native turn/client id, never start a replacement task.
          await this.nativeBackend.observeThreadInteractions(receipt.nativeThreadId, "local", record.observer, "taskboard");
          current();
          result = await this.nativeBackend.runQueuedSubmission({ ...executionCallbacks, threadId: receipt.nativeThreadId,
            cwd: this.getThread(run.threadId).origin.workspacePath, acceptedTurnId: receipt.nativeTurnId ?? undefined });
        }
        if (this.closed) return;
        // Reconcile public items missed during disconnection before retiring
        // the run. Stable item ids replace progress rather than duplicating it.
        for (const activity of await this.nativeBackend.readTurnActivities(result.threadId, result.turnId)) this.#activity(run, activity);
        if (!this.database.listAiChatEvents(run.threadId).some(event => event.runId === run.id && event.role === "assistant"))
          this.#activity(run, { type: "agent_message", role: "assistant", content: result.text, data: {} });
        await this.#finishNative(run, receipt, "completed");
      } catch (error) {
        if (this.closed) return;
        if (error?.name === "CodexTurnExecutionError") await this.#finishNative(run, receipt, error.status, cappedError(error));
        else if (submission && (error?.submission === "not-submitted" || ["CodexRunAdmissionError", "CodexThreadStateError"].includes(error?.name)))
          await this.#finishNative(run, receipt, "failed", cappedError(error));
        else this.#uncertain(run, "原生提交或进展回执待核对；未自动重发输入。" + cappedError(error));
      } finally {
        if (this.active.get(run.id) === record) this.active.delete(run.id);
        this.completions.delete(run.id);
      }
    })();
    this.completions.set(run.id, completion);
    void completion.catch(error => { if (!this.closed) console.error("Taskboard native observation failed:", cappedError(error)); });
  }

  async #finishNative(run, receipt, status, error = null) {
    if (this.closed) return;
    const updated = this.database.updateAiChatRun(run.id, { status, error, exitCode: status === "completed" ? 0 : null,
      finishedAt: new Date().toISOString() });
    for (const [id, item] of this.pendingInteractions) if (item.runId === run.id) { item.resolve(undefined); this.pendingInteractions.delete(id); }
    this.#emit(run.threadId, { type: "ai.run", run: updated });
    if (receipt.nativeThreadId) await this.nativeBackend.unobserveThreadInteractions(receipt.nativeThreadId, "local", "taskboard").catch(() => {});
    if (receipt.temporaryDirectory) await rm(receipt.temporaryDirectory, { recursive: true, force: true });
  }

  async interrupt(runId) {
    if (this.closed || this.paused) throw new ApiError(503, "SERVICE_CLOSED", "Taskboard native handoffs are paused");
    const run = this.getRun(runId);
    if (run.status !== "running") return run;
    const receipt = this.database.getAiChatNativeReceipt(runId);
    if (!receipt?.nativeThreadId || !receipt.nativeTurnId) throw new ApiError(409, "NATIVE_RECEIPT_PENDING", "原生轮次身份尚未确认，不能停止其他任务。");
    await this.nativeBackend.interruptTurn(receipt.nativeThreadId, receipt.nativeTurnId, undefined, () => {
      if (this.closed || this.paused) throw new Error("Taskboard source detached before interrupt handoff");
    });
    // An interrupt acknowledgement is not a terminal event. Reconcile the
    // original turn; never synthesize interruption or target the newest turn.
    this.recover();
    return this.getRun(runId);
  }

  async close() {
    this.closed = true;
    for (const item of this.pendingInteractions.values()) item.resolve(undefined);
    this.pendingInteractions.clear();
    this.listeners.clear();
    const threads = new Set([...this.active.values()].map(active => active.receipt.nativeThreadId).filter(Boolean));
    await Promise.allSettled([...threads].map(threadId => this.nativeBackend.unobserveThreadInteractions(threadId, "local", "taskboard")));
    if (this.ownsBackend) await this.nativeBackend.close();
  }

  pauseForRestart() { this.paused = true; }
  resumeAfterCancelledRestart() { this.paused = false; this.recover(); }

  #resolveModel(catalog, requestedModel) {
    const model = requestedModel === undefined
      ? catalog.models[0]
      : catalog.models.find((candidate) => candidate.slug === requestedModel);
    if (!model) {
      throw new ApiError(
        400,
        "INVALID_MODEL",
        requestedModel === undefined
          ? "Codex did not provide an available model"
          : `Unknown model '${requestedModel}'`,
      );
    }
    return model;
  }

  #assertReadyToSpawn(thread, input, catalog, resolved) {
    if (this.closed || this.paused) throw new ApiError(503, "SERVICE_CLOSED", "Taskboard native handoffs are paused");
    if (this.#threadIsActive(thread)) {
      throw new ApiError(409, "THREAD_BUSY", `AI chat thread '${thread.id}' has a running turn`);
    }
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(400, "DANGER_CONFIRMATION_REQUIRED", "danger-full-access must be confirmed for every turn");
    }
    this.#validateReasoningEffort(this.#resolveModel(catalog, thread.model), thread.reasoningEffort);
    if (resolved.workspacePath !== thread.origin.workspacePath) {
      throw new ApiError(409, "PROJECT_WORKSPACE_CHANGED", "The project's device workspace no longer matches this conversation");
    }
  }

  #validateReasoningEffort(model, reasoningEffort) {
    if (!model.supportedReasoningEfforts.includes(reasoningEffort)) {
      throw new ApiError(
        400,
        "INVALID_REASONING_EFFORT",
        `Reasoning effort '${reasoningEffort}' is not supported by model '${model.slug}'`,
      );
    }
  }

  #validateSandbox(sandbox) {
    if (!SANDBOXES.has(sandbox)) {
      throw new ApiError(
        400,
        "INVALID_SANDBOX",
        "'sandbox' must be read-only, workspace-write, or danger-full-access",
      );
    }
  }

  #validateTurnInput(input) {
    if (
      !input
      || typeof input.message !== "string"
      || input.message.length > 100_000
      || (
        input.message.trim() === ""
        && (!Array.isArray(input.attachments) || input.attachments.length === 0)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_MESSAGE",
        "A message or at least one attachment is required",
      );
    }
    if (
      input.skillIds !== undefined
      && (
        !Array.isArray(input.skillIds)
        || input.skillIds.length > 20
        || input.skillIds.some((skillId) => typeof skillId !== "string" || !skillId)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_SKILL",
        "'skillIds' must contain at most 20 skill ids",
      );
    }
  }

  async #writeTurnAttachments(attachments) {
    if (attachments.length === 0) {
      return { temporaryDirectory: null, attachmentPaths: [], imagePaths: [] };
    }
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "codex-taskboard-ai-turn-"),
    );
    try {
      const attachmentPaths = [];
      const imagePaths = [];
      for (const [index, attachment] of attachments.entries()) {
        const attachmentPath = path.join(
          temporaryDirectory,
          `attachment-${index + 1}-${attachment.filename}`,
        );
        await writeFile(attachmentPath, attachment.data, { flag: "wx", mode: 0o600 });
        attachmentPaths.push(attachmentPath);
        if (CODEX_IMAGE_TYPES.has(attachment.contentType)) imagePaths.push(attachmentPath);
      }
      return { temporaryDirectory, attachmentPaths, imagePaths };
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  #threadIsActive(thread) {
    return Boolean(thread.currentRun)
      || [...this.active.values()].some((active) => active.threadId === thread.id);
  }

  #emit(threadId, event) {
    for (const listener of this.listeners.get(threadId) ?? []) {
      try {
        listener(event);
      } catch {}
    }
  }
}
