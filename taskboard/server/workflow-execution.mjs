import { randomUUID } from "node:crypto";
import { ApiError } from "./database.mjs";
import { WorkflowRunStore } from "./workflow-runs.mjs";
import { executeLocalWorkflowNode, isLocalWorkflowNode } from "./workflow-local-nodes.mjs";
import { normalizeWorkflowSnapshot, isWorkflowTriggerKind } from "../shared/workflow-control-flow.mjs";
import { readCommandNodeResult } from "./workflow-command-nodes.mjs";
import { isHttpWorkflowNode } from "./workflow-http-nodes.mjs";

/** One scheduler, one canonical tree, one native executor. A stopped Gateway
 * releases observation; accepted node turns belong to the independent core. */
export class WorkflowExecutionService {
  constructor({ database, aiChat, prepareNativeNode, httpNodes, assertDataAuthority = async () => {}, emit = () => {} }) {
    this.database = database; this.aiChat = aiChat; this.prepareNativeNode = prepareNativeNode;
    this.store = new WorkflowRunStore(database); this.emit = emit;
    this.httpNodes = httpNodes;
    this.assertDataAuthority = assertDataAuthority;
    this.localHandoffs = 0;
    this.active = new Map(); this.closed = false; this.paused = false; this.timer = undefined;
  }

  get(id, projectId) {
    const run = this.store.get(id);
    if (!run || projectId !== undefined && run.projectId !== projectId)
      throw new ApiError(404, "WORKFLOW_RUN_NOT_FOUND", "Workflow run does not exist in this project");
    return run;
  }

  start({ projectId, workflowId, version, clientRequestId, input = {} }) {
    if (this.closed || this.paused) throw new ApiError(503, "WORKFLOW_PAUSED", "Workflow handoffs are paused");
    const previous = this.store.get(clientRequestId);
    if (previous) {
      const accepted = this.store.create({ id: clientRequestId, projectId, workflowId, version, input, snapshot: previous.snapshot });
      this.wake(accepted.id);
      return accepted;
    }
    const workspace = this.database.getWorkflowWorkspace(projectId);
    if (workspace.version !== version) throw new ApiError(409, "VERSION_CONFLICT", "Save or reload the workflow before running it");
    const snapshot = workspace.workspace?.snapshots?.[workflowId];
    if (!snapshot) throw new ApiError(404, "WORKFLOW_NOT_FOUND", "Workflow does not exist");
    const normalized = normalizeWorkflowSnapshot(snapshot);
    if (!normalized.flow.root.items.length) throw new ApiError(400, "WORKFLOW_EMPTY", "Add a trigger and steps before running this workflow");
    for (const node of normalized.nodes) {
      if (["__proto__", "constructor", "prototype"].includes(node.id))
        throw new ApiError(400, "WORKFLOW_NODE_ID", "This node identity is reserved; recreate the node");
      if (node.parentId && (node.data.kind === "condition" || isWorkflowTriggerKind(node.data.kind)))
        throw new ApiError(400, "WORKFLOW_NODE_PLACEMENT", "Triggers and conditions must belong to the control-flow tree");
    }
    const run = this.store.create({ id: clientRequestId, projectId, workflowId, version, input,
      snapshot: { nodes: normalized.nodes, flow: normalized.flow } });
    this.wake(run.id);
    return run;
  }

  update(id, mutate) {
    const run = this.store.update(id, mutate);
    this.emit("workflow.run", { projectId: run.projectId, runId: id, status: run.status });
    return run;
  }

  recover() {
    if (this.closed || this.paused) return;
    this.aiChat?.recover();
    for (const run of this.store.active()) this.wake(run.id);
  }

  scheduleRecovery() {
    if (this.closed || this.paused || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.recover(); }
      catch (error) {
        console.error("Workflow receipt recovery failed:", error.message);
        // A failed database/catalog read must not permanently lose the only
        // recovery wakeup for already accepted work.
        this.scheduleRecovery();
      }
    }, 1000);
    this.timer.unref?.();
  }

  wake(id) {
    if (this.closed || this.paused || this.active.has(id)) return;
    const work = Promise.resolve().then(() => this.advance(id)).catch(error => {
      // Observation/receipt reads are not evidence that the native task failed.
      // Preserve the run and retry reconciliation; only an executor's concrete
      // terminal outcome below may finish it.
      if (!this.closed) this.update(id, run => { run.error = String(error.message).slice(0,4096); });
    }).finally(() => {
      this.active.delete(id);
      this.scheduleRecovery();
    });
    void work.catch(error => console.error("Workflow state persistence failed:", error.message));
    this.active.set(id, work);
  }

  async advance(id) {
    await this.assertDataAuthority();
    const initial = this.get(id);
    if (!["running", "stopping"].includes(initial.status)) return;
    const nodes = new Map(initial.snapshot.nodes.map(node => [node.id, node]));
    let context = { text: initial.input.text ?? "" };
    const execute = async node => {
      if (this.closed || this.paused) return false;
      let run = this.get(id), step = run.steps[node.id];
      if (step && !step.aiRunId && !isLocalWorkflowNode(node.data.kind) && !isHttpWorkflowNode(node.data.kind)) {
        const receipt = this.aiChat.getSubmission(step.turnRequestId);
        if (receipt.status === "acknowledged" && receipt.kind === "turn") {
          run = this.update(id, r => Object.assign(r.steps[node.id], { threadId: receipt.run.threadId, aiRunId: receipt.run.id, status: "running" }));
          step = run.steps[node.id];
        } else if (receipt.status === "retired") throw new Error("Original node submission was retired; no replacement was started");
      }
      if (step?.status === "completed") {
        context = { ...context, ...step.output };
        if (isWorkflowTriggerKind(node.data.kind) && step.output.issue) context.triggerIssue = step.output.issue;
        return true;
      }
      if (run.status === "stopping") {
        if (step?.http && step.http.phase !== "received") {
          this.update(id, r => { r.status = "cancelled"; r.error = "已停止后续流程；已发出的外部请求无法撤销，其结果仍待核对。"; }); return false;
        }
        if (step?.aiRunId && this.aiChat.getRun(step.aiRunId).status === "running") {
          if (!step.stopDispatched) {
            try {
              await this.aiChat.interrupt(step.aiRunId);
              if (this.closed) return false;
              this.update(id, r => { r.steps[node.id].stopDispatched = true; delete r.error; });
            } catch (error) {
              if (!this.closed) this.update(id, r => { r.error = `停止请求尚未确认：${String(error.message).slice(0,3000)}`; });
            }
          }
          return false;
        }
        this.update(id, r => { r.status = "cancelled"; }); return false;
      }
      if (run.status !== "running") return false;
      if (!step) {
        run = this.update(id, r => { r.steps[node.id] = { nodeId: node.id, kind: node.data.kind,
          title: node.data.displayTitle || node.data.title || node.data.kind, status: "prepared",
          threadRequestId: randomUUID(), turnRequestId: randomUUID(), input: context }; });
        step = run.steps[node.id];
      }
      let output, observingNative = false;
      try {
        if (isLocalWorkflowNode(node.data.kind)) {
          output = executeLocalWorkflowNode({ database: this.database, run, node, context: step.input, emit: this.emit });
        } else if (isHttpWorkflowNode(node.data.kind)) {
          if (!this.httpNodes) throw new Error("External provider executor is not configured");
          this.localHandoffs++;
          try {
            output = await this.httpNodes.advance({ run, node, step,
              update: mutate => this.update(id, r => mutate(r.steps[node.id])),
              isCurrent: (requireRunning = true) => !this.closed && (!requireRunning || !this.paused && this.get(id).status === "running") });
          } finally { this.localHandoffs--; }
          if (!output) {
            if (!this.closed && this.get(id).steps[node.id].status === "uncertain")
              this.update(id, r => { r.status = "uncertain"; r.error = r.steps[node.id].error; });
            return false;
          }
        } else {
          let threadId = step.threadId, aiRunId = step.aiRunId;
          if (!aiRunId) {
            if (!this.prepareNativeNode) throw new Error(`No executor configured for ${node.data.kind}`);
            // Preparation is pure and validates the exact kind. It must not start
            // a process or create a provider job before the durable handoff.
            const operation = await this.prepareNativeNode({ run, node, context: step.input });
            if (this.closed || this.paused || this.get(id).status !== "running") return false;
            if (operation.commands) this.update(id, r => { r.steps[node.id].commands = operation.commands; });
            const thread = await this.aiChat.createThread({ projectId: run.projectId, title: `流程 · ${step.title}`,
              clientRequestId: step.threadRequestId, sandbox: "workspace-write", ...operation.thread });
            if (this.closed || this.paused || this.get(id).status !== "running") return false;
            // AiChat persists its submission before contacting the core. Reusing
            // this UUID returns that run, including a lost acceptance response.
            const aiRun = await this.aiChat.startTurn(thread.id, { ...operation.turn, clientRequestId: step.turnRequestId });
            if (this.closed) return false;
            this.update(id, r => Object.assign(r.steps[node.id], { threadId: thread.id, aiRunId: aiRun.id, status: "running" }));
            threadId = thread.id; aiRunId = aiRun.id;
          }
          // Failure to read a durable receipt is not the native task's result.
          // Let the outer recovery loop retry that read without changing the
          // accepted node into a terminal failure.
          observingNative = true;
          const current = this.aiChat.getRun(aiRunId);
          if (current.status === "running") {
            this.update(id, r => { r.steps[node.id].error = current.error || undefined; });
            return false;
          }
          if (current.status !== "completed") {
            observingNative = false;
            throw new Error(current.error || `Native node ${current.status}`);
          }
          const events = this.database.listAiChatEvents(threadId).filter(event => event.runId === aiRunId);
          const text = events.filter(event => event.role === "assistant").at(-1)?.content ?? "";
          const commands = this.get(id).steps[node.id].commands;
          const nativeThreadId = this.database.getAiChatNativeReceipt(aiRunId)?.nativeThreadId;
          observingNative = false;
          output = { ...(commands ? readCommandNodeResult(text, commands, events) : { text }), threadId, nativeRunId: aiRunId,
            nativeThreadId };
        }
      } catch (error) {
        if (this.closed) return false;
        if (observingNative) throw error;
        this.update(id, r => { r.steps[node.id].status = "failed"; r.steps[node.id].error = String(error.message).slice(0,4096);
          r.status = "failed"; r.error = r.steps[node.id].error; });
        return false;
      }
      if (this.closed) return false;
      this.update(id, r => { Object.assign(r.steps[node.id], { status: "completed", output }); delete r.steps[node.id].error; delete r.error; });
      context = { ...context, ...output };
      if (isWorkflowTriggerKind(node.data.kind) && output.issue) context.triggerIssue = output.issue;
      return true;
    };
    const children = async parentId => {
      for (const node of initial.snapshot.nodes.filter(node => node.parentId === parentId)
        .sort((left, right) => left.position.y - right.position.y)) {
        if (!await execute(node) || !await children(node.id)) return false;
      }
      return true;
    };
    const walk = async sequence => {
      for (const item of sequence.items) {
        const node = nodes.get(item.nodeId);
        if (!await execute(node) || !await children(node.id)) return false;
        if (item.type === "condition") {
          const branch = this.get(id).steps[node.id].output.branch;
          if (!await walk(item.branches[String(branch)])) return false;
        }
      }
      return true;
    };
    if (await walk(initial.snapshot.flow.root) && !this.closed) this.update(id, run => { run.status = run.status === "stopping" ? "cancelled" : "completed"; });
  }

  async stop(id, projectId) {
    const run = this.get(id, projectId);
    if (!["running", "uncertain"].includes(run.status)) return run;
    this.update(id, r => { r.status = "stopping"; });
    this.wake(id); return this.get(id);
  }

  pauseForRestart() { this.paused = true; clearTimeout(this.timer); this.timer = undefined; }
  resumeAfterCancelledRestart() { this.paused = false; this.recover(); }
  close() { this.closed = true; clearTimeout(this.timer); this.timer = undefined; }
}
