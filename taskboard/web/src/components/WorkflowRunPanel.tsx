import { useEffect, useRef, useState } from "react";
import { ApiError, workflowRuns, startWorkflowRun, stopWorkflowRun, type WorkflowRun } from "../api";

const statusText: Record<string, string> = { running: "执行中", stopping: "停止请求处理中", completed: "已完成", failed: "失败", cancelled: "已停止", prepared: "准备提交", uncertain: "结果待核对" };

/** The submit identity survives an unknown HTTP response. Repeating the button
 * reconciles that same run rather than creating another execution. */
export function WorkflowRunPanel({ projectId, workflowId, version, canRun, triggerKind = "issue-trigger" }: {
  projectId: string; workflowId: string; version: number; canRun: boolean; triggerKind?: string;
}) {
  const [open, setOpen] = useState(false), [issueId, setIssueId] = useState(""), [text, setText] = useState("");
  const [eventText, setEventText] = useState("{}");
  const [runs, setRuns] = useState<WorkflowRun[]>([]), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<Parameters<typeof startWorkflowRun>[1] | null>(null);
  const receiptKey = `taskboard.workflow-submission:${encodeURIComponent(projectId)}:${encodeURIComponent(workflowId)}`;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(receiptKey);
      if (saved) {
        const value = JSON.parse(saved);
        if (value.workflowId === workflowId && typeof value.clientRequestId === "string" && Number.isInteger(value.version) && value.input) {
          pending.current = value; setIssueId(value.input.issueId ?? ""); setText(value.input.text ?? ""); setOpen(true);
          setEventText(JSON.stringify(value.input.event ?? {}, null, 2));
          setError("上次提交的回执尚未确认，可以核对同一运行。");
        }
      }
    } catch { setError("无法读取本机提交记录；请先核对已有运行记录。"); }
  }, [receiptKey, workflowId]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const current = await workflowRuns(projectId, controller.signal);
        if (!controller.signal.aborted) setRuns(current.filter(run => run.workflowId === workflowId));
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 1500);
    };
    if (open) void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, workflowId, open]);
  async function start() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (!pending.current) {
        const event: unknown = triggerKind === "issue-trigger" ? undefined : JSON.parse(eventText);
        if (event !== undefined && (!event || typeof event !== "object" || Array.isArray(event))) throw Error("事件内容必须是 JSON 对象");
        pending.current = { clientRequestId: crypto.randomUUID(), workflowId, version,
          input: { ...(issueId.trim() ? { issueId: issueId.trim() } : {}), text,
            ...(event ? { event: { ...event, kind: triggerKind } } : {}) } };
      }
      // Save before the request, including across page reloads. A storage error
      // stops this handoff rather than silently losing its dedup identity.
      localStorage.setItem(receiptKey, JSON.stringify(pending.current));
      const run = await startWorkflowRun(projectId, pending.current);
      if (!mounted.current) return;
      setRuns(current => [run, ...current.filter(row => row.id !== run.id)]);
      localStorage.removeItem(receiptKey); pending.current = null;
    } catch (err) {
      if (mounted.current) {
        const rejected = err instanceof ApiError && err.status >= 400 && err.status < 500;
        if (rejected) { pending.current = null; try { localStorage.removeItem(receiptKey); } catch { /* No accepted side effect. */ } }
        setError(`${err instanceof Error ? err.message : String(err)}${rejected || !pending.current ? "。修改后可以重新提交。" : "。再次提交会核对同一运行，不会创建重复任务。"}`);
      }
    } finally { if (mounted.current) setBusy(false); }
  }
  return <div className="workflow-run-panel">
    <button type="button" className="button" onClick={() => setOpen(value => !value)} aria-expanded={open}>运行与记录</button>
    {open && <section aria-label="流程执行">
      <div className="workflow-run-form">
        {triggerKind === "issue-trigger" ? <label>触发议题<input aria-label="触发议题" value={issueId} placeholder="议题编号，例如 LOCAL-48" disabled={busy || !!pending.current} onChange={e => setIssueId(e.target.value)} /></label>
          : <label>手动测试事件（JSON）<textarea rows={3} value={eventText} disabled={busy || !!pending.current} onChange={e => setEventText(e.target.value)} /><small>当前为手动事件输入，尚未启用自动订阅。</small></label>}
        <label>本次输入<textarea aria-label="本次输入" value={text} rows={2} disabled={busy || !!pending.current} onChange={e => setText(e.target.value)} /></label>
        <button type="button" className="button" disabled={busy || !canRun && !pending.current} onClick={() => void start()}>{busy ? "正在提交…" : pending.current ? "核对并继续原提交" : "运行已保存的流程"}</button>
        {!canRun && <span>流程保存完成后可以运行。</span>}
      </div>
      {error && <p role="alert" className="comments-error">{error}</p>}
      {runs.length === 0 && <p>还没有运行记录。</p>}
      {runs.map((run, index) => <details key={run.id} open={index === 0 || ["running", "stopping", "uncertain"].includes(run.status)}>
        <summary>{statusText[run.status]} · 版本 {run.version} · {new Date(run.createdAt).toLocaleString()}</summary>
        {run.error && <p role="alert">{run.error}</p>}
        {["running", "uncertain"].includes(run.status) && <button type="button" className="button" onClick={() => {
          void stopWorkflowRun(projectId, run.id).then(updated => { if (mounted.current) setRuns(current => current.map(row => row.id === updated.id ? updated : row)); })
            .catch(err => { if (mounted.current) setError(err.message); });
        }}>停止此运行</button>}
        <ol>{Object.values(run.steps).map(step => <li key={step.nodeId}>
          <strong>{step.title}</strong> · {statusText[step.status] ?? step.status}
          {step.threadId && <button type="button" className="button" onClick={() => window.dispatchEvent(new CustomEvent("taskboard:open-workflow-thread", { detail: { projectId, threadId: step.threadId } }))}>查看对话与审批</button>}
          {step.error && <p>{step.error}</p>}
          {step.output?.branch !== undefined && <p>条件结果：{step.output.branch ? "符合" : "不符合"}</p>}
          {step.output?.text && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{step.output.text}</p>}
        </li>)}</ol>
      </details>)}
    </section>}
  </div>;
}
