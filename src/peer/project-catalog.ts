import type { CodexBridgeBackend } from "../codex/backend.js";
import { desktopSessionMembership } from "../codex/desktop-session-membership.js";

/** Device-only projection: native session membership already resolves Desktop
 * migration aliases. Export its same identity without changing the Gateway's
 * local/SSH project catalog or inferring identity from names and directories. */
export function withConnectorProjects<T extends CodexBridgeBackend>(backend: T, codexHome?: string): T {
  return new Proxy(backend, { get(target, key) {
    if (key === "listProjects") return async (host?: string, observation?: import("../codex/backend.js").CodexMetadataObservation) => {
      const catalog = await target.listProjects(host, observation);
      const membership = desktopSessionMembership(codexHome, host ?? "local");
      return { ...catalog, projects: catalog.projects.map(project => ({ ...project, id: membership({
        threadId: "", projectId: project.id, projectMembership: "assigned", persistence: "active", runtimeStatus: "unknown", activeFlags: []
      }).projectId ?? project.id })) };
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
