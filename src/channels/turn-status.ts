/** Presentation facts, never inferred from model text, silence or stream closure. */
export type TurnActivity = "running" | "waiting-input" | "waiting-approval" | "recovering" | "unconfirmed" | "waiting-result";
export type TurnOutcome = "completed" | "failed" | "interrupted" | "continued" | "detached" | "session-restored" | "session-unconfirmed";

const labels: Record<TurnActivity | TurnOutcome, string> = {
  running: "进行中",
  "waiting-input": "等你回答",
  "waiting-approval": "等待审批",
  recovering: "正在恢复执行",
  unconfirmed: "执行状态待确认",
  "waiting-result": "任务已结束，结果待同步",
  completed: "已完成",
  failed: "执行失败",
  interrupted: "已中断",
  continued: "已转入后续卡片",
  detached: "已停止同步（任务未停止）",
  "session-restored": "会话已恢复（原任务未重试）",
  "session-unconfirmed": "会话恢复未确认"
};

export function turnStatusHeading(status: TurnActivity | TurnOutcome): string {
  return `**${labels[status]}**`;
}
export function withTurnStatus(text: string, status: TurnActivity | TurnOutcome): string {
  return `${turnStatusHeading(status)}\n\n${text}`;
}
/** Preserve the pre-compact header reserve so already acknowledged result-page
 * boundaries never shift after an upgrade, even though the new strip is smaller. */
export const TURN_STATUS_BYTES = Math.max(...Object.keys(labels).map(status =>
  Buffer.byteLength(withTurnStatus("", status as TurnActivity | TurnOutcome))),
  Buffer.byteLength("## ⏸️ 已停止同步（任务未停止）\n\n---\n\n"));
