import { createHash } from "node:crypto";
import { ApiError } from "./database.mjs";
import { isWorkflowTriggerKind } from "../shared/workflow-control-flow.mjs";

const statuses = new Set(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]);
const priorities = new Set(["none", "urgent", "high", "medium", "low"]);
const actor = { type: "agent", id: "workflow", name: "Workflow", avatarUrl: null };
const labels = value => [...new Set(String(value ?? "").split(/[,，\n]/).map(x => x.trim()).filter(Boolean))];
const requireValue = (value, message) => { if (!value) throw new ApiError(400, "WORKFLOW_NODE_CONFIG", message); return value; };
export const isLocalWorkflowNode = kind => isWorkflowTriggerKind(kind) || ["condition", "issue-create", "issue-update"].includes(kind);

/** Pure conditions consume the selected path's actual output. Issue mutations
 * use the existing transaction-backed submission receipt, so a restart between
 * the business commit and the workflow projection never repeats a comment. */
export function executeLocalWorkflowNode({ database, run, node, context, emit = () => {} }) {
  const d = node.data;
  if (isWorkflowTriggerKind(d.kind)) {
    if (d.kind === "issue-trigger") {
      const issue = database.getTask(requireValue(run.input.issueId, "Choose an issue for this trigger"));
      requireValue(issue && issue.projectId === run.projectId && !issue.archivedAt, "The trigger issue is not active in this project");
      requireValue(!d.triggerStatus || issue.status === d.triggerStatus, "The issue does not match the trigger status");
      return { issue, text: [issue.description || issue.title, run.input.text].filter(Boolean).join("\n\n") };
    }
    requireValue(run.input.event?.kind === d.kind, `An event of type ${d.kind} is required`);
    if (d.kind === "rss-trigger") requireValue(d.rssFeedUrl && run.input.event.feedUrl === d.rssFeedUrl, "RSS event does not match the configured feed");
    return { event: run.input.event, text: [JSON.stringify(run.input.event), run.input.text].filter(Boolean).join("\n\n") };
  }
  if (d.kind === "condition") {
    const values = { "issue-status": context.issue?.status, "issue-priority": context.issue?.priority,
      "issue-labels": context.issue?.labels, "upstream-output": context.text ?? "" };
    requireValue(Object.hasOwn(values, d.conditionField), "Choose a valid condition field");
    const value = values[d.conditionField], target = d.conditionValue ?? "";
    requireValue(value !== undefined, "This condition needs an issue from the selected path");
    const allowed = d.conditionField === "issue-labels" ? ["contains", "not-contains"]
      : d.conditionField === "upstream-output" ? ["equals", "not-equals", "contains", "not-contains"] : ["equals", "not-equals"];
    requireValue(allowed.includes(d.conditionOperator), "Choose a valid condition operator");
    const equal = value === target, contains = Array.isArray(value) ? value.includes(target) : String(value).includes(target);
    return { branch: ({ equals: equal, "not-equals": !equal, contains, "not-contains": !contains })[d.conditionOperator], text: context.text ?? "" };
  }
  const submission = { id: createHash("sha256").update(JSON.stringify([run.id, node.id])).digest("hex"),
    fingerprint: createHash("sha256").update(JSON.stringify([run.projectId, d, context])).digest("hex") };
  const { value } = database.runTaskSubmission(submission, () => {
    if (d.kind === "issue-create") {
      const title = requireValue(d.createIssueTitle?.trim(), "Issue title is required");
      requireValue(title.length <= 240, "Issue title is too long");
      const status = d.createIssueStatus ?? "backlog", priority = d.createIssuePriority ?? "none";
      requireValue(statuses.has(status) && priorities.has(priority), "Choose valid issue status and priority");
      return { task: database.createTask({ projectId: run.projectId, title,
        description: d.createIssueDescription || context.text || "", status, priority, labels: labels(d.createIssueLabels),
        actor, assignee: actor, workflowId: null, dueDate: null }) };
    }
    const target = d.issueTarget === "specific" ? d.specificIssueId
      : d.issueTarget === "upstream" ? context.issue?.id : context.triggerIssue?.id;
    const issue = database.getTask(requireValue(target, "Choose the issue to update"));
    requireValue(issue && issue.projectId === run.projectId && !issue.archivedAt, "The target issue is not active in this project");
    const changes = {};
    if (d.changeStatus) { requireValue(statuses.has(d.targetStatus), "Choose a valid issue status"); changes.status = d.targetStatus; }
    if (d.setPriority) { requireValue(priorities.has(d.targetPriority), "Choose a valid priority"); changes.priority = d.targetPriority; }
    if (d.addLabels) changes.labels = [...new Set([...issue.labels, ...labels(d.labelsToAdd)])];
    // An unchecked capability must never silently succeed. Artifacts need an
    // explicit verified file output; text mentioning a path is not one.
    requireValue(!d.attachArtifacts, "Artifact attachment execution is not available yet; no issue changes were applied");
    const threadId = d.recordConversation ? requireValue(context.nativeThreadId, "No native conversation is available on this path") : undefined;
    requireValue(Object.keys(changes).length || d.addComment || threadId, "Choose an issue update action");
    const task = Object.keys(changes).length || threadId ? database.updateTask(issue.id, issue.version, changes, threadId) : issue;
    const body = d.commentSource === "custom" ? d.customComment
      : d.commentSource === "run-summary" ? Object.values(run.steps).filter(s => s.status === "completed").map(s => `${s.title}: ${s.output?.text ?? ""}`).join("\n") : context.text;
    const comment = d.addComment ? database.createComment(issue.id, { body: requireValue(body?.trim(), "Comment is empty"), actor, threadId }) : undefined;
    return { task, ...(comment ? { comment } : {}) };
  });
  // Replayed invalidations are harmless and also cover a process crash between
  // the committed mutation and its first UI notification.
  emit(d.kind === "issue-create" ? "task.created" : "task.updated", { task: value.task });
  if (value.comment) emit("comment.created", { comment: value.comment, taskId: value.task.id });
  return { issue: value.task, ...(value.comment ? { comment: value.comment } : {}), text: value.task.identifier };
}
