/** Local sources stay synchronous. A transport can add an asynchronous check
 * at the last native request boundary without replacing the source guard. */
export type CodexWriteGuard = (() => void) & { beforeWrite?: () => Promise<void> };

export function inheritWriteCheck(source: CodexWriteGuard | undefined, check: () => void): CodexWriteGuard {
  return Object.assign(check, { beforeWrite: source?.beforeWrite });
}

export function guardNativeWrite<T>(guard: CodexWriteGuard | undefined, write: () => Promise<T>): Promise<T> {
  guard?.();
  // Do not introduce an await between a local guard and its native write.
  if (!guard?.beforeWrite) return write();
  return guard.beforeWrite().then(() => { guard(); return write(); });
}
