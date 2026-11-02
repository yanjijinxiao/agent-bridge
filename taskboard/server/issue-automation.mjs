import { readFile, realpath } from "node:fs/promises";
import { buildTaskboardAutomationPrompt, parseStoredTaskboardAutomationPolicy } from "../shared/taskboard-automation.mjs";
import { readCodexQuotaStatus } from "../scripts/codex-rate-limits.mjs";

/** Event policy owns scheduling only. AiChatService owns the durable native
 * handoff, exact turn observation and interactions, just as for a manual turn. */
export function createIssueAutomation({ automationPoliciesPath, aiChat, database,
  nativeBackend, readQuota = model => readCodexQuotaStatus(model, nativeBackend), logger = console }) {
  const pendingStarts = new Map(), subscriptions = new Map();
  let closing = false, paused = false;

  async function readPolicy(projectId) {
    let stored;
    try { stored = JSON.parse(await readFile(automationPoliciesPath, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? parseStoredTaskboardAutomationPolicy(stored[projectId]) : null;
  }

  function follow(record) {
    if (closing || !record?.threadId || subscriptions.has(record.projectId)) return;
    const unsubscribe = aiChat.subscribe(record.threadId, event => {
      if (closing || event?.type !== "ai.run" || event.run.status === "running") return;
      const current = database.getAutomationRun(record.projectId);
      if (current?.runId !== event.run.id) return;
      subscriptions.get(record.projectId)?.(); subscriptions.delete(record.projectId);
      if (current.dirty) {
        // Completion can precede the startTurn HTTP response. Retire that
        // admission promise before asking for the next drain worker.
        const admission = pendingStarts.get(record.projectId) ?? Promise.resolve();
        void admission.then(() => trigger({ projectId: record.projectId }))
          .catch(error => logger.error(`Taskboard automation follow-up failed: ${error.message}`));
      }
    });
    subscriptions.set(record.projectId, unsubscribe);
  }

  async function start(projectId) {
    if (closing || paused) return { started: false, reason: closing ? "closing" : "paused" };
    const existing = database.getAutomationRun(projectId);
    if (existing?.runId && database.getAiChatRun(existing.runId)?.status === "running") {
      follow(existing); aiChat.recover();
      return { started: false, reason: "already-running" };
    }
    const policy = await readPolicy(projectId);
    if (closing || paused) return { started: false, reason: closing ? "closing" : "paused" };
    if (!policy?.enabledByUser) return { started: false, reason: "disabled" };
    if (policy.quotaAware) {
      const quota = await readQuota(policy.model);
      if (closing || paused) return { started: false, reason: closing ? "closing" : "paused" };
      if (quota?.state !== "available") return { started: false, reason: "quota", quota };
    }
    if (JSON.stringify(await readPolicy(projectId)) !== JSON.stringify(policy)) return { started: false, reason: "policy-changed" };
    if (closing || paused) return { started: false, reason: closing ? "closing" : "paused" };
    const thread = await aiChat.createThread({ projectId, title: `自动处理 · ${policy.projectName}`,
      model: policy.model, reasoningEffort: policy.reasoningEffort, sandbox: "workspace-write" });
    const workspace = await realpath(policy.workspacePath);
    if (closing || paused) return { started: false, reason: closing ? "closing" : "paused" };
    if (workspace !== thread.origin.workspacePath) throw new Error("Automation policy workspace no longer matches its selected project");
    if (JSON.stringify(await readPolicy(projectId)) !== JSON.stringify(policy)) return { started: false, reason: "policy-changed" };
    if (closing || paused) return { started: false, reason: closing ? "closing" : "paused" };
    // Bind the thread before startTurn. Its run creation transaction writes the
    // run id into this same row before any native input can be sent.
    const record = database.setAutomationRun(projectId, { threadId: thread.id, runId: null, dirty: false });
    subscriptions.get(projectId)?.(); subscriptions.delete(projectId); follow(record);
    try { await aiChat.startTurn(thread.id, { message: buildTaskboardAutomationPrompt(policy) }); }
    catch (error) {
      const current = database.getAutomationRun(projectId);
      if (current?.threadId === thread.id && !current.runId) database.setAutomationRun(projectId, { dirty: true });
      throw error;
    }
    logger.info(`Taskboard issue automation submitted for ${projectId}`);
    return { started: true };
  }

  function trigger(task) {
    const projectId = task?.projectId;
    if (typeof projectId !== "string" || !projectId) return Promise.resolve({ started: false, reason: "invalid-task" });
    if (closing) return Promise.resolve({ started: false, reason: "closing" });
    database.setAutomationRun(projectId, { dirty: true });
    if (paused) return Promise.resolve({ started: false, reason: "paused" });
    const pending = pendingStarts.get(projectId);
    if (pending) return pending;
    const tracked = start(projectId).finally(() => {
      if (pendingStarts.get(projectId) === tracked) pendingStarts.delete(projectId);
    });
    pendingStarts.set(projectId, tracked);
    return tracked;
  }

  function recover() {
    if (closing || paused) return;
    aiChat.recover();
    for (const record of database.listAutomationRuns()) {
      if (record.runId && database.getAiChatRun(record.runId)?.status === "running") follow(record);
      else if (record.dirty) void trigger({ projectId: record.projectId }).catch(error => logger.error(`Taskboard automation reconciliation failed: ${error.message}`));
    }
  }

  async function close() {
    closing = true;
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    // In-flight native work belongs to the independent service, not this event
    // subscriber. Dirty flags and run receipts remain in SQLite for reconnect.
  }
  return { trigger, recover, close, pauseForRestart() { paused = true; },
    resumeAfterCancelledRestart() { paused = false; recover(); } };
}
