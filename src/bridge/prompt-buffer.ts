export type PromptBufferItem =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; label: string }
  | { kind: "image"; path: string; label: string }
  | { kind: "video"; path: string; label: string }
  | { kind: "audio"; path: string; label: string };

export type PromptBufferOptions = {
  maxItems: number;
  ttlMs: number;
  now?: () => number;
  filePath?: string;
};

type BufferState = {
  startedAt: number;
  updatedAt: number;
  items: PromptBufferItem[];
  scope?: string;
  sources: string[];
  phase: "collecting" | "preparing" | "submitting";
  submissionId?: string;
};

const ItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  ...(["file", "image", "video", "audio"] as const).map(kind => z.object({
    kind: z.literal(kind), path: z.string(), label: z.string()
  }).strict())
]);
const StateSchema = z.object({ startedAt: z.number().finite(), updatedAt: z.number().finite(),
  items: z.array(ItemSchema), scope: z.string().optional(), sources: z.array(z.string()),
  phase: z.enum(["collecting", "preparing", "submitting"]), submissionId: z.string().optional()
}).strict().refine(state => state.phase === "collecting" || Boolean(state.submissionId));
const JournalSchema = z.object({ version: z.literal(1), buffers: z.array(z.tuple([z.string(), StateSchema])) }).strict();

export class PromptBuffer {
  private buffers = new Map<string, BufferState>();
  private readonly now: () => number;

  constructor(private readonly options: PromptBufferOptions) {
    this.now = options.now ?? (() => Date.now());
    if (options.filePath) {
      const saved = JournalSchema.safeParse(readJsonFile<unknown>(options.filePath, { version: 1, buffers: [] }));
      if (!saved.success || new Set(saved.data.buffers.map(([key]) => key)).size !== saved.data.buffers.length)
        throw Error("Invalid prompt buffer journal; original file preserved");
      this.buffers = new Map(saved.data.buffers);
      // Preparing never dispatched a mutation. Submitting is a durable write
      // intent and must stay held when the native receipt is unknown.
      if ([...this.buffers.values()].some(state => state.phase === "preparing")) this.mutate(next => {
        for (const state of next.values()) if (state.phase === "preparing") {
          state.phase = "collecting"; delete state.submissionId;
        }
      });
    }
  }

  start(key: string, scope?: string): { status: "started" | "already-started" } {
    this.expire();
    if (this.buffers.has(key)) {
      this.collecting(key, scope);
      return { status: "already-started" };
    }
    const now = this.now();
    this.mutate(next => next.set(key, { startedAt: now, updatedAt: now, items: [], sources: [], phase: "collecting", scope }));
    return { status: "started" };
  }

  append(key: string, item: PromptBufferItem): void {
    this.appendBatch(key, [item]);
  }

  appendBatch(key: string, items: PromptBufferItem[], sourceId?: string, scope?: string): void {
    this.expire();
    const state = this.collecting(key, scope);
    if (sourceId && state.sources.includes(sourceId)) return;
    if (state.items.length + items.length > this.options.maxItems) {
      throw new Error(`too many buffered prompt items; limit is ${this.options.maxItems}`);
    }
    this.mutate(next => {
      const state = next.get(key)!;
      state.items.push(...structuredClone(items)); state.updatedAt = this.now();
      if (sourceId) state.sources.push(sourceId);
    });
  }

  done(key: string): { status: "empty"; items: [] } | { status: "flushed"; items: PromptBufferItem[] } {
    this.expire();
    const state = this.buffers.get(key);
    if (state) this.collecting(key);
    this.cancel(key);
    if (!state || state.items.length === 0) {
      return { status: "empty", items: [] };
    }
    return { status: "flushed", items: structuredClone(state.items) };
  }

  begin(key: string, scope: string): { id: string; items: PromptBufferItem[] } | undefined {
    this.expire();
    if (!this.buffers.has(key)) return;
    const state = this.collecting(key, scope);
    if (!state.items.length) { this.cancel(key); return; }
    const id = crypto.randomUUID();
    this.mutate(next => Object.assign(next.get(key)!, { phase: "preparing", submissionId: id }));
    return { id, items: structuredClone(state.items) };
  }

  submitting(key: string, id: string): void {
    const state = this.buffers.get(key);
    if (!state || state.submissionId !== id || state.phase !== "preparing") throw Error("Prompt buffer submission changed");
    this.mutate(next => { next.get(key)!.phase = "submitting"; });
  }

  settle(key: string, id: string, accepted: boolean): void {
    if (this.buffers.get(key)?.submissionId !== id) return;
    this.mutate(next => {
      if (accepted) next.delete(key);
      else { const state = next.get(key)!; state.phase = "collecting"; delete state.submissionId; }
    });
  }

  cancel(key: string): boolean {
    if (!this.buffers.has(key)) return false;
    this.mutate(next => next.delete(key)); return true;
  }

  isActive(key: string): boolean {
    this.expire();
    return this.buffers.has(key);
  }

  private expire(): void {
    const now = this.now();
    const expired = [...this.buffers].filter(([, state]) => state.phase === "collecting" && now - state.updatedAt > this.options.ttlMs);
    if (expired.length) this.mutate(next => { for (const [key] of expired) next.delete(key); });
  }

  private collecting(key: string, scope?: string): BufferState {
    const state = this.buffers.get(key);
    if (!state) throw Error("prompt buffer is not active");
    if (state.phase !== "collecting") throw Error("合并消息已尝试提交，回执尚未确认；内容仍保留，请先核对历史，不会重复提交。");
    if (scope !== undefined && state.scope !== scope) throw Error("合并区属于先前的会话绑定；请核对原会话，或在消息合并菜单取消本地合并区。");
    return state;
  }

  private mutate(action: (next: Map<string, BufferState>) => unknown): void {
    const next = structuredClone(this.buffers); action(next);
    if (this.options.filePath) writeJsonFile(this.options.filePath, { version: 1, buffers: [...next] }, { durable: true });
    this.buffers = next;
  }
}
import crypto from "node:crypto";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
