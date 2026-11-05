import crypto from "node:crypto";
import { z } from "zod";
import WebSocket from "ws";

const envelope = z.discriminatedUnion("type", [
  z.object({ version: z.literal(1), type: z.literal("request"), id: z.string().uuid(), method: z.string().regex(/^[a-zA-Z][\w.]{0,100}$/), params: z.unknown() }).strict(),
  z.object({ version: z.literal(1), type: z.literal("response"), id: z.string().uuid(), result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string(), data: z.unknown().optional() }).strict().optional() }).strict()
]);

export class PeerError extends Error {
  constructor(readonly code: string, message: string, readonly data?: unknown) { super(message); }
}
/** sent means the peer may have received it. It never authorizes resubmission. */
export class PeerConnectionError extends Error {
  constructor(readonly sent: boolean, readonly timeout = false) { super(timeout ? "Gateway peer request timed out" : "Gateway peer disconnected"); }
}
export type PeerHandler = (params: unknown, requestId: string) => unknown | Promise<unknown>;
/** Interactive callbacks share the execution lease. Their owner controls the
 * approval/question deadline; transport must not expire an earlier decision. */
export const PEER_EXECUTION_TIMEOUT_MS = 24 * 60 * 60_000;
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; dispose: () => void };

/** Identical application protocol on dialled and accepted connections. All
 * events are acknowledged requests; neither role is a one-way message sink. */
export class PeerConnection {
  private readonly handlers = new Map<string, PeerHandler>();
  private readonly pending = new Map<string, Pending>();
  private readonly incoming = new Set<string>();
  private readonly closed = new Set<() => void>();
  private readonly heartbeat: NodeJS.Timeout;
  private alive = true;
  private readonly channels = new Map<string, PeerConnection>();
  constructor(private readonly socket: WebSocket) {
    socket.on("error", () => {}); // close rejects waiters without echoing credentials/URLs.
    socket.on("message", data => { void this.receive(data.toString()).catch(() => this.close()); });
    socket.once("close", () => {
      clearInterval(this.heartbeat);
      for (const p of this.pending.values()) { p.dispose(); p.reject(new PeerConnectionError(true)); }
      this.pending.clear();
      for (const notify of this.closed) notify();
      this.closed.clear();
    });
    socket.on("pong", () => { this.alive = true; });
    this.heartbeat = setInterval(() => {
      if (!this.alive) { socket.terminate(); return; }
      this.alive = false;
      if (this.open) socket.ping();
    }, 15_000);
    this.heartbeat.unref();
  }
  get open(): boolean { return this.socket.readyState === WebSocket.OPEN; }
  /** Multiplex a fixed exported host over this socket. The hash is a namespace,
   * not authority: only the locally registered channel receives handlers. */
  channel(hostId: string): PeerConnection {
    if (hostId === "local") return this;
    let channel = this.channels.get(hostId);
    if (!channel) {
      const prefix = `h${crypto.createHash("sha256").update(hostId).digest("hex").slice(0, 32)}.`;
      channel = new Proxy(this, { get: (target, key) => {
        if (key === "handle") return (method: string, handler: PeerHandler) => target.handle(prefix + method, handler);
        if (key === "request") return (method: string, ...args: [unknown?, number?, AbortSignal?]) => target.request(prefix + method, ...args);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      this.channels.set(hostId, channel);
    }
    return channel;
  }
  onClose(listener: () => void): () => void { this.closed.add(listener); return () => this.closed.delete(listener); }
  handle(method: string, handler: PeerHandler): () => void {
    if (this.handlers.has(method)) throw new Error(`Duplicate peer handler: ${method}`);
    this.handlers.set(method, handler);
    return () => { if (this.handlers.get(method) === handler) this.handlers.delete(method); };
  }
  request<T = unknown>(method: string, params: unknown = null, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    if (!this.open || signal?.aborted) return Promise.reject(new PeerConnectionError(false));
    if (this.pending.size >= 256) return Promise.reject(new PeerError("busy", "Too many pending peer requests"));
    const id = crypto.randomUUID();
    const body = JSON.stringify({ version: 1, type: "request", id, method, params });
    if (Buffer.byteLength(body) > 1024 * 1024) return Promise.reject(new PeerError("size", "Peer message exceeds 1 MiB"));
    return new Promise<T>((resolve, reject) => {
      const finish = (error: PeerConnectionError) => {
        const pending = this.pending.get(id); if (!pending) return;
        pending.dispose(); this.pending.delete(id); reject(error);
      };
      const abort = () => finish(new PeerConnectionError(true));
      const timer = setTimeout(() => finish(new PeerConnectionError(true, true)), timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: value => resolve(value as T), reject,
        dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.socket.send(body, error => { if (error) finish(new PeerConnectionError(true)); }); }
      catch { finish(new PeerConnectionError(true)); }
    });
  }
  private async receive(body: string): Promise<void> {
    let value: z.infer<typeof envelope>;
    try { value = envelope.parse(JSON.parse(body)); }
    catch { this.socket.close(1008, "Invalid peer protocol"); return; }
    if (value.type === "response") {
      const pending = this.pending.get(value.id); if (!pending) return;
      pending.dispose(); this.pending.delete(value.id);
      if (value.error) pending.reject(new PeerError(value.error.code, value.error.message, value.error.data));
      else pending.resolve(value.result);
      return;
    }
    if (this.incoming.size >= 256 || this.incoming.has(value.id)) { this.socket.close(1008, "Duplicate or excessive requests"); return; }
    this.incoming.add(value.id);
    const response: Record<string, unknown> = { version: 1, type: "response", id: value.id };
    try {
      const handler = this.handlers.get(value.method);
      if (!handler) throw new PeerError("unsupported", "Peer operation is unavailable");
      response.result = await handler(value.params, value.id) ?? null;
    } catch (error) {
      response.error = error instanceof PeerError ? { code: error.code, message: error.message, data: error.data }
        : { code: "failed", message: "Peer operation failed; inspect the originating device" };
    } finally { this.incoming.delete(value.id); }
    if (this.open) {
      const output = JSON.stringify(response);
      if (Buffer.byteLength(output) > 1024 * 1024) this.socket.send(JSON.stringify({ version: 1, type: "response", id: value.id,
        error: { code: "size", message: "Peer response exceeds 1 MiB; request a smaller history page" } }));
      else this.socket.send(output);
    }
  }
  close(): void { this.socket.terminate(); }
}
