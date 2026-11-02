import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AiChat } from "../../../web/src/components/AiChat";
import { TaskDetail } from "../../../web/src/components/TaskDetail";
import { TaskEditor } from "../../../web/src/components/TaskEditor";
import { TaskCard } from "../../../web/src/components/TaskCard";
import { TaskContextMenu } from "../../../web/src/components/TaskContextMenu";
import { IssueParentLink } from "../../../web/src/components/IssueRelations";
import "../../../web/src/styles.css";

// Isolated component fixture. It renders production React/CSS/API code, but
// records requests locally and never starts Codex, reads a workspace or sends IM.
const audit: any = (window as any).audit = { requests: [], saved: [], releaseSnapshot: () => {}, project: (_id: string) => {} };
const now = new Date().toISOString();
const actor = { type: "user" as const, id: "fixture-user", name: "Fixture User", avatarUrl: null };
const task: any = { id: "task-one", identifier: "TEST-1", projectId: "a", title: "Fixture task", description: "Fixture description",
  status: "todo", priority: "none", labels: [], sortOrder: 0, threadId: null, creatorType: "user", creatorId: actor.id,
  creatorName: actor.name, creatorAvatarUrl: null, assignee: actor, workflowId: null, developmentContext: null,
  dueDate: null, recurrence: null, archivedAt: null, relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
  version: 1, createdAt: now, updatedAt: now };
const comments: any[] = [{ id: "comment-one", taskId: task.id, body: "**Existing comment**", authorType: "user",
  authorId: actor.id, authorName: actor.name, authorAvatarUrl: null, threadId: null, attachments: [], version: 1,
  createdAt: now, updatedAt: now }];
const threads: any[] = [{ id: "thread-a", title: "Existing conversation", origin: { projectId: "a", projectName: "Project A" },
  codexThreadId: "PRIVATE_NATIVE_THREAD", workspacePath: "/PRIVATE_HOST_PATH",
  model: "a-model", reasoningEffort: "high", sandbox: "workspace-write", status: "idle", createdAt: now, updatedAt: now }];
const originalFetch = window.fetch.bind(window);
let holdSnapshot = new URL(location.href).searchParams.has("hold");
const heldSnapshot = new Promise<void>(resolve => { audit.releaseSnapshot = () => { holdSnapshot = false; resolve(); }; });
const events = [
  { id: "public", runId: "previous", role: "assistant", type: "agent_message", content: new URL(location.href).searchParams.has("skillLinks")
    ? "**Public answer** [Invalid reference](#ai-chat-skill-%E0%A4%A) [Truncated reference](#ai-chat-skill-%E0%A4) [Valid reference](#ai-chat-skill-cloudflare)"
    : "**Public answer**" },
  { id: "private", runId: "previous", role: "activity", type: "reasoning", content: "PRIVATE_REASONING_NEVER_VISIBLE" },
  { id: "command", runId: "previous", role: "activity", type: "command_execution", content: "npm test", data: { status: "completed", itemId: "cmd" } },
];
window.fetch = async (input: any, init?: RequestInit) => {
  const url = new URL(String(input), location.href);
  if (!url.pathname.startsWith("/api/")) return originalFetch(input, init);
  const method = init?.method ?? "GET", body = typeof init?.body === "string" ? JSON.parse(init.body)
    : init?.body instanceof File ? { filename: init.body.name, size: init.body.size } : undefined;
  audit.requests.push({ path: url.pathname, search: url.search, method, body });
  const writeKind = method === "POST" && url.pathname === "/api/local/ai/threads" ? "create"
    : method === "POST" && url.pathname.endsWith("/turns") ? "turn"
    : method === "POST" && url.pathname === `/api/tasks/${task.id}/comments` ? "comment" : null;
  if (writeKind && audit.holdWrite === writeKind) {
    audit.holdWrite = null;
    await new Promise<void>(resolve => { audit.releaseWrite = resolve; });
  }
  if (writeKind && audit.failNextWrite === writeKind) {
    audit.failNextWrite = null;
    return new Response(JSON.stringify({ error: { message: "Fixture rejected before execution" } }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  let result: any;
  if (url.pathname === `/api/tasks/${task.id}/comments`) {
    if (method === "GET") result = { comments };
    else { const comment = { ...comments[0], ...body, id: `comment-${comments.length + 1}`, attachments: [] };
      comments.push(comment); result = { comment }; }
  } else if (url.pathname === `/api/tasks/${task.id}/attachments`) result = { attachments: [] };
  else if (/^\/api\/comments\/.+\/attachments$/.test(url.pathname)) {
    const comment = comments.find(c => c.id === url.pathname.split("/")[3]);
    const attachment = { id: `attachment-${comment.attachments.length + 1}`, taskId: task.id, commentId: comment.id,
      filename: body.filename, contentType: init?.headers instanceof Headers ? init.headers.get("Content-Type") : "text/plain",
      size: body.size, createdAt: now };
    comment.attachments.push(attachment); result = { attachment };
  } else if (url.pathname.startsWith("/api/attachments/") && method === "DELETE") {
    for (const c of comments) c.attachments = c.attachments.filter((a: any) => a.id !== url.pathname.split("/")[3]);
    result = {};
  } else if (url.pathname === "/api/local/ai/catalog") {
    const project = url.searchParams.get("projectId") ?? "a", effort = project === "a" ? "high" : "low";
    result = { models: [{ slug: `${project}-model`, displayName: `Model ${project}`, defaultReasoningEffort: effort,
      supportedReasoningEfforts: [effort], serviceTiers: [] }], sandboxes: ["read-only", "workspace-write", "danger-full-access"],
      skills: [{ id: "cloudflare", label: "Cloudflare", description: "Browser test skill", path: "/isolated/skills/cloudflare/SKILL.md", scope: "user" }] };
  } else if (url.pathname === "/api/local/ai/threads" && method === "GET") result = { threads };
  else if (url.pathname === "/api/local/ai/threads" && method === "POST") {
    const thread = { ...threads[0], ...body, id: `thread-${threads.length + 1}`, origin: { projectId: body.projectId, projectName: `Project ${body.projectId}` } };
    threads.push(thread); result = { thread };
  } else if (url.pathname.endsWith("/turns")) {
    const thread = threads.find(thread => thread.id === url.pathname.split("/").at(-2));
    const run = { id: "run", threadId: thread.id, status: "running" };
    thread.status = "running"; thread.currentRun = run;
    result = { run };
  }
  else {
    if (holdSnapshot) await heldSnapshot;
    const thread = threads.find(thread => thread.id === url.pathname.split("/").at(-1));
    result = { thread, events, runs: [] };
  }
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
class LocalEvents extends EventTarget { constructor(_url: string) { super(); } close() {} }
(window as any).EventSource = LocalEvents;
localStorage.setItem("taskboard.aiChat.lastThreadId", "thread-a");
function Fixture() {
  const [project, setProject] = useState("a"); audit.project = setProject; audit.currentProject = project;
  const [menuOpen, setMenuOpen] = useState(true);
  const view = new URL(location.href).searchParams.get("view");
  const shared = { currentUser: actor, workflows: [], developmentScan: { workspacePath: null, contexts: [] }, developmentScanLoading: false };
  if (view === "menu") {
    audit.menuActions ??= [];
    return menuOpen ? <TaskContextMenu task={task} position={{ x: 100, y: 100 }} labels={[]}
      onClose={() => setMenuOpen(false)} onEdit={() => {}} onPriorityChange={() => {}} onLabelsChange={() => {}}
      onDuplicate={() => {}} onCopy={() => {}} onOpenInThread={() => {}} onArchive={() => {}}
      onStatusChange={(_task, status) => audit.menuActions.push(status)} /> : <p>Menu closed</p>;
  }
  if (view === "relations") {
    audit.relations ??= [];
    const candidate = { ...task, id: "task-two", identifier: "TEST-2", title: "Candidate task" };
    return <IssueParentLink task={task} tasks={[task, candidate]} onOpenTask={() => {}}
      onRemoveRelation={async () => ({ task, relatedTask: candidate })}
      onAddRelation={async (_task, type, id) => {
        audit.relations.push({ type, id });
        await new Promise<void>((resolve, reject) => { audit.acceptRelation = resolve; audit.rejectRelation = () => reject(new Error("Fixture rejected relation")); });
        return { task, relatedTask: candidate };
      }} />;
  }
  if (view === "card") return <TaskCard task={{ ...task, dueDate: new URL(location.href).searchParams.get("date") }}
    statusIndex={1} isDragging={false} dragShift={0} isMoving={false} isSettling={false} isContextMenuOpen={false}
    onEdit={() => {}} onContextMenu={() => {}} onMove={() => {}} onDragStart={() => {}} onDragEnd={() => {}} onOpenThread={() => {}} />;
  if (view === "editor") return <TaskEditor {...shared} task={null} initialStatus="todo" labels={[]} onCancel={() => {}}
    onSave={async (draft, files) => { audit.saved.push({ draft, filenames: files.map(f => f.name) }); }} />;
  if (view === "detail") return <TaskDetail {...shared} task={task} tasks={[task]} availableLabels={[]}
    commentsRevision={0} attachmentsRevision={0} onUpdate={async (_t, changes) => ({ ...task, ...changes })}
    onOpenTask={() => {}} onAddRelation={async () => ({ task, relatedTask: task })} onRemoveRelation={async () => ({ task, relatedTask: task })}
    onOpenThread={() => {}} onOpenInThread={() => {}} openingThread={false} onError={() => {}} onAnnounce={() => {}} />;
  return <AiChat available={true} projectId={project} issueId={null} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
