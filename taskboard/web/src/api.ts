import type {
  ActorIdentity,
  AiChatCatalog,
  AiChatAttachmentInput,
  AiChatRun,
  AiChatSandbox,
  AiChatThread,
  AiChatThreadSnapshot,
  AiChatSubmissionStatus,
  Attachment,
  Comment,
  DevelopmentScan,
  IssueRelationType,
  Project,
  Task,
  TaskboardMetadata,
  TaskDraft,
  TaskStatus,
  WorkflowCapabilities,
  WorkflowWorkspaceRecord,
} from "./types";

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

let currentUserActor = DEFAULT_USER_ACTOR;

export function setCurrentUserActor(actor?: ActorIdentity) {
  currentUserActor = actor?.type === "user" ? actor : DEFAULT_USER_ACTOR;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error?.code ?? "REQUEST_FAILED";
    this.details = body.error?.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Taskboard-User-Id", currentUserActor.id);
    headers.set("X-Taskboard-User-Name", encodeURIComponent(currentUserActor.name));
    if (currentUserActor.avatarUrl) {
      headers.set("X-Taskboard-User-Avatar", currentUserActor.avatarUrl);
    }
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(0, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "无法连接本地 Taskboard 服务，请重新通过 Taskboard 启动 Codex。",
      },
    });
  }
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;

  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/api/projects", { signal });
  return data.projects;
}

export async function getTaskboardMetadata(signal?: AbortSignal): Promise<TaskboardMetadata> {
  return request<TaskboardMetadata>("/api/meta", { signal });
}

export async function getTaskboardRevision(
  since: number,
  signal?: AbortSignal,
): Promise<{ changed: boolean; revision: number }> {
  const query = new URLSearchParams({ since: String(since) });
  return request<{ changed: boolean; revision: number }>(`/api/revisions?${query}`, { signal });
}

export async function getAiChatCatalog(
  projectId: string,
  signal?: AbortSignal,
): Promise<AiChatCatalog> {
  return request<AiChatCatalog>(
    `/api/local/ai/catalog?projectId=${encodeURIComponent(projectId)}`,
    { signal },
  );
}

export async function listAiChatThreads(signal?: AbortSignal): Promise<AiChatThread[]> {
  const data = await request<{ threads: AiChatThread[] }>("/api/local/ai/threads", { signal });
  return data.threads;
}

export async function createAiChatThread(input: {
  clientRequestId?: string;
  projectId: string;
  issueId?: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  sandbox?: AiChatSandbox;
}): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread; clientRequestId?: string }>("/api/local/ai/threads", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (typeof data?.thread?.id !== "string" || !data.thread.id || data.thread.origin?.projectId !== input.projectId
    || input.clientRequestId && data.clientRequestId !== input.clientRequestId)
    throw new ApiError(0, { error: { code: "INVALID_ACKNOWLEDGEMENT", message: "本地会话创建回执待核对，未自动重试。" } });
  return data.thread;
}

export async function getAiChatThread(
  threadId: string,
  signal?: AbortSignal,
): Promise<AiChatThreadSnapshot> {
  return request<AiChatThreadSnapshot>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { signal },
  );
}

export async function updateAiChatThread(
  threadId: string,
  input: {
    title?: string;
    model?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  },
): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return data.thread;
}

export async function deleteAiChatThread(threadId: string): Promise<void> {
  await request<void>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { method: "DELETE" },
  );
}

export async function startAiChatTurn(
  threadId: string,
  input: {
    clientRequestId?: string;
    message: string;
    skillIds?: string[];
    attachments?: AiChatAttachmentInput[];
    dangerFullAccessConfirmed?: boolean;
  },
): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun; clientRequestId?: string }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  if (typeof data?.run?.id !== "string" || !data.run.id || data.run.threadId !== threadId
    || !["running", "completed", "failed", "interrupted"].includes(data.run.status)
    || input.clientRequestId && data.clientRequestId !== input.clientRequestId)
    throw new ApiError(0, { error: { code: "INVALID_ACKNOWLEDGEMENT", message: "本地输入回执待核对，未自动重试。" } });
  return data.run;
}

export async function getAiChatSubmission(id: string): Promise<AiChatSubmissionStatus> {
  const value = await request<AiChatSubmissionStatus>(`/api/local/ai/submissions/${encodeURIComponent(id)}`);
  if (value?.clientRequestId !== id || !["unknown", "retired", "acknowledged"].includes(value.status))
    throw new ApiError(0, { error: { code: "INVALID_ACKNOWLEDGEMENT", message: "原提交的核对回执无效，未重发输入。" } });
  return value;
}

export async function interruptAiChatRun(runId: string): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/runs/${encodeURIComponent(runId)}/interrupt`,
    { method: "POST" },
  );
  return data.run;
}

export async function answerAiChatInteraction(threadId: string, id: string, answer: unknown): Promise<void> {
  await request(`/api/local/ai/threads/${encodeURIComponent(threadId)}/interactions/${encodeURIComponent(id)}`, {
    method: "POST", body: JSON.stringify({ answer }),
  });
}

export function subscribeAiChatThread(
  threadId: string,
  onHint: (type: "ai.event" | "ai.run") => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`/api/local/ai/threads/${encodeURIComponent(threadId)}/events`);
  source.addEventListener("ai.event", () => onHint("ai.event"));
  source.addEventListener("ai.run", () => onHint("ai.run"));
  if (onError) source.addEventListener("error", onError);
  return () => source.close();
}

export async function listDeviceWorkspaces(signal?: AbortSignal): Promise<Record<string, string>> {
  try {
    const data = await request<{ workspaces: Record<string, string> }>("/api/device-workspaces", { signal });
    return data.workspaces;
  } catch (error) {
    if (error instanceof ApiError && error.code === "LOCAL_COMPANION_REQUIRED") return {};
    throw error;
  }
}

export async function listWorkflowCapabilities(
  workspacePath?: string,
  signal?: AbortSignal,
): Promise<WorkflowCapabilities> {
  const query = new URLSearchParams();
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<WorkflowCapabilities>(`/api/workflow-capabilities${suffix}`, { signal });
}

export async function getWorkflowWorkspace<T>(
  projectId: string,
  signal?: AbortSignal,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    { signal },
  );
  return data.workflow;
}

export async function saveWorkflowWorkspace<T>(
  projectId: string,
  workspace: T,
  version: number,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    {
      method: "PUT",
      body: JSON.stringify({ version, workspace }),
    },
  );
  return data.workflow;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  version: number;
  status: "running" | "stopping" | "completed" | "failed" | "cancelled" | "uncertain";
  error?: string;
  createdAt: string;
  steps: Record<string, { nodeId: string; title: string; status: string; threadId?: string; error?: string; output?: { text?: string; branch?: boolean } }>;
}

export async function workflowRuns(projectId: string, signal?: AbortSignal): Promise<WorkflowRun[]> {
  return (await request<{ runs: WorkflowRun[] }>(`/api/local/workflow-runs/${encodeURIComponent(projectId)}`, { signal })).runs;
}

export async function startWorkflowRun(projectId: string, input: {
  clientRequestId: string; workflowId: string; version: number; input: { issueId?: string; text?: string; event?: object };
}): Promise<WorkflowRun> {
  return (await request<{ run: WorkflowRun }>(`/api/local/workflow-runs/${encodeURIComponent(projectId)}`,
    { method: "POST", body: JSON.stringify(input) })).run;
}

export async function stopWorkflowRun(projectId: string, id: string): Promise<WorkflowRun> {
  return (await request<{ run: WorkflowRun }>(`/api/local/workflow-runs/${encodeURIComponent(projectId)}/${encodeURIComponent(id)}`,
    { method: "DELETE" })).run;
}

export async function createProject(input: {
  id: string;
  name: string;
  workspacePath: string | null;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function listDevelopmentContexts(
  projectId: string,
  codexProjectId?: string,
  codexThreadId?: string,
  signal?: AbortSignal,
  workspacePath?: string,
): Promise<DevelopmentScan> {
  const query = new URLSearchParams();
  if (codexProjectId) query.set("codexProjectId", codexProjectId);
  if (codexThreadId) query.set("codexThreadId", codexThreadId);
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<DevelopmentScan>(
    `/api/projects/${encodeURIComponent(projectId)}/development-contexts${suffix}`,
    { signal },
  );
}

export async function listTasks(projectId: string, signal?: AbortSignal): Promise<Task[]> {
  const params = new URLSearchParams({ projectId, archived: "false" });
  const data = await request<{ tasks: Task[] }>(`/api/tasks?${params}`, { signal });
  return data.tasks;
}

export async function createTask(projectId: string, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ projectId, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function updateTask(task: Task, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ version: task.version, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function moveTask(
  task: Task,
  status: TaskStatus,
  sortOrder: number,
  threadId?: string,
): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/move`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, status, sortOrder, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function archiveTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function restoreTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function addTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function removeTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function listComments(taskId: string, signal?: AbortSignal): Promise<Comment[]> {
  const data = await request<{ comments: Comment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    { signal },
  );
  return data.comments;
}

export async function createComment(taskId: string, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function updateComment(comment: Comment, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/comments/${encodeURIComponent(comment.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version: comment.version, body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function deleteComment(comment: Comment, threadId?: string): Promise<void> {
  await request(`/api/comments/${encodeURIComponent(comment.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ version: comment.version, ...(threadId ? { threadId } : {}) }),
  });
}

export async function listAttachments(taskId: string, signal?: AbortSignal): Promise<Attachment[]> {
  const data = await request<{ attachments: Attachment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    { signal },
  );
  return data.attachments;
}

export async function uploadAttachment(taskId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function uploadCommentAttachment(commentId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/comments/${encodeURIComponent(commentId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function deleteAttachment(attachment: Attachment): Promise<void> {
  await request(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
    method: "DELETE",
  });
}

export function attachmentContentUrl(attachment: Attachment): string {
  return `/api/attachments/${encodeURIComponent(attachment.id)}/content`;
}
