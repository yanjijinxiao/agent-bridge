// Frozen setup helper copied from test/account-manager.test.ts at 3d5bff7.
// Only its relative imports and exported setup declaration differ.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPrompt } from "../../../../src/bridge/format.js";
import { AccountManager } from "../../../../src/server/account-manager.js";
import type { CodexDesktopApproval } from "../../../../src/server/codex-desktop-approval-monitor.js";
import type { CodexDesktopUserInput, CodexDesktopRequestMonitorOptions } from "../../../../src/server/codex-desktop-request-monitor.js";
import type { ApprovalDeliveryResult } from "../../../../src/bridge/approval.js";
import type {
  CodexSessionActivity,
  CodexSessionCompletion,
  CodexSessionTask
} from "../../../../src/server/codex-session-monitor.js";
import { defaultConfig } from "../../../../src/state/config.js";
import { accountStatePaths, resolveStatePaths } from "../../../../src/state/paths.js";
import { RuntimeStateStore } from "../../../../src/state/runtime-state.js";
import { listRetainedAccounts, loadAccount, saveAccount } from "../../../../src/weixin/accounts.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../../../../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES, EXEC_BACKEND_CAPABILITIES } from "../../../../src/codex/backend.js";
import type { NormalizedWeixinMessage } from "../../../../src/weixin/messages.js";

export function setup(t: test.TestContext, options: { taskboardClient?: object; taskCards?: boolean; llmWiki?: object; root?: string;
  config?: Partial<ReturnType<typeof defaultConfig>>;
  adapterFactory?: ConstructorParameters<typeof AccountManager>[0]["adapterFactory"] } = {}) {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-manager-"));
  t.after(async () => { await manager.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const paths = resolveStatePaths(root);
  for (const accountId of ["account-one", "account-two"]) {
    saveAccount(paths, {
      accountId,
      userId: `user-${accountId}`,
      token: `token-${accountId}`,
      baseUrl: "https://example.test",
      cdnBaseUrl: "https://cdn.example.test",
      savedAt: new Date().toISOString(),
      enabled: true
    });
  }
  const starts: string[] = [];
  const inboundHandlers = new Map<string, (message: NormalizedWeixinMessage) => Promise<void>>();
  const handledMessages: NormalizedWeixinMessage[] = [];
  const sent: Array<{ accountId: string; toUserId: string; text: string }> = [];
  const streamStarts: Array<{ accountId: string; toUserId: string; text: string }> = [];
  const streamUpdates: Array<{
    accountId: string;
    toUserId: string;
    messageId: string;
    text: string;
    finalize?: boolean;
  }> = [];
  const sentCards: Array<{ accountId: string; toUserId: string; card: { identifier: string; latestComment?: string; actions: readonly { label: string }[] } }> = [];
  const runs: Array<Record<string, unknown>> = [];
  const bridges = new Map<string, Parameters<NonNullable<ConstructorParameters<typeof AccountManager>[0]["bridgeFactory"]>>[0]>();
  let runtimeInfo: { model?: string; effort?: string; provider?: string } = {
    model: "runtime-model",
    effort: "medium"
  };
  let runHandler: ((input: Record<string, unknown>) => Promise<{ raw: string; text: string; threadId?: string; turnId?: string }>) | undefined;
  let externalCompletionHandler: ((completion: CodexSessionCompletion) => Promise<void>) | undefined;
  let externalTaskHandler: ((task: CodexSessionTask) => void) | undefined;
  let externalActivityHandler: ((activity: CodexSessionActivity) => Promise<void>) | undefined;
  let desktopApprovalHandler: ((approval: CodexDesktopApproval) => Promise<"accept" | "decline" | undefined>) | undefined;
  let approvalResultHandler: ((approval: CodexDesktopApproval, result: ApprovalDeliveryResult) => Promise<void> | void) | undefined;
  let questionHandler: CodexDesktopRequestMonitorOptions["onUserInput"];
  let questionResultHandler: CodexDesktopRequestMonitorOptions["onUserInputResult"];
  let unsupportedInteractionHandler: CodexDesktopRequestMonitorOptions["onUnsupportedInteraction"];
  const channelQuestions: Array<{ accountId: string; senderId: string; request: CodexDesktopUserInput["request"] }> = [];
  const questionResults: Array<{ senderId: string; result: string }> = [];
  const recoveredQuestions = new Set<string>();
  const followedDesktopThreads: string[] = [];
  const currentlyFollowed = new Set<string>();
  const approvalResults: Array<{ senderId: string; result: ApprovalDeliveryResult }> = [];
  const channelApprovals: Array<{ senderId: string; request: Record<string, unknown> }> = [];
  const history = [
    { id: "user-1", role: "user" as const, text: buildPrompt("历史问题") },
    { id: "assistant-1", role: "assistant" as const, text: "历史回答" }
  ];
  const runner = {
    async warmUp() {},
    async run(input: Record<string, unknown>) {
      runs.push(input);
      if (runHandler) return runHandler(input);
      return { raw: "", text: "Web reply", threadId: input.threadId ?? "thread-web", turnId: "turn-web" };
    },
    async getHistory() {
      return structuredClone(history);
    },
    async getRuntimeInfo() {
      return runtimeInfo;
    },
    async listModels() {
      return [{
        model: "runtime-model",
        displayName: "Runtime Model",
        description: "Runtime model description",
        isDefault: true,
        defaultEffort: "medium",
        supportedEfforts: [{ effort: "medium", description: "Balanced" }]
      }];
    },
    async stop() {},
    close() {}
  };
  const manager = new AccountManager({
    paths,
    adapterFactory: options.adapterFactory,
    configProvider: () => ({ ...defaultConfig(root), taskboardEnabled: Boolean(options.taskboardClient), ...options.config }),
    taskboardClientFactory: () => options.taskboardClient as never,
    llmWiki: (options.llmWiki ? { close() {}, ...options.llmWiki } : undefined) as never,
    clientFactory: (account) => ({
      accountId: account.accountId,
      async sendText(input: { toUserId: string; text: string }) {
        sent.push({ accountId: account.accountId, ...input });
        return { messageId: "sent" };
      },
      async startTextStream(input: { toUserId: string; text: string }) {
        streamStarts.push({ accountId: account.accountId, ...input });
        return { messageId: `stream-${streamStarts.length}` };
      },
      async updateTextStream(input: {
        toUserId: string;
        messageId: string;
        text: string;
        finalize?: boolean;
      }) {
        streamUpdates.push({ accountId: account.accountId, ...input });
      },
      ...(options.taskCards ? {
        async sendTaskCard(input: { toUserId: string; card: typeof sentCards[number]["card"] }) {
          sentCards.push({ accountId: account.accountId, ...input });
          return { messageId: "sent-card" };
        }
      } : {})
    }) as never,
    channelFactory: (account) => ({
      client: {
        async sendText(input: { toUserId: string; text: string }) {
          sent.push({ accountId: account.accountId, ...input });
          return { messageId: "sent" };
        }
      },
      async monitor({ signal, onMessage }) {
        starts.push(account.accountId);
        inboundHandlers.set(account.accountId, onMessage);
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      }
    }),
    bridgeFactory: (input) => {
      const accountId = path.basename(input.inboundDir!);
      bridges.set(accountId, input);
      return ({
      async handleMessage(message: NormalizedWeixinMessage) {
        handledMessages.push(message);
      },
      async requestApproval(senderId: string, request: Record<string, unknown>) {
        channelApprovals.push({ senderId, request });
        return "accept" as const;
      },
      async reportApprovalResult(senderId: string, _request: unknown, result: ApprovalDeliveryResult) {
        approvalResults.push({ senderId, result });
      },
      async requestUserInput(senderId: string, request: CodexDesktopUserInput["request"]) {
        channelQuestions.push({ accountId, senderId, request });
        return { [request.questions[0].id]: { answers: ["回答"] } };
      },
      hasUserInput(senderId: string) { return recoveredQuestions.has(`${accountId}:${senderId}`); },
      async reportUserInputResult(senderId: string, _request: unknown, result: string) {
        questionResults.push({ senderId, result });
      },
      allowSender(senderId: string) {
        input.stateStore.setPairedSenderIds([...input.stateStore.listPairedSenderIds(), senderId]);
      },
      removeSender(senderId: string) {
        input.stateStore.setPairedSenderIds(input.stateStore.listPairedSenderIds().filter((id) => id !== senderId));
      }
      }) as never;
    },
    monitor: async ({ client, signal, onMessage }) => {
      const accountId = (client as never as { accountId: string }).accountId;
      starts.push(accountId);
      inboundHandlers.set(accountId, onMessage);
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
    runnerFactory: () => runner as never,
    codexSessionMonitorFactory: (handlers) => {
      externalCompletionHandler = handlers.onCompletion;
      externalTaskHandler = handlers.onTaskChanged;
      externalActivityHandler = handlers.onActivity;
      return { start() {}, stop() {} } as never;
    },
    codexDesktopApprovalMonitorFactory: (handlers) => {
      desktopApprovalHandler = handlers.onApproval;
      approvalResultHandler = handlers.onResult;
      questionHandler = handlers.onUserInput;
      questionResultHandler = handlers.onUserInputResult;
      unsupportedInteractionHandler = handlers.onUnsupportedInteraction;
      return {
        start() {},
        stop() {},
        followThread(threadId: string) { followedDesktopThreads.push(threadId); },
        setFollowedThreads(threadIds: Iterable<string | { threadId: string; hostId: string }>) {
          const next = new Set(Array.from(threadIds, value => typeof value === "string" ? value
            : value.hostId === "local" ? value.threadId : JSON.stringify([value.hostId, value.threadId])));
          for (const id of next) if (!currentlyFollowed.has(id)) followedDesktopThreads.push(id);
          currentlyFollowed.clear();
          for (const id of next) currentlyFollowed.add(id);
        }
      } as never;
    }
  });
  return {
    manager,
    paths,
    starts,
    handledMessages,
    root,
    runs,
    history,
    sent,
    streamStarts,
    streamUpdates,
    sentCards,
    async emitInbound(accountId: string, message: NormalizedWeixinMessage) {
      const handler = inboundHandlers.get(accountId);
      assert.ok(handler, `Inbound handler is not running for ${accountId}`);
      await handler(message);
    },
    async emitCodexCompletion(completion: CodexSessionCompletion) {
      assert.ok(externalCompletionHandler, "Codex session monitor should be active");
      await externalCompletionHandler(completion);
    },
    emitCodexTask(task: CodexSessionTask) {
      assert.ok(externalTaskHandler, "Codex task status monitor should be active");
      externalTaskHandler(task);
    },
    async emitCodexActivity(activity: CodexSessionActivity) {
      assert.ok(externalActivityHandler, "Codex activity monitor should be active");
      await externalActivityHandler(activity);
    },
    async emitDesktopApproval(approval: CodexDesktopApproval) {
      assert.ok(desktopApprovalHandler, "Codex Desktop approval monitor should be active");
      return desktopApprovalHandler(approval);
    },
    async emitApprovalResult(approval: CodexDesktopApproval, result: ApprovalDeliveryResult) {
      await approvalResultHandler?.(approval, result);
    },
    approvalResults,
    async emitDesktopQuestion(input: CodexDesktopUserInput) {
      assert.ok(questionHandler); return questionHandler(input);
    },
    async emitQuestionResult(input: CodexDesktopUserInput, result: "confirmed" | "withdrawn" | "failed") {
      await questionResultHandler?.(input, result);
    },
    async emitUnsupportedInteraction(input: Parameters<NonNullable<typeof unsupportedInteractionHandler>>[0]) {
      assert.ok(unsupportedInteractionHandler); await unsupportedInteractionHandler(input);
    },
    channelQuestions, questionResults, recoveredQuestions,
    currentlyFollowed,
    bridges,
    followedDesktopThreads,
    channelApprovals,
    setRunHandler(handler: typeof runHandler) {
      runHandler = handler;
    },
    setRuntimeInfo(value: typeof runtimeInfo) {
      runtimeInfo = value;
    },
    runner
  };
}
