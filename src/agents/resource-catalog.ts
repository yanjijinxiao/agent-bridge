import { Buffer } from "node:buffer";
import { z } from "zod";
import { EXEC_BACKEND_CAPABILITIES, type CodexThreadState, type CodexThreadListInput } from "../codex/backend.js";
import type { AgentCatalog } from "./catalog.js";
import { RuntimeError, type AgentRuntimeAdapter, type RuntimeDescriptor, type RuntimeResource, type ResourceRef } from "./contracts.js";

const refSchema = z.tuple([z.string().min(1).max(200), z.string().min(1).max(512)]);
/** Lossless endpoint-qualified binding identity. A reconnect needs no mutable
 * ID translation table; another endpoint cannot inherit an old resource. */
export function resourceBindingId(ref: ResourceRef): string {
  const id = `resource:${Buffer.from(JSON.stringify(refSchema.parse([ref.endpointId, ref.id]))).toString("base64url")}`;
  if (id.length > 512) throw new RuntimeError("incompatible", "资源标识超过当前绑定协议的长度限制");
  return id;
}
export function bindingResourceRef(id: string, endpointId: string): ResourceRef {
  try {
    if (!/^resource:[A-Za-z0-9_-]{1,503}$/.test(id)) throw Error();
    const [endpoint, resource] = refSchema.parse(JSON.parse(Buffer.from(id.slice(9), "base64url").toString("utf8")));
    const ref = { endpointId: endpoint, id: resource };
    if (endpoint !== endpointId || resourceBindingId(ref) !== id) throw Error();
    return ref;
  } catch { throw new RuntimeError("scope", "资源不属于此执行入口，未切换或重建会话"); }
}
export function projectBindingId(endpointId: string, id: string): string {
  return resourceBindingId({ endpointId, id });
}

/** Metadata-only compatibility view. In particular there is no run(), fake
 * turn/start, invented transcript or terminal-output-to-final conversion. */
export class RuntimeResourceCatalog implements AgentCatalog {
  constructor(readonly runtime: AgentRuntimeAdapter, readonly descriptor: RuntimeDescriptor) {
    if (descriptor.kind === "codex") throw new RuntimeError("incompatible", "原生会话必须使用其原生目录适配器");
  }
  backendInfo() {
    return { id: this.descriptor.kind === "herdr-tui" ? "herdr-tui" as const : "herdr-app" as const,
      runtime: structuredClone(this.descriptor),
      capabilities: { ...EXEC_BACKEND_CAPABILITIES, history: false, historyPaging: false,
        projectCatalog: true, threadInspection: true } };
  }
  private state(resource: RuntimeResource): CodexThreadState {
    if (resource.ref.endpointId !== this.descriptor.endpointId) throw new RuntimeError("scope", "运行接口返回了其他入口的资源");
    return { threadId: resourceBindingId(resource.ref), resource, title: resource.title, cwd: resource.cwd,
      persistence: "active", runtimeStatus: resource.state === "working" || resource.state === "blocked" ? "active"
        : resource.state === "idle" || resource.state === "done" ? "idle" : "unknown", activeFlags: [],
      projectId: resource.projectId ? projectBindingId(resource.ref.endpointId, resource.projectId) : undefined,
      projectMembership: resource.projectId ? "assigned" : "none" };
  }
  async inspectThread(id: string) {
    const ref = bindingResourceRef(id, this.descriptor.endpointId), actual = await this.runtime.inspect(ref);
    if (actual.ref.id !== ref.id) throw new RuntimeError("changed", "运行接口返回了其他资源");
    return this.state(actual);
  }
  async listSessionCatalog(input: CodexThreadListInput = {}) {
    const catalog = await this.runtime.catalog();
    const threads = catalog.resources.map(r => this.state(r)).filter(s => input.persistence !== "archived"
      && (!input.cwd || input.cwd === s.cwd) && (!input.projectId || input.projectId === s.projectId)
      && (!input.unassigned || !s.projectId));
    return { backend: this.backendInfo().id, source: "runtime-catalog" as const,
      threads: input.limit === undefined ? threads : threads.slice(0, input.limit), hostIds: [],
      complete: catalog.complete, warnings: catalog.warnings };
  }
  async listThreads(input?: CodexThreadListInput) { return (await this.listSessionCatalog(input)).threads; }
  async listProjects() {
    const catalog = await this.runtime.catalog();
    return { backend: this.backendInfo().id, projects: catalog.projects.map(p => ({ ...p,
      id: projectBindingId(this.descriptor.endpointId, p.id) })) };
  }
}
