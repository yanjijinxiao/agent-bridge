import type { CodexBridgeBackend } from "../codex/backend.js";

/** Discovery is shared by channels, grants, files and IDE. These consumers do
 * not acquire a native conversation executor merely by inspecting a resource.
 * Legacy thread/project field names remain a wire compatibility projection. */
export type AgentCatalog = Pick<CodexBridgeBackend,
  "backendInfo" | "inspectThread" | "listThreads" | "listSessionCatalog" | "listProjects">;
export type AgentBackendId = "exec" | "app-server" | "herdr-tui" | "herdr-app";
