import { RuntimeError, type ResourceRef } from "./contracts.js";

/** A short handoff lock shared by input, interrupt and lifecycle operations.
 * It owns no running task, does not queue/retry, and has no restart veto. */
export class RuntimeWriteGate {
  private readonly active = new Set<string>();
  acquire(target: ResourceRef | string): () => void {
    const key = typeof target === "string" ? `create:${target}` : JSON.stringify([target.endpointId, target.id]);
    if (this.active.has(key)) throw new RuntimeError("not-ready", "此资源的上一项写入仍在交接");
    this.active.add(key);
    let released = false;
    return () => { if (!released) { released = true; this.active.delete(key); } };
  }
}
