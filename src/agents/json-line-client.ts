import net from "node:net";
import crypto from "node:crypto";
import { RuntimeError } from "./contracts.js";

export type RuntimeRequestOptions = { write?: boolean; timeoutMs?: number; beforeWrite?: () => void; prepareWrite?: () => Promise<void> };
export interface RuntimeRpc {
  request(method: string, params?: unknown, options?: RuntimeRequestOptions): Promise<unknown>;
  close(): void;
}
type Pending = { resolve(value: unknown): void; reject(error: unknown): void; timer: NodeJS.Timeout; sent: boolean; write: boolean };

/** Public JSONL only. Never spawn a daemon, reconnect/replay a request, use a
 * shell command, or attach an interactive terminal that steals focus/size. */
export class JsonLineClient implements RuntimeRpc {
  private socket?: net.Socket;
  private opening?: net.Socket;
  private connecting?: Promise<net.Socket>;
  private pending = new Map<string, Pending>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private children = new Set<JsonLineClient>();
  constructor(private readonly options: { socketPath: string; dialect: "json-rpc" | "herdr-tui";
    connectionMode?: "per-request" | "persistent";
    timeoutMs?: number; maxFrameBytes?: number; notification?: (value: unknown) => void }) {}

  private connect(): Promise<net.Socket> {
    if (this.closed) return Promise.reject(new RuntimeError("transport", "运行接口连接已关闭"));
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    if (this.socket) {
      // A destroyed socket's close event may still be queued. Retire its
      // pending calls and partial frame before another connection owns state.
      this.socket = undefined; this.buffer = Buffer.alloc(0); this.failAll("原运行接口连接已结束");
    }
    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(this.options.socketPath);
      this.opening = socket;
      let connected = false;
      const timer = setTimeout(() => socket.destroy(new Error("connect timeout")), this.options.timeoutMs ?? 10000);
      socket.once("connect", () => { connected = true; clearTimeout(timer); this.opening = undefined;
        if (this.closed) { socket.destroy(); reject(new RuntimeError("transport", "运行接口连接已关闭")); return; }
        this.socket = socket; resolve(socket); });
      socket.on("data", data => this.receive(socket, data));
      socket.on("error", () => { if (!connected) reject(new RuntimeError("transport", "无法连接已配置的运行接口")); });
      socket.on("close", () => {
        clearTimeout(timer);
        if (this.opening === socket) this.opening = undefined;
        if (!connected) reject(new RuntimeError("transport", "运行接口在连接前关闭"));
        if (this.socket === socket) { this.socket = undefined; this.buffer = Buffer.alloc(0); this.failAll("运行接口连接中断"); }
      });
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async request(method: string, params: unknown = {}, options: RuntimeRequestOptions = {}): Promise<unknown> {
    if (this.closed) throw new RuntimeError("transport", "运行接口连接已关闭");
    // TUI's public API handles one request and closes the socket. This is
    // request isolation, not a retry on a closed connection after writing.
    if ((this.options.connectionMode ?? (this.options.dialect === "herdr-tui" ? "per-request" : "persistent")) === "per-request") {
      const client = new JsonLineClient({ ...this.options, connectionMode: "persistent" }); this.children.add(client);
      try { return await client.request(method, params, options); }
      finally { client.close(); this.children.delete(client); }
    }
    const id = crypto.randomUUID();
    const wire = JSON.stringify({ ...(this.options.dialect === "json-rpc" ? { jsonrpc: "2.0" } : {}), id, method, params }) + "\n";
    if (Buffer.byteLength(wire) > (this.options.maxFrameBytes ?? 4 * 1024 * 1024)) throw new RuntimeError("protocol", "运行接口请求超出大小限制");
    const socket = await this.connect();
    await options.prepareWrite?.();
    if (this.closed || socket.destroyed) throw new RuntimeError("transport", "运行接口在发送前关闭");
    // Run after the connection await, immediately before enqueueing bytes. A
    // Promise-returning guard is a caller bug, never permission to proceed.
    const guarded: unknown = options.beforeWrite?.();
    if (guarded && typeof (guarded as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(guarded).catch(() => undefined);
      throw new RuntimeError("not-ready", "最终写入核验必须同步完成，未发送输入");
    }
    if (this.closed || socket.destroyed) throw new RuntimeError("transport", "运行接口在最终核验期间关闭");
    return new Promise((resolve, reject) => {
      const item: Pending = { resolve, reject, sent: false, write: options.write === true,
        timer: setTimeout(() => {
          this.pending.delete(id);
          reject(new RuntimeError("transport", "运行接口响应超时", item.write && item.sent ? "unknown" : "not-sent"));
        }, options.timeoutMs ?? this.options.timeoutMs ?? 10000) };
      this.pending.set(id, item);
      // Even a write callback error can follow partial delivery. It is never
      // evidence that retrying the same prompt is safe.
      item.sent = true;
      socket.write(wire, error => {
        if (error && this.pending.delete(id)) { clearTimeout(item.timer);
          reject(new RuntimeError("transport", "运行接口写入未确认", item.write ? "unknown" : "not-sent")); }
      });
    });
  }

  private receive(socket: net.Socket, data: Buffer): void {
    if (socket !== this.socket) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    const limit = this.options.maxFrameBytes ?? 4 * 1024 * 1024;
    while (true) {
      const end = this.buffer.indexOf(10);
      if (end < 0) { if (this.buffer.length > limit) this.invalid(socket); return; }
      if (end > limit) { this.invalid(socket); return; }
      const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      if (!line.length) continue;
      let value: any;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); } catch { this.invalid(socket); return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) { this.invalid(socket); return; }
      if (!Object.hasOwn(value, "id")) { try { this.options.notification?.(value); } catch { /* Observers cannot break request delivery. */ } continue; }
      const item = typeof value.id === "string" ? this.pending.get(value.id) : undefined;
      if (!item) continue; // Late/cancelled or another request's id cannot settle an operation.
      this.pending.delete(value.id); clearTimeout(item.timer);
      if (value.error !== undefined) {
        // Provider errors may follow partial PTY delivery. Never attach its
        // arbitrary body as Error.cause: normal error logging would leak it.
        item.reject(new RuntimeError("protocol", "运行接口拒绝或未能完成操作", item.write ? "unknown" : "not-sent"));
      } else if (!Object.hasOwn(value, "result") || this.options.dialect === "json-rpc" && value.jsonrpc !== "2.0") {
        item.reject(new RuntimeError("protocol", "运行接口响应格式不兼容", item.write ? "unknown" : "not-sent"));
      } else item.resolve(value.result);
    }
  }
  private invalid(socket: net.Socket): void { this.failAll("运行接口返回了无效或超限数据"); socket.destroy(); }
  private failAll(message: string): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new RuntimeError("transport", message,
      item.write && item.sent ? "unknown" : "not-sent")); }
    this.pending.clear();
  }
  close(): void { this.closed = true; this.failAll("运行接口观察连接已关闭"); this.opening?.destroy(); this.socket?.destroy();
    for (const child of this.children) child.close(); this.children.clear(); }
}
