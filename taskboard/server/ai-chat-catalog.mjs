import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./database.mjs";


async function existingDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value.trim())) return null;
  try {
    const resolved = await realpath(value.trim());
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function loadDeviceWorkspaceRoots(codexStatePath, database) {
  const workspaces = new Map();
  let localProjects = {};
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    if (
      state?.["local-projects"]
      && typeof state["local-projects"] === "object"
      && !Array.isArray(state["local-projects"])
    ) {
      localProjects = state["local-projects"];
    }
  } catch {}

  for (const [projectId, project] of Object.entries(localProjects)) {
    if (!Array.isArray(project?.rootPaths)) continue;
    const roots = [];
    for (const rootPath of project.rootPaths) {
      const workspacePath = await existingDirectory(rootPath);
      if (!workspacePath) continue;
      if (!roots.includes(workspacePath)) roots.push(workspacePath);
    }
    if (roots.length) workspaces.set(projectId, roots);
  }

  for (const project of await database.listProjects()) {
    if (workspaces.has(project.id)) continue;
    const workspacePath = await existingDirectory(project.workspacePath);
    if (workspacePath) workspaces.set(project.id, [workspacePath]);
  }
  return workspaces;
}

export async function loadDeviceWorkspaces(codexStatePath, database) {
  const roots = await loadDeviceWorkspaceRoots(codexStatePath, database);
  return new Map([...roots].map(([id, paths]) => [id, paths[0]]));
}

export async function resolveAiWorkspace(projectId, codexStatePath, database) {
  const project = await database.getProject(projectId);
  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
  }
  const workspaces = await loadDeviceWorkspaceRoots(codexStatePath, database);
  const [workspacePath, ...addDirectories] = workspaces.get(projectId) ?? [];
  if (!workspacePath) {
    throw new ApiError(
      409,
      "PROJECT_WORKSPACE_UNAVAILABLE",
      `Project '${projectId}' has no available device workspace`,
    );
  }
  return {
    workspacePath,
    // Project membership supplies writable roots. A device-wide directory
    // picker is presentation data, never authority to write other projects.
    addDirectories,
    project,
  };
}

export function nativeConversationUnavailable(execution) {
  if (execution && !execution.operations["structured-output"].supported)
    return "当前运行接口提供终端输入和画面，没有此面板所需的原生轮次及最终答复回执。普通工作说明可从绑定聊天或 Gateway 会话页发送；看板管理不受影响。";
}

/** Public catalogs are projections of the same selected native service. */
export async function discoverAiCatalog({ nativeBackend, codexStatePath, database, projectId }) {
  const execution = (await nativeBackend.backendInfo?.())?.runtime;
  const reason = nativeConversationUnavailable(execution);
  if (reason) {
    // A terminal screen has no native turn/final contract. Returning a clear
    // capability result keeps board CRUD and ordinary IM instructions separate
    // from the chat runner, which must not invent completed workflow outputs.
    if (!await database.getProject(projectId)) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    return { models: [], skills: [], sandboxes: [], execution, nativeConversation: false,
      reason };
  }
  const { workspacePath } = await resolveAiWorkspace(projectId, codexStatePath, database);
  const [models, skills] = await Promise.all([
    nativeBackend.listModels(), nativeBackend.listSkills(workspacePath),
  ]);
  return {
    models: [...models].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).map(model => ({
      slug: model.model, displayName: model.displayName, description: model.description,
      defaultReasoningEffort: model.defaultEffort ?? "",
      supportedReasoningEfforts: model.supportedEfforts.map(level => level.effort),
      serviceTiers: model.serviceTiers ?? [],
    })),
    skills,
    sandboxes: ["read-only", "workspace-write", "danger-full-access"],
  };
}
