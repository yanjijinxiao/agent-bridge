/** Public read model for native tool activity. It is not a second execution
 * protocol: items still come from the one App Server notification stream. */
export type CodexPublicActivity = {
  type: string;
  role: "assistant" | "activity" | "error";
  content: string;
  data: Record<string, unknown>;
};
const LIMIT = 65_536;
const text = (value: unknown) => typeof value === "string" ? value.slice(0, LIMIT) : "";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === "object" && !Array.isArray(value);

export function sensitiveCommand(command: string): boolean {
  return /(?:token|secret|password|passwd|api[_-]?key|authorization|credential)['"]?\s*(?:[:=]|\s)/i.test(command)
    || /\bBearer\s+/i.test(command) || /[a-z][a-z\d+.-]*:\/\/[^/\s]*@/i.test(command);
}

function toolDetail(value: unknown): string {
  let budget = LIMIT, nodes = 256;
  const copy = (input: unknown, depth: number): unknown => {
    if (budget <= 0 || --nodes < 0 || depth > 6) return "[内容已截断]";
    if (typeof input === "string") { const result = input.slice(0, budget); budget -= result.length; return result; }
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (Array.isArray(input)) return input.slice(0, 64).map(item => copy(item, depth + 1));
    if (!record(input)) return undefined;
    const result: Record<string, unknown> = Object.create(null);
    let keys = 0;
    for (const key in input) {
      if (!Object.hasOwn(input, key) || key === "_meta") continue;
      if (++keys > 64 || budget <= 0 || nodes <= 0) break;
      const label = key.slice(0, 200); budget -= label.length;
      result[label] = /^(?:authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key)
        ? "[已隐藏]" : copy(input[key], depth + 1);
    }
    return result;
  };
  try { return JSON.stringify(copy(value, 0))?.slice(0, LIMIT) ?? ""; }
  catch { return ""; }
}

/** Whitelist visible content before any generic serialization. In particular,
 * reasoning/guardian/reviewer records never enter the public item callback. */
export function nativePublicActivity(value: unknown, completed: boolean): CodexPublicActivity | undefined {
  if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.type !== "string") return;
  const status = typeof value.status === "string" ? text(value.status) : completed ? "completed" : "in_progress";
  const data: Record<string, unknown> = { itemId: text(value.id), status };
  switch (value.type) {
    case "agentMessage":
      if (!completed || value.phase === "commentary") return;
      return { type: "agent_message", role: "assistant", content: text(value.text), data };
    case "commandExecution": {
      // Inspect the full command before truncating the presentation. A secret
      // assignment after the display limit must still hide echoed output.
      const sensitive = sensitiveCommand(typeof value.command === "string" ? value.command : "");
      const command = text(value.command);
      data.command = sensitive ? "参数已隐藏（含敏感字段）" : command;
      if (!sensitive && typeof value.aggregatedOutput === "string") data.output = text(value.aggregatedOutput);
      if (Number.isInteger(value.exitCode)) data.exitCode = value.exitCode;
      return { type: "command_execution", role: "activity", content: String(data.command), data };
    }
    case "fileChange": {
      const changes = Array.isArray(value.changes) ? value.changes.filter(record).slice(0, 200).map(change => ({
        path: text(change.path), kind: text(record(change.kind) ? change.kind.type : change.kind)
      })).filter(change => change.path) : [];
      const paths = text(changes.map(change => change.path).join("\n"));
      data.files = paths.split("\n").filter(Boolean);
      data.detail = toolDetail(changes);
      return { type: "file_change", role: "activity", content: paths, data };
    }
    case "mcpToolCall": {
      data.server = text(value.server); data.tool = text(value.tool);
      data.detail = toolDetail({ arguments: value.arguments, result: value.result, error: value.error });
      return { type: "mcp_tool_call", role: value.error ? "error" : "activity", content: [data.server, data.tool].filter(Boolean).join("."), data };
    }
    case "webSearch": {
      const action = record(value.action) ? value.action : {};
      const query = text(value.query) || text(action.query);
      data.query = query;
      return { type: "web_search", role: "activity", content: query, data };
    }
    case "plan":
      return { type: "todo_list", role: "activity", content: text(value.text), data };
    default: return;
  }
}
