import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodexProject, CodexThreadState } from "./backend.js";

type LegacyGroup = { projectId: string; roots: string[]; nativeId?: string };
type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A fresh, device-side display snapshot. The App records membership host ids
 * when committing a membership update. Only older explicit assignments
 * without that marker qualify; neither cwd nor sidebar ordering is evidence.
 * No backup is used, since it could revive a subsequently removed assignment. */
export function readDesktopCatalogGroups(
  codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), hostId = "local"
): { groups: ReadonlyMap<string, LegacyGroup>; warning?: string } {
  const groups = new Map<string, LegacyGroup>();
  let state: unknown;
  try { state = JSON.parse(fs.readFileSync(path.join(codexHome, ".codex-global-state.json"), "utf8")); }
  catch (error) {
    return { groups, ...((error as NodeJS.ErrnoException).code !== "ENOENT"
      ? { warning: "App 旧项目分组暂不可读；当前保留原生会话及归属，请稍后刷新。" } : {}) };
  }
  if (!record(state)) return { groups, warning: "App 旧项目分组格式无效；当前保留原生会话及归属。" };
  const projects = new Map<string, { roots: string[]; nativeId?: string }>();
  const namespaces = state["app-server-project-id-by-legacy-project-id-by-host"];
  const aliases = record(namespaces) ? namespaces[`${hostId}:${codexHome}`] ?? namespaces[hostId] : undefined;
  const add = (id: unknown, roots: unknown) => {
    if (typeof id !== "string" || !id || !rootsKey(roots)) return;
    const nativeId = record(aliases) && typeof aliases[id] === "string" && aliases[id] ? aliases[id] as string : undefined;
    projects.set(id, { roots: roots as string[], ...(nativeId ? { nativeId } : {}) });
  };
  if (hostId === "local" && record(state["local-projects"])) {
    for (const [key, value] of Object.entries(state["local-projects"]))
      if (record(value)) add(value.id ?? key, value.rootPaths);
  } else if (Array.isArray(state["remote-projects"])) {
    for (const project of state["remote-projects"])
      if (record(project) && project.hostId === hostId) add(project.id, [project.remotePath]);
  }
  const assignments = state["thread-project-assignments"], hosts = state["thread-project-membership-host-ids"];
  const projectless = new Set(Array.isArray(state["projectless-thread-ids"]) ? state["projectless-thread-ids"] : []);
  if (record(assignments)) for (const [id, assignment] of Object.entries(assignments)) {
    if (!record(assignment) || (assignment.hostId ?? "local") !== hostId || typeof assignment.projectId !== "string"
      || projectless.has(id) || record(hosts) && Object.hasOwn(hosts, id)) continue;
    const project = projects.get(assignment.projectId);
    if (project) groups.set(id, { projectId: assignment.projectId, ...project });
  }
  if (groups.size) {
    // A leftover global-state file on a CLI host is insufficient. The App must
    // also have published this exact host/thread in its own catalog; native
    // rows still determine existence and persistence, never the App-only ids.
    try {
      const published = publishedThreads(codexHome, hostId, groups.keys());
      for (const id of groups.keys()) if (!published.has(id)) groups.delete(id);
    } catch {
      groups.clear();
      return { groups, warning: "App 旧目录无法核对；当前保留原生会话及归属，请稍后刷新。" };
    }
  }
  return { groups };
}

/** Corroborate presence only; never merge/select Desktop accounts or take their
 * titles, membership or history as native facts. Stable/dev catalogs can coexist:
 * every existing catalog must agree on the exact host/thread being visible. */
function publishedThreads(codexHome: string, hostId: string, ids: Iterable<string>): Set<string> {
  const files = ["codex.db", "codex-dev.db"].map(name => path.join(codexHome, "sqlite", name)).filter(file => fs.existsSync(file));
  const published = new Set(files.length ? ids : []);
  for (const file of files) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; BEGIN");
      const lookup = db.prepare("SELECT missing_candidate,source_kind,thread_source FROM local_thread_catalog WHERE host_id=? AND thread_id=?");
      for (const id of published) {
        const rows = lookup.all(hostId, id);
        const row = rows.length === 1 ? rows[0] : undefined;
        if (!row || row.missing_candidate !== 0 || typeof row.source_kind !== "string" || row.source_kind === "exec"
          || row.source_kind === "chatgpt" || row.source_kind.startsWith("subAgent")
          || row.thread_source === "ambient_suggestions" || row.thread_source === "pull_request_fix_automation") published.delete(id);
      }
    } finally { db.close(); }
  }
  return published;
}

/** Match an already registered legacy project's full roots, only for display.
 * A known id/alias must still exist; never replace a deleted id by another
 * project sharing its directory. Ambiguous root sets stay ungrouped. */
export function desktopCatalogGroupId(state: CodexThreadState, groups: ReadonlyMap<string, LegacyGroup>, projects: readonly CodexProject[]): string | undefined {
  if (state.projectId || state.workspaceProjectId) return;
  const group = groups.get(state.threadId);
  if (!group) return;
  const known = group.nativeId ?? group.projectId;
  if (projects.some(p => p.id === known)) return known;
  if (group.nativeId) return;
  const key = rootsKey(group.roots);
  const matches = new Set(projects.filter(p => rootsKey(p.roots) === key).map(p => p.id));
  return matches.size === 1 ? matches.values().next().value : undefined;
}

function rootsKey(value: unknown): string | undefined {
  if (!Array.isArray(value) || !value.length || value.some(p => typeof p !== "string" || p.includes("\0")
    || !path.posix.isAbsolute(p) && !path.win32.isAbsolute(p))) return;
  return JSON.stringify([...new Set((value as string[]).map(p => (path.posix.isAbsolute(p) ? path.posix : path.win32).resolve(p)))].sort());
}
