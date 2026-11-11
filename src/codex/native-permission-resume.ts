import path from "node:path";
import { rolloutIdentity } from "./rollout-identity.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const absolute = (value: unknown): value is string => typeof value === "string"
  && !value.includes("\0") && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
const invalid = (): never => { throw new Error("无法完整核对原生会话的最新权限，未恢复或提交输入；请在 Codex 中核对会话权限。"); };

/** This is a projection of the latest native record, not a Bridge setting or
 * cache. Only cold resume uses it. Never select an older, broader grant when a
 * newer settings record is incomplete or cannot be represented losslessly. */
export function nativePermissionResume(contents: string, threadId: string): RecordValue {
  if (!contents.endsWith("\n")) return invalid();
  let first = true, latest: RecordValue | undefined;
  for (let start = 0, end = contents.indexOf("\n"); end >= 0; start = end + 1, end = contents.indexOf("\n", start)) {
    const line = contents.slice(start, end);
    if (!first && !/"(?:thread_settings_applied|turn_context)"/.test(line)) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { return invalid(); }
    if (!record(row) || !record(row.payload)) return invalid();
    if (first) {
      first = false;
      const owner = rolloutIdentity(row.payload);
      if (row.type !== "session_meta" || owner.threadId !== threadId || owner.internal) return invalid();
      continue;
    }
    if (row.type === "event_msg" && row.payload.type === "thread_settings_applied") {
      if (row.payload.thread_id !== threadId || !record(row.payload.thread_settings)) return invalid();
      latest = row.payload.thread_settings;
    } else if (row.type === "turn_context") latest = row.payload;
  }
  // A named empty thread may not yet have execution settings. It has no prior
  // grant to restore; let the native server choose its creation defaults.
  if (!latest) return {};
  if (latest.thread_id !== undefined && latest.thread_id !== threadId) return invalid();
  if (!absolute(latest.cwd)) return invalid();
  const approval = latest.approval_policy, reviewer = latest.approvals_reviewer;
  const granularPolicy = record(approval) && record(approval.granular) ? approval.granular : undefined;
  const granular = granularPolicy && Object.keys(approval as RecordValue).length === 1
    && Object.keys(granularPolicy).length === 5
    && ["sandbox_approval", "rules", "skill_approval", "request_permissions", "mcp_elicitations"].every(k => typeof granularPolicy[k] === "boolean");
  if (!granular && !["untrusted", "on-failure", "on-request", "never"].includes(String(approval))) return invalid();
  if (reviewer !== undefined && !["user", "auto_review", "guardian_subagent"].includes(String(reviewer))) return invalid();
  if (latest.runtime_workspace_roots !== undefined && (!Array.isArray(latest.runtime_workspace_roots)
    || !latest.runtime_workspace_roots.every(absolute))) return invalid();
  const common = { cwd: latest.cwd, approvalPolicy: approval,
    ...(reviewer !== undefined ? { approvalsReviewer: reviewer } : {}),
    ...(latest.runtime_workspace_roots !== undefined ? { runtimeWorkspaceRoots: latest.runtime_workspace_roots } : {}) };
  // Named profiles carry rules that cannot be reconstructed from sandbox alone
  // (for example network domains). Re-select the native id, letting current
  // native config/administrator requirements resolve it, including later edits.
  if (latest.active_permission_profile !== undefined && latest.active_permission_profile !== null) {
    const active = latest.active_permission_profile;
    if (!record(active) || typeof active.id !== "string" || !active.id.trim() || active.id.includes("\0")) return invalid();
    return { ...common, permissions: active.id };
  }
  const profile = latest.permission_profile;
  // Newer native versions persist permission_profile rather than the legacy
  // sandbox_policy in settings-applied records. Validate all filesystem rules;
  // custom denies/globs/read scopes must never be flattened into workspace-write.
  const policy = profile === undefined ? legacyPolicy(latest.sandbox_policy) : profilePolicy(profile, latest.cwd);
  if (policy.type === "dangerFullAccess") return { ...common, sandbox: "danger-full-access" };
  if (policy.type === "readOnly") {
    if (policy.networkAccess) return invalid(); // No equivalent legacy resume override.
    return { ...common, sandbox: "read-only" };
  }
  if (Array.isArray(latest.runtime_workspace_roots) && latest.runtime_workspace_roots.some(root => root !== latest.cwd
    && !policy.writableRoots.includes(root as string))) return invalid();
  return { ...common, sandbox: "workspace-write", config: {
    "sandbox_workspace_write.network_access": policy.networkAccess,
    "sandbox_workspace_write.writable_roots": policy.writableRoots,
    "sandbox_workspace_write.exclude_tmpdir_env_var": policy.excludeTmpdirEnvVar,
    "sandbox_workspace_write.exclude_slash_tmp": policy.excludeSlashTmp
  } };
}

type Policy = { type: "dangerFullAccess" } | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; networkAccess: boolean; writableRoots: string[]; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

function legacyPolicy(value: unknown): Policy {
  if (!record(value)) return invalid();
  if (Object.keys(value).some(key => !["type", "network_access", "writable_roots", "exclude_tmpdir_env_var", "exclude_slash_tmp"].includes(key))) return invalid();
  if (value.type === "danger-full-access") return { type: "dangerFullAccess" };
  if (value.type === "read-only" && (value.network_access === undefined || typeof value.network_access === "boolean"))
    return { type: "readOnly", networkAccess: value.network_access === true };
  if (value.type !== "workspace-write" || typeof value.network_access !== "boolean"
    || !Array.isArray(value.writable_roots) || !value.writable_roots.every(absolute)
    || typeof value.exclude_tmpdir_env_var !== "boolean" || typeof value.exclude_slash_tmp !== "boolean") return invalid();
  return { type: "workspaceWrite", networkAccess: value.network_access, writableRoots: value.writable_roots,
    excludeTmpdirEnvVar: value.exclude_tmpdir_env_var, excludeSlashTmp: value.exclude_slash_tmp };
}

function profilePolicy(value: unknown, cwd: string): Policy {
  if (!record(value)) return invalid();
  if (value.type === "disabled") return { type: "dangerFullAccess" };
  if (value.type !== "managed" || !["enabled", "restricted"].includes(String(value.network))
    || !record(value.file_system) || value.file_system.type !== "restricted"
    || !Array.isArray(value.file_system.entries)) return invalid();
  const writes: string[] = [], protectedReads: string[] = [];
  let rootRead = false, tmpdir = false, slashTmp = false;
  for (const entry of value.file_system.entries) {
    if (!record(entry) || !record(entry.path)) return invalid();
    const p = entry.path;
    if (p.type === "special" && record(p.value)) {
      if (p.value.kind === "root" && entry.access === "read") { rootRead = true; continue; }
      if (entry.access === "write" && p.value.kind === "tmpdir") { tmpdir = true; continue; }
      if (entry.access === "write" && p.value.kind === "slash_tmp") { slashTmp = true; continue; }
      return invalid();
    }
    if (p.type !== "path" || !absolute(p.path)) return invalid();
    if (entry.access === "write") writes.push(p.path);
    else if (entry.access === "read" && entry.missing_path_behavior === "skip") protectedReads.push(p.path);
    else return invalid();
  }
  if (!rootRead) return invalid();
  const networkAccess = value.network === "enabled";
  if (!writes.length && !tmpdir && !slashTmp && !protectedReads.length) return { type: "readOnly", networkAccess };
  if (!writes.includes(cwd)) return invalid(); // workspace-write implicitly grants cwd.
  // These are the native legacy workspace's generated read-only carve-outs.
  // Any other rule needs a richer resume API, never a wider approximation.
  const paths = path.win32.isAbsolute(cwd) && !path.posix.isAbsolute(cwd) ? path.win32 : path.posix;
  if (protectedReads.some(p => ![".git", ".agents", ".codex", ".aws"].includes(paths.basename(p))
    || !writes.some(root => root === paths.dirname(p)))) return invalid();
  return { type: "workspaceWrite", networkAccess, writableRoots: writes.filter(p => p !== cwd),
    excludeTmpdirEnvVar: !tmpdir, excludeSlashTmp: !slashTmp };
}
