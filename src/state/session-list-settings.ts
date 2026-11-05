import { DEFAULT_COMMAND_LIST_SIZE } from "../channels/command-display.js";

/** Saved user preferences remain authoritative; only an unset value uses this default. */
export const DEFAULT_SESSION_PAGE_SIZE = DEFAULT_COMMAND_LIST_SIZE;
export const MIN_SESSION_PAGE_SIZE = 5;
export const MAX_SESSION_PAGE_SIZE = 50;

export function isSessionPageSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_SESSION_PAGE_SIZE && value <= MAX_SESSION_PAGE_SIZE;
}
