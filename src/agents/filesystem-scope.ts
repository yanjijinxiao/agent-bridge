import type { RuntimeResource } from "./contracts.js";

/** File authority follows the resource's project and directory, not its active
 * program, reported task state or screen. A new foreground process in the same
 * directory must not silently replace another resource's host validator. */
export function runtimeFilesystemScope(resource: RuntimeResource): string {
  return JSON.stringify([resource.ref.endpointId, resource.ref.id, resource.projectId ?? null,
    resource.cwd ?? null, resource.machine ?? null]);
}
