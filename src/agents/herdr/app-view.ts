import net from "node:net";
import { RuntimeError } from "../contracts.js";
import type { RuntimeRequestOptions } from "../json-line-client.js";

export type AppLifecycleCommand = "space.new" | "tab.new" | "tab.rename";
export interface HerdrAppView { list(): Promise<unknown>;
  command?(name: AppLifecycleCommand, args: Record<string, unknown>, options: RuntimeRequestOptions): Promise<unknown>;
  close?(): void; }

/** The App window accepts one unwrapped JSON request per connection. It is a
 * presentation source, not a second execution server. */
export class HerdrAppViewClient implements HerdrAppView {
  private readonly sockets = new Set<net.Socket>();
  private closed = false;
  constructor(private readonly socketPath: string, private readonly timeoutMs = 10000) {}
  list(): Promise<unknown> { return this.request({ ls: true }); }
  command(name: AppLifecycleCommand, args: Record<string, unknown>, options: RuntimeRequestOptions): Promise<unknown> {
    return this.request({ do: name, args }, { ...options, write: true });
  }
  private request(payload: unknown, options: RuntimeRequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new RuntimeError("transport", "Herdr App 目录观察已关闭"));
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      this.sockets.add(socket);
      let buffer = Buffer.alloc(0), settled = false, sent = false;
      const error = (code: "protocol" | "transport", message: string) => new RuntimeError(code, message,
        options.write && sent ? "unknown" : "not-sent");
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); this.sockets.delete(socket);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(error("transport", "Herdr App 窗口未响应")), options.timeoutMs ?? this.timeoutMs);
      socket.once("connect", () => { void (async () => {
        await options.prepareWrite?.();
        if (settled || this.closed || socket.destroyed) return;
        const guarded: unknown = options.beforeWrite?.();
        if (guarded && typeof (guarded as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(guarded).catch(() => undefined);
          throw new RuntimeError("not-ready", "最终写入核验必须同步完成");
        }
        if (settled || this.closed || socket.destroyed) return;
        sent = true; socket.write(JSON.stringify(payload) + "\n");
      })().catch(cause => finish(cause instanceof Error ? cause : error("transport", "窗口写入前核验失败"))); });
      socket.on("data", data => {
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length > 4 * 1024 * 1024) { finish(error("protocol", "Herdr App 响应超限")); return; }
        const end = buffer.indexOf(10); if (end < 0) return;
        try {
          const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end)));
          if (!value || typeof value !== "object" || Array.isArray(value) || value.error) throw Error("invalid view");
          finish(undefined, value);
        // Even a window error can be a timed-out queued command which runs
        // later. No unwrapped error is proof that a lifecycle write was unsent.
        } catch { finish(error("protocol", "Herdr App 响应未确认")); }
      });
      socket.on("error", () => finish(error("transport", "无法连接 Herdr App 窗口")));
      socket.on("close", () => finish(error("transport", "Herdr App 连接提前关闭")));
    });
  }
  close(): void { this.closed = true; for (const socket of this.sockets) socket.destroy(); this.sockets.clear(); }
}
