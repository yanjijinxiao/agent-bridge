import type { CodexProjectCandidate } from "../server/codex-projects.js";
import { compactTableCell } from "../channels/table.js";
import { sessionHostLabel, type SessionCatalogRow } from "./session-catalog-order.js";

type ProjectGroup = NonNullable<SessionCatalogRow["group"]>;
export type SessionCatalogItem =
  | { kind: "session"; row: SessionCatalogRow; number: number; section: "pinned" | "project" | "other"; group?: ProjectGroup }
  | { kind: "project"; group: ProjectGroup; notice: string };

/** Display pagination includes empty folders, but only real sessions receive R
 * numbers. Keep those numbers from the original ordered snapshot, never from
 * the page offset or folder count. This projection cannot change membership. */
export function sessionCatalogItems(
  rows: readonly SessionCatalogRow[],
  catalog: readonly CodexProjectCandidate[],
  options: { includeEmpty: boolean; incompleteHosts: ReadonlyMap<string, string>; activeGroupId?: string }
): SessionCatalogItem[] {
  const groups = new Map<string, ProjectGroup>();
  if (options.includeEmpty) for (const project of catalog) {
    if (!project.projectId) continue; // A legacy cwd hint is not a project identity.
    const hostId = project.hostId ?? "local", id = JSON.stringify([hostId, project.projectId]);
    if (!groups.has(id)) groups.set(id, { id, hostId, name: project.name, label: "", current: id === options.activeGroupId });
  }
  // When filtering, use the unpinned project order; a pinned row must not move
  // its entire folder ahead of the remaining native project order.
  for (const row of [...rows.filter(r => r.state.catalogOrder?.pinnedIndex === undefined),
    ...rows.filter(r => r.state.catalogOrder?.pinnedIndex !== undefined)]) {
    if (row.group && !groups.has(row.group.id)) groups.set(row.group.id, { ...row.group });
  }
  // Disambiguate the complete snapshot, including empty and remote folders.
  const labels = new Map<string, ProjectGroup[]>();
  for (const group of groups.values()) {
    group.label = compactTableCell(group.name, 40);
    labels.set(group.label, [...(labels.get(group.label) ?? []), group]);
  }
  for (const group of groups.values()) {
    const peers = labels.get(group.label)!.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    group.label += peers.length > 1 ? ` #${peers.indexOf(group) + 1}` : "";
    if (group.hostId !== "local") group.label += ` · ${compactTableCell(sessionHostLabel(group.hostId), 24)}`;
  }
  const sessions = rows.map((row, index): Extract<SessionCatalogItem, { kind: "session" }> => ({
    kind: "session", row, number: index + 1,
    section: row.state.catalogOrder?.pinnedIndex !== undefined ? "pinned" : row.group ? "project" : "other",
    ...(row.group ? { group: groups.get(row.group.id)! } : {})
  }));
  const items: SessionCatalogItem[] = sessions.filter(item => item.section === "pinned");
  for (const group of groups.values()) {
    const children = sessions.filter(item => item.section === "project" && item.group?.id === group.id);
    if (children.length) items.push(...children);
    else if (options.includeEmpty) {
      const unavailable = catalog.find(p => JSON.stringify([p.hostId ?? "local", p.projectId]) === group.id)?.available === false;
      const notice = options.incompleteHosts.get(group.hostId) ?? (unavailable ? "会话列表暂不可用" : undefined);
      items.push({ kind: "project", group, notice: notice ?? (sessions.some(item => item.group?.id === group.id)
        ? "会话已在置顶区显示" : "暂无未归档会话") });
    }
  }
  items.push(...sessions.filter(item => item.section === "other"));
  return items;
}
