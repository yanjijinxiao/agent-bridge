export const TASK_STATUSES: readonly ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];
export const TASK_PRIORITIES: readonly ["none", "urgent", "high", "medium", "low"];
export const DEFAULT_PROJECT_ID: "local";
export function isTaskStatus(value: unknown): value is typeof TASK_STATUSES[number];
export function isTaskPriority(value: unknown): value is typeof TASK_PRIORITIES[number];
export function isCalendarDate(value: unknown): value is string;
