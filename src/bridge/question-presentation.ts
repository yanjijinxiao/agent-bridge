import { parseUserInputResultReason } from "../codex/user-input-result.js";

/** Type comes from the native request, never from its prose or elapsed time. */
export function questionTypeLabel(kind?: "sync" | "async"): string {
  return kind === "sync" ? "同步提问" : kind === "async" ? "异步提问" : "提问类型未记录";
}

export function questionTypeExplanation(kind?: "sync" | "async"): string {
  return kind === "sync" ? "当前提问步骤等待回答后继续。"
    : kind === "async" ? "提问不阻塞执行，当前轮次可以继续推进。"
    : "旧记录未保存提问类型，请以 Codex 当前状态为准。";
}

/** One wording for card updates, plain notifications and rejected late replies.
 * Unknown/legacy metadata is never evidence of an answer, expiry or timeout. */
export function questionWithdrawalText(id: string, value: unknown): string {
  const reason = parseUserInputResultReason(value);
  const detail = reason === "turn-terminal" ? "所属轮次已结束，当前问题不再接受回答。"
    : reason === "turn-replaced" ? "原轮次已被新轮次替代，当前问题不再接受回答。"
    : reason === "accepted-elsewhere" ? "此问题已在其他入口回答并获 Codex 接收，当前入口不再接受回答。"
    : reason === "answer-selected-elsewhere" ? "回答已由其他入口提交，接收状态仍待确认，当前入口不再接受回答。"
    : reason === "widget-removed" ? "原生界面已移除此问题；未确认是否在其他入口作答。"
    : reason === "widget-replaced" ? "原生问题已更新，请使用最新问题回答。"
    : reason === "source-changed" ? "原生问题的来源或内容已变化，旧问题不再接受回答。"
    : reason === "connection-lost" ? "原生回答连接已断开，当前入口无法继续回答；未确认原生问题是否仍有效。"
    : reason === "observer-suspended" || reason === "observer-replaced" ? "原生回答连接已暂停或被替换，当前入口无法继续回答；未确认原生问题是否仍有效。"
    : reason === "request-resolved" ? "原生请求已结束，但未返回具体处理方式；未确认是否在其他入口作答。"
    : reason === "timeout" ? "已达到此问题设置的回答时限，当前入口不再接受回答。"
    : reason === "binding-changed" ? "聊天绑定已切换，当前入口不再接受此问题的回答。"
    : "当前入口已失效，但未记录具体原因；未确认是否已回答或超时，请在 Codex 核对。";
  return `问题 ${id}：${detail}`;
}
