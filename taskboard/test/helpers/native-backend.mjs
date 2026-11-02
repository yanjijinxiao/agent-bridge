import { randomUUID } from "node:crypto";

/** Test-owned core: reconnecting clients share execution, never a real daemon. */
export function fakeNativeCore({ onRun, onCatalog, model = "gpt-real" } = {}) {
  const calls = [], turns = new Map(), interrupts = [];
  const models = [model, "gpt-5.5", "gpt-5.4"].filter((value, i, all) => all.indexOf(value) === i).map(value => ({
    model: value, displayName: value === "gpt-real" ? "GPT Real" : value,
    description: value === "gpt-real" ? "Real fixture" : "", isDefault: value === model,
    defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"].map(effort => ({ effort, description: "" })),
    serviceTiers: [{ id: "priority", name: "Fast" }],
  }));
  const skills = [{ id: "real-skill", name: "real-skill", label: "Real Skill", description: "Fixture skill", path: "/fixture/real-skill/SKILL.md", scope: "repo" }];
  function client() {
    const detached = Promise.withResolvers(); void detached.promise.catch(() => {});
    let closed = false;
    const observers = new Map();
    const all = threadId => [...(observers.get(threadId)?.values() ?? [])];
    const approvalEnvelope = request => ({ request, requestId: request.nativeKey ?? request.itemId,
      hostId: "local", method: "item/commandExecution/requestApproval" });
    const inputEnvelope = request => ({ request, requestId: request.requestId ?? request.itemId,
      hostId: "local", method: "item/tool/requestUserInput" });
    const fail = () => Object.assign(new Error("Isolated native client disconnected"), { name: "CodexCommunicationError", submission: "accepted" });
    const watch = async (entry, input) => {
      await input.onTurnStarted?.({ threadId: entry.threadId, turnId: entry.turnId });
      const result = await Promise.race([entry.done.promise, detached.promise]);
      for (const item of entry.items) await input.onItem?.(item);
      return result;
    };
    return {
      async listModels() { await onCatalog?.(); return structuredClone(models); },
      async listSkills() { return structuredClone(skills); },
      async listMcpServers() { return [{ id: "fixture", label: "fixture", authStatus: "notLoggedIn", tools: [] }]; },
      async getAccountRateLimits() { return { primary: { usedPercent: 5, resetsAt: null } }; },
      async run(input) {
        if (closed) throw fail(); input.assertCurrent?.();
        const threadId = input.threadId ?? randomUUID(), turnId = randomUUID();
        if (!input.threadId) await input.onThreadCreated?.(threadId);
        input.assertCurrent?.();
        const done = Promise.withResolvers(); void done.promise.catch(() => {});
        const entry = { threadId, turnId, clientId: input.clientUserMessageId, input, items: [], done, status: "inProgress" };
        turns.set(turnId, entry); calls.push(input);
        await input.onTurnStarted?.({ threadId, turnId });
        void (async () => {
          try {
            const modelInput = { ...input,
              onApproval: input.onApproval ?? (request => all(request.threadId)[0]?.onApproval(approvalEnvelope(request))),
              onApprovalResult: input.onApprovalResult ?? ((request, result) => Promise.all(all(request.threadId).map(observer => observer.onResult?.(approvalEnvelope(request), result)))),
              onUserInput: input.onUserInput ?? (request => all(request.threadId)[0]?.onUserInput(inputEnvelope(request))),
              onUserInputResult: input.onUserInputResult ?? ((request, result) => Promise.all(all(request.threadId).map(observer => observer.onUserInputResult?.(inputEnvelope(request), result)))),
            };
            const text = onRun ? await onRun(modelInput, entry) : "Visible answer";
            if (entry.status !== "inProgress") return;
            entry.items.push({ type: "agent_message", role: "assistant", content: text ?? "Visible answer", data: { itemId: "answer", status: "completed" } });
            entry.status = "completed";
            done.resolve({ threadId, turnId, text: text ?? "Visible answer", raw: "" });
          } catch (error) { entry.status = error.status ?? "failed"; done.reject(error); }
        })();
        return watch(entry, { ...input, onTurnStarted: undefined });
      },
      async runQueuedSubmission(input) {
        const entry = [...turns.values()].find(entry => entry.threadId === input.threadId
          && (input.acceptedTurnId ? entry.turnId === input.acceptedTurnId : entry.clientId === input.clientUserMessageId));
        if (!entry) throw fail();
        return watch(entry, input);
      },
      async readTurnActivities(threadId, turnId) {
        const entry = turns.get(turnId);
        if (!entry || entry.threadId !== threadId) throw fail();
        return structuredClone(entry.items);
      },
      async interruptTurn(threadId, turnId) {
        const entry = turns.get(turnId); interrupts.push({ threadId, turnId });
        if (entry?.threadId !== threadId || entry.status !== "inProgress") throw new Error("Exact isolated native turn is not active");
        entry.status = "interrupted";
        entry.done.reject(Object.assign(new Error("Interrupted"), { name: "CodexTurnExecutionError", status: "interrupted" }));
      },
      async observeThreadInteractions(threadId, _hostId, observer, consumer = "gateway") {
        let selected = observers.get(threadId); if (!selected) { selected = new Map(); observers.set(threadId, selected); }
        selected.set(consumer, observer);
      },
      async unobserveThreadInteractions(threadId, _hostId, consumer = "gateway") {
        observers.get(threadId)?.delete(consumer);
      },
      hasRestartBlockingWork() { return false; },
      async close() { closed = true; observers.clear(); detached.reject(fail()); },
    };
  }
  return { client, calls, turns, interrupts, models, skills };
}
