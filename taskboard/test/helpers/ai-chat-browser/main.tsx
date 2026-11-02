import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AiChat } from "../../../web/src/components/AiChat";
import { AiNativeInteraction } from "../../../web/src/components/AiNativeInteraction";
import { ProjectAutomationMenu } from "../../../web/src/components/ProjectAutomationMenu";
import { TaskDetail } from "../../../web/src/components/TaskDetail";
import { TaskEditor } from "../../../web/src/components/TaskEditor";
import { TaskCard } from "../../../web/src/components/TaskCard";
import { TaskContextMenu } from "../../../web/src/components/TaskContextMenu";
import { IssueParentLink } from "../../../web/src/components/IssueRelations";
import { App } from "../../../web/src/App";
import { WorkflowBoard } from "../../../web/src/components/WorkflowBoard";
import { paletteData } from "../../../web/src/components/workflowCatalog";
import "../../../web/src/styles.css";

// Isolated component fixture. It renders production React/CSS/API code, but
// records requests locally and never starts Codex, reads a workspace or sends IM.
const audit: any = (window as any).audit = { documentId: crypto.randomUUID(), requests: [], saved: [], releaseSnapshot: () => {}, project: (_id: string) => {} };
if (new URL(location.href).searchParams.get("view") === "automation-host") {
  audit.hostRequests = [];
  localStorage.setItem("taskboard.lastProjectId", "a");
  localStorage.setItem("taskboard.projectAutomations.v1", JSON.stringify({a:{codexProjectId:"a",status:"ACTIVE",enabledByUser:true,quotaAware:false,model:"gpt-5.5",reasoningEffort:"high"}}));
  window.addEventListener("message", event => {
    if (!event.source || event.source === window) return;
    const send = (message: unknown) => (event.source as Window).postMessage(message, location.origin);
    if (event.data?.type === "taskboard:ready") send({type:"taskboard:host-context",payload:{projectId:"a",workspacePath:"/isolated/a",projects:[{id:"a",name:"Project A"}],user:{type:"user",id:"fixture-user",name:"Fixture User",avatarUrl:null}}});
    if (event.data?.type === "taskboard:automation-request") {
      const request=event.data.payload; audit.hostRequests.push(request);
      send({type:"taskboard:automation-response",payload:{ok:true,requestId:request.requestId,policy:{enabledByUser:false,quotaAware:false,model:"gpt-5.5",reasoningEffort:"high"}}});
    }
  });
}
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
const aiSubmissions = new Map<string, any>();
const originalFetch = window.fetch.bind(window);
const appView = new URL(location.href).searchParams.get("view") === "app";
const workflowView = new URL(location.href).searchParams.get("view") === "workflow";
const workflowRecords = new Map<string, any>();
function seededWorkflow() {
  const spec = [["trigger","issue-trigger"],["condition","condition"],["yes","codex-review"],["no","codex-review"],
    ["plan","basic-planning"],["child-one","skill"],["child-two","mcp"],["after","issue-update"]];
  const nodes = spec.map(([id,kind],i)=>({id,type:"workflow",position:{x:0,y:i*180},data:{...paletteData(kind),title:id},
    ...(id.startsWith("child-")?{parentId:"plan"}: {})}));
  const step=(nodeId:string)=>({type:"step",nodeId});
  const flow={version:2,root:{items:[step("trigger"),{type:"condition",nodeId:"condition",branches:{true:{items:[step("yes")]},false:{items:[step("no")]}}},step("plan"),step("after")]}};
  return {version:1,tabs:[{id:"fixture",name:"Fixture workflow"}],activeWorkflowId:"fixture",snapshots:{fixture:{nodes,flow,selectedNodeId:null}}};
}
audit.workflowRecord = (projectId: string) => workflowRecords.get(projectId);
const boardTasks = [task, { ...task, id: "task-b", projectId: "b", identifier: "B-1", title: "Project B only" }];
const boardProjects = ["a", "b"].map(id => ({id, name: `Project ${id.toUpperCase()}`, workspacePath: null,
  issueCount: 1, createdAt: now, updatedAt: now}));
audit.reviseBoard = () => { for (const issue of boardTasks.filter(t=>t.projectId === "a")) {
  issue.title = "Later native change"; issue.version += 1;
} };
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
  if (url.pathname.includes("/interactions/")) {
    if (audit.holdNativeAnswer) await new Promise<void>(resolve => { audit.releaseNativeAnswer = resolve; });
    return Response.json({status:"submitted"}, {status:202});
  }
  if (workflowView) {
    if (url.pathname === "/api/workflow-capabilities") return Response.json({skills:[],mcpServers:[]});
    if (!url.pathname.endsWith("/workflow-workspace")) throw Error("Unexpected workflow fixture request");
    const projectId=url.pathname.split("/")[3];
    const record=workflowRecords.get(projectId) ?? {projectId,version:1,workspace:new URL(location.href).searchParams.has("seed") ? seededWorkflow() : null};
    workflowRecords.set(projectId,record);
    if (method === "GET" && new URL(location.href).searchParams.has("holdWorkflow") && !audit.workflowReleased) {
      await new Promise<void>(resolve=>{audit.releaseWorkflow=()=>{audit.workflowReleased=true;resolve();};});
    }
    if (method === "PUT") {
      if (audit.holdWorkflowSave) {audit.holdWorkflowSave=false;await new Promise<void>(resolve=>{audit.releaseWorkflowSave=resolve;});}
      if (audit.conflictWorkflowNext || body.version !== record.version) {
        if (audit.conflictWorkflowNext) {
          record.workspace=structuredClone(record.workspace ?? body.workspace);
          record.workspace.tabs[0].name="Remote workflow";
          record.version+=1; audit.conflictWorkflowNext=false;
        }
        return Response.json({error:{code:"VERSION_CONFLICT",message:"Fixture workflow changed"}},{status:409});
      }
      record.workspace=structuredClone(body.workspace);record.version+=1;
    }
    return Response.json({workflow:record});
  }
  if (appView) {
    let result: any;
    if (url.pathname === "/api/projects") result = {projects: boardProjects};
    else if (url.pathname === "/api/meta") result = {mode: "local", manageTaskboardSkillPath:"/isolated/skill.md", capabilities: {localAiChat: false}};
    else if (url.pathname === "/api/device-workspaces") result = {workspaces:{}};
    else if (url.pathname.endsWith("/workflow-workspace")) result = {workflow:{workspace:null,version:1}};
    else if (url.pathname.endsWith("/development-contexts")) result = {workspacePath:null, contexts:[]};
    else if (url.pathname === "/api/revisions") result = {changed:false,revision:1};
    else if (url.pathname === "/api/tasks" && method === "GET") result = {tasks: boardTasks.filter(t=>t.projectId===url.searchParams.get("projectId") && !t.archivedAt)};
    else if (url.pathname === "/api/tasks" && method === "POST") {
      const created = {...task,...body,id:`created-${boardTasks.length}`,identifier:`A-${boardTasks.length}`,version:1};
      boardTasks.push(created); result={task:{...created}};
      if (audit.dropCreateAck) { audit.dropCreateAck=false; throw new TypeError("Fixture lost create response"); }
    } else if (/^\/api\/tasks\/[^/]+\/attachments$/.test(url.pathname) && method === "POST") {
      if (audit.failUpload === body?.filename) {
        audit.failUpload=null;
        return new Response(JSON.stringify({error:{message:"Fixture rejected attachment"}}),{status:400,headers:{"Content-Type":"application/json"}});
      }
      result={attachment:{id:`board-file-${audit.requests.filter((r:any)=>r.body?.filename).length}`,taskId:url.pathname.split("/")[3],
        filename:body.filename,size:body.size,contentType:"application/octet-stream",createdAt:now}};
    } else if (url.pathname.startsWith("/api/tasks/")) {
      const current=boardTasks.find(t=>t.id===url.pathname.split("/")[3]);
      if (!current) throw Error("Fixture unknown task");
      if (url.pathname.endsWith("/archive")) Object.assign(current,{archivedAt:now,version:current.version+1});
      else if (url.pathname.endsWith("/restore")) Object.assign(current,{archivedAt:null,version:current.version+1});
      else if (method === "PATCH") Object.assign(current,body,{version:current.version+1});
      result={task:{...current}};
    } else throw Error(`Unsupported isolated App request ${method} ${url.pathname}`);
    if (method !== "GET" && audit.holdBoardWrite) {
      audit.holdBoardWrite=false;
      await new Promise<void>(resolve=>{audit.releaseBoardWrite=resolve;});
    }
    return new Response(JSON.stringify(result),{headers:{"Content-Type":"application/json"}});
  }
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
  if (/^\/api\/comments\/.+\/attachments$/.test(url.pathname) && method === "POST" && audit.failUpload === body?.filename) {
    audit.failUpload = null;
    return new Response(JSON.stringify({ error: { message: "Fixture rejected attachment" } }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  let result: any;
  if (url.pathname === `/api/tasks/${task.id}/comments`) {
    if (method === "GET") result = { comments };
    else { const comment = { ...comments[0], ...body, id: `comment-${comments.length + 1}`, attachments: [] };
      comments.push(comment); result = { comment };
      if (audit.dropCommentAck) { audit.dropCommentAck = false; throw new TypeError("Fixture lost comment response"); }
    }
  } else if (url.pathname === `/api/tasks/${task.id}/attachments`) result = { attachments: [] };
  else if (/^\/api\/comments\/[^/]+$/.test(url.pathname) && method === "PATCH") {
    const comment = comments.find(c => c.id === url.pathname.split("/")[3]);
    Object.assign(comment, { body: body.body, version: comment.version + 1 }); result = { comment };
  }
  else if (/^\/api\/comments\/.+\/attachments$/.test(url.pathname)) {
    const comment = comments.find(c => c.id === url.pathname.split("/")[3]);
    const attachment = { id: `attachment-${comment.attachments.length + 1}`, taskId: task.id, commentId: comment.id,
      filename: body.filename, contentType: init?.headers instanceof Headers ? init.headers.get("Content-Type") : "text/plain",
      size: body.size, createdAt: now };
    comment.attachments.push(attachment); result = { attachment };
    if (audit.dropUploadAck) { audit.dropUploadAck = false; throw new TypeError("Fixture lost attachment response"); }
  } else if (url.pathname.startsWith("/api/attachments/") && method === "DELETE") {
    for (const c of comments) c.attachments = c.attachments.filter((a: any) => a.id !== url.pathname.split("/")[3]);
    result = {};
  } else if (url.pathname === "/api/local/ai/catalog") {
    const project = url.searchParams.get("projectId") ?? "a", effort = project === "a" ? "high" : "low";
    result = { models: [{ slug: `${project}-model`, displayName: `Model ${project}`, defaultReasoningEffort: effort,
      supportedReasoningEfforts: [effort], serviceTiers: [] }], sandboxes: ["read-only", "workspace-write", "danger-full-access"],
      skills: [{ id: "cloudflare", label: "Cloudflare", description: "Browser test skill", path: "/isolated/skills/cloudflare/SKILL.md", scope: "user" }] };
  } else if (url.pathname.startsWith("/api/local/ai/submissions/")) {
    const id = url.pathname.split("/").at(-1)!;
    result = audit.submissionUnknown ? {clientRequestId:id,status:"unknown"} : aiSubmissions.get(id) ?? {clientRequestId:id,status:"unknown"};
  } else if (url.pathname === "/api/local/ai/threads" && method === "GET") result = { threads };
  else if (url.pathname === "/api/local/ai/threads" && method === "POST") {
    const thread = { ...threads[0], ...body, id: `thread-${threads.length + 1}`, origin: { projectId: body.projectId, projectName: `Project ${body.projectId}` } };
    threads.push(thread); result = { thread, clientRequestId: body.clientRequestId };
    aiSubmissions.set(body.clientRequestId, {clientRequestId:body.clientRequestId,status:"acknowledged",kind:"thread",scope:body.projectId,thread});
    if (audit.dropThreadAck) { audit.dropThreadAck=false; throw new TypeError("Fixture lost thread acknowledgement"); }
  } else if (url.pathname.endsWith("/turns")) {
    const thread = threads.find(thread => thread.id === url.pathname.split("/").at(-2));
    const run = { id: "run", threadId: thread.id, status: "running" };
    thread.status = "running"; thread.currentRun = run;
    aiSubmissions.set(body.clientRequestId, {clientRequestId:body.clientRequestId,status:"acknowledged",kind:"turn",scope:thread.id,run});
    if (audit.dropTurnAck) {
      audit.dropTurnAck = false;
      thread.status = "idle"; thread.currentRun = null; run.status = "completed";
      throw new TypeError("Fixture completed native turn but lost HTTP acknowledgement");
    }
    result = { run, clientRequestId: body.clientRequestId };
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
if(new URL(location.href).searchParams.has("storageFull")){
  const native=Storage.prototype.setItem; audit.storageFull=true;
  Storage.prototype.setItem=function(key,value){if(audit.storageFull && key.startsWith("taskboard."))throw new DOMException("Fixture full","QuotaExceededError");return native.call(this,key,value);};
}
function Fixture() {
  const [project, setProject] = useState("a"); audit.project = setProject; audit.currentProject = project;
  const [menuOpen, setMenuOpen] = useState(true);
  const [detailInstance, setDetailInstance] = useState<number | null>(0);
  audit.hideDetail = () => setDetailInstance(null);
  audit.remountDetail = () => setDetailInstance(value => (value ?? 0) + 1);
  const view = new URL(location.href).searchParams.get("view");
  if (view === "automation-host") return <iframe title="Isolated hosted App" src="/?view=app&host=codex&project=a" style={{height:"100vh",width:"100%",border:0}} />;
  if (view === "automation-menu") return <ProjectAutomationMenu projectId="a" pending={false} error={null} unavailableReason={null}
    onOpen={()=>{}} onChange={value=>audit.saved.push(value)} />;
  if (view === "native") return <div style={{maxWidth:420,padding:16}}>
    <AiNativeInteraction threadId="thread-a" request={{id:"approval",runId:"run-a",kind:"approval",title:"Native command approval",command:"npm test",
      options:[{id:"accept",label:"允许一次",description:"Only this native request"},{id:"cancel",label:"取消本次",description:"Cancel this native request"}]}} />
    <AiNativeInteraction threadId="thread-a" request={{id:"question",runId:"run-a",kind:"user-input",questions:[
      {id:"choice",header:"Native choice",question:"Choose or enter an answer",options:[{label:"A",description:"First"},{label:"B",description:"Second"}]},
      {id:"secret",header:"Native secret",question:"Isolated secret field",isSecret:true}]}} />
  </div>;
  if (view === "app") return <App />;
  const shared = { currentUser: actor, workflows: [], developmentScan: { workspacePath: null, contexts: [] }, developmentScanLoading: false };
  if (view === "workflow") return <div style={{height:"100vh",display:"flex",flexDirection:"column"}}><WorkflowBoard projectId={project} projectName={`Project ${project}`} revision={0} onWorkflowsChange={workflows=>{audit.workflowOptions=workflows;}} /></div>;
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
  const detail = (key: number) => <TaskDetail key={key} {...shared} task={task} tasks={[task]} availableLabels={[]}
    commentsRevision={0} attachmentsRevision={0} onUpdate={async (_t, changes) => ({ ...task, ...changes })}
    onOpenTask={() => {}} onAddRelation={async () => ({ task, relatedTask: task })} onRemoveRelation={async () => ({ task, relatedTask: task })}
    onOpenThread={() => {}} onOpenInThread={() => {}} openingThread={false} onError={() => {}} onAnnounce={() => {}} />;
  if (view === "detail") return detailInstance === null ? <p>Detail closed</p> : detail(detailInstance);
  if (view === "dual-detail") return <><div data-pane="first">{detail(1)}</div><div data-pane="second">{detail(2)}</div></>;
  return <AiChat available={true} projectId={project} issueId={null} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
