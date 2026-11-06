import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import { CONTRACTS, runtimeIdentity, type RuntimeIdentity } from "./versions.js";

type Context = { requestId?: string; connectionId?: string; hostId?: string; operationId?: string };
const context = new AsyncLocalStorage<Context>();
let identity: RuntimeIdentity | undefined;
let output: ((line: string) => void) | undefined;
export function withDiagnosticContext<T>(value: Context, action: () => T): T {
  return context.run({ ...context.getStore(), ...value }, action);
}

/** No arbitrary objects/payloads in new diagnostic events. Keep diagnostics
 * best-effort: a failed sink must never change submission/receipt semantics. */
const fields = new Set(["requestId", "parentRequestId", "connectionId", "hostId", "operationId", "nativeRequestId", "nativeConnectionId", "method", "phase",
  "durationMs", "port", "code", "rpcCode", "status", "surface", "compatibility", "remoteInstanceId", "remoteVersion", "remoteCommit", "upstreamAgent"]);
export function diagnostic(event: string, values: Record<string, unknown> = {}, level = "info"): void {
  if (!identity || !output) return;
  const data: Record<string, unknown> = {};
  const parent = context.getStore();
  const parentRequestId = parent?.requestId && values.requestId && parent.requestId !== values.requestId ? parent.requestId : undefined;
  for (const [key, value] of Object.entries({ ...parent, parentRequestId, ...values })) {
    if (fields.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
      data[key] = typeof value === "string" ? redact(value).slice(0, 512) : value;
  }
  write({ event, level, ...data });
}

function redact(value: string): string {
  return value.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, "[url-redacted]")
    .replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(/((?:["']?)(?:token|secret|password|authorization|api[_-]?key|sessionWebhook|access[_-]?token)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]");
}
function write(record: Record<string, unknown>): void {
  try { output?.(JSON.stringify({ schemaVersion: CONTRACTS.log.major, timestamp: new Date().toISOString(), runtime: identity, ...record }) + "\n"); } catch { /* logging is not an execution dependency */ }
}

/** Only process entrypoints install the adapter. stdout used by native RPC or
 * byte relays is untouched; terminal prompts use terminalMessage explicitly. */
export function installDiagnostics(component: RuntimeIdentity["component"], sink = (line: string) => { process.stderr.write(line); }): () => void {
  const previous = { identity, output, log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  identity = runtimeIdentity(component); output = sink;
  for (const name of ["log", "info", "warn", "error", "debug"] as const) console[name] = (...args: unknown[]) => {
    let message: string;
    try { message = redact(format(...args)).slice(0, 8192); } catch { message = "Unformattable legacy log"; }
    write({ event: "legacy.console", level: name === "log" ? "info" : name, ...context.getStore(), message });
  };
  diagnostic("runtime.started");
  return () => { for (const name of ["log", "info", "warn", "error", "debug"] as const) console[name] = previous[name];
    identity = previous.identity; output = previous.output; };
}
export function terminalMessage(message: string): void { process.stdout.write(message + "\n"); }
