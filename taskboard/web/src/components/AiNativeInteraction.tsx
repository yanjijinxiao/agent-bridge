import { useState } from "react";
import { answerAiChatInteraction } from "../api";
import type { AiChatInteraction } from "../types";

/** Native choices are actions; copying a label never submits an answer. Secret
 * answers live only in this form until the native response is sent. */
export function AiNativeInteraction({ threadId, request }: { threadId: string; request: AiChatInteraction }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(answer: unknown) {
    setBusy(true); setError("");
    try { await answerAiChatInteraction(threadId, request.id, answer); setValues({}); }
    catch (error) { setError(error instanceof Error ? error.message : "答案未确认，请重新核对。"); setBusy(false); }
  }
  const disabled = busy || request.submitted;
  return <section className="ai-chat-native-interaction" aria-label={request.kind === "approval" ? "原生审批" : "原生提问"}>
    {request.kind === "approval" ? <>
      <p>{request.title}</p>
      {request.command && <pre>{request.command}</pre>}
      <div className="ai-chat-native-actions">{request.options.map(option => <button key={option.id} type="button"
        title={option.description} disabled={disabled} onClick={() => void submit(option.id)}>{option.label}</button>)}</div>
    </> : <form onSubmit={event => {
      event.preventDefault();
      void submit(Object.fromEntries(request.questions.map(question => [question.id,
        { answers: values[question.id] ? [values[question.id]] : [] }])));
    }}>
      {request.questions.map((question, index) => <label key={question.id}>
        <strong>{question.header}</strong><span>{question.question}</span>
        {(question.valueSchema?.enum || question.valueSchema?.type === "boolean") && question.options?.length ? <select disabled={disabled} value={values[question.id] ?? ""}
          onChange={event => setValues(current => ({ ...current, [question.id]: event.target.value }))}>
          <option value="">请选择</option>{question.options.map(option => <option key={option.label} value={option.label}>{option.label}</option>)}
        </select> : <>
          <input disabled={disabled} type={question.isSecret ? "password" : ["number", "integer"].includes(question.valueSchema?.type ?? "") ? "number" : "text"}
            autoComplete="off" value={values[question.id] ?? ""} list={question.options?.length && !question.isSecret ? `native-options-${request.id}-${index}` : undefined}
            minLength={question.valueSchema?.minLength} maxLength={question.valueSchema?.maxLength}
            min={question.valueSchema?.minimum} max={question.valueSchema?.maximum} step={question.valueSchema?.type === "integer" ? 1 : "any"}
            onChange={event => setValues(current => ({ ...current, [question.id]: event.target.value }))} />
          {question.options?.length && !question.isSecret && <datalist id={`native-options-${request.id}-${index}`}>
            {question.options.map(option => <option key={option.label} value={option.label}>{option.description}</option>)}
          </datalist>}
        </>}
      </label>)}
      <button disabled={disabled} type="submit">提交答案</button>
    </form>}
    {disabled && <p role="status">等待原生服务确认</p>}
    {(error || request.error) && <p role="alert">{error || request.error}</p>}
  </section>;
}
