/** Automatic review is a native notification, not a human approval request.
 * Only closed status labels are public; action arguments and reviewer details
 * can contain private data and never belong in a generic progress notice. */
export function automaticApprovalProgress(method: string, params: Record<string, unknown>): string | undefined {
  if (method !== "item/autoApprovalReview/started" && method !== "item/autoApprovalReview/completed") return;
  if (typeof params.reviewId !== "string" || !params.reviewId.trim()) return;
  const review = params.review;
  if (!review || typeof review !== "object" || Array.isArray(review)) return;
  const status = (review as Record<string, unknown>).status;
  if (method === "item/autoApprovalReview/started") return status === "inProgress"
    ? "Codex 正在自动审核操作权限；这不是发给你的人工审批。" : undefined;
  switch (status) {
    case "approved": return "Codex 自动审核已通过；操作是否完成以执行结果为准。";
    case "denied": return "Codex 自动审核拒绝了本次操作；这不是等待你审批，任务是否继续以原生状态为准。";
    case "timedOut": return "Codex 自动审核超时；尚未确认本次操作获准。";
    case "aborted": return "Codex 自动审核已停止；尚未确认本次操作获准。";
    default: return;
  }
}
