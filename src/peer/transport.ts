import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { PeerConnection } from "./rpc.js";
import { peerCertificateAuthority } from "./gateway-trust.js";
import { type PeerCredentialStore, type PeerEnrollment } from "./credentials.js";

export type PeerServerOptions = {
  host: string; port: number; credentials: Readonly<Record<string, string>>;
  tls?: { key: Buffer; cert: Buffer };
  allowInsecureLan?: boolean;
  deviceStore?: PeerCredentialStore;
  enrollment?: boolean;
  accept: (nodeId: string, connection: PeerConnection, enrollment?: PeerEnrollment) => void;
};
export type PeerClientOptions = {
  url: string; nodeId: string; token: string; ca?: Buffer; allowInsecureLan?: boolean;
  connected: (connection: PeerConnection) => void | Promise<void>;
  status?: (state: "connecting" | "connected" | "disconnected") => void;
  reconnectMs?: number;
  enroll?: boolean;
};
const loopback = (host: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
function checkIdentity(id: string, token: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || token.length < 32 || /[\r\n]/.test(token)) throw new Error("Peer identity/token is invalid (use at least 32 random token characters)");
}
function matches(a: string, b: string): boolean {
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
}

/** Listening and dialling expose the same PeerConnection contract. */
export class GatewayPeerServer {
  private constructor(private readonly server: http.Server | https.Server, private readonly sockets: WebSocketServer,
    readonly url: string) {}
  static async listen(options: PeerServerOptions): Promise<GatewayPeerServer> {
    if (!options.tls && !loopback(options.host) && !options.allowInsecureLan) throw new Error("Peer LAN ingress requires TLS or explicit allowInsecureLan");
    if (!Object.keys(options.credentials).length && !options.deviceStore) throw new Error("Peer ingress requires device credentials");
    if (options.enrollment && !options.deviceStore) throw new Error("Enrollment requires a persistent device store");
    for (const [id, token] of Object.entries(options.credentials)) checkIdentity(id, token);
    const response: http.RequestListener = (_req, res) => { res.writeHead(404).end(); };
    const server = options.tls ? https.createServer(options.tls, response) : http.createServer(response);
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
    const pending = new Set<PeerConnection>();
    let windowStart = Date.now(), enrollments = 0;
    server.on("upgrade", (request, socket, head) => {
      const id = request.headers["x-gateway-peer-id"], authorization = request.headers.authorization;
      const expected = typeof id === "string" && Object.hasOwn(options.credentials, id) ? options.credentials[id] : undefined;
      const secret = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      const valid = typeof id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(id) && secret.length >= 32 && secret.length <= 512 && !/[\r\n]/.test(secret);
      const authenticated = valid && (expected !== undefined ? matches(authorization!, `Bearer ${expected}`) : options.deviceStore?.matches(id, secret));
      // Never downgrade a known ID with an invalid secret into enrollment.
      const enrolling = valid && !authenticated && expected === undefined && !options.deviceStore?.has(id)
        && options.enrollment && request.headers["x-gateway-peer-enroll"] === "1";
      if (request.url !== "/gateway/v1/peer" || request.headers.origin || !(authenticated || enrolling)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
      }
      if (enrolling) {
        if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); enrollments = 0; }
        if (pending.size >= 64 || ++enrollments > 64) {
          socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
        }
      }
      sockets.handleUpgrade(request, socket, head, websocket => {
        const connection = new PeerConnection(websocket);
        let enrollment: PeerEnrollment | undefined;
        if (enrolling) {
          pending.add(connection);
          const timer = setTimeout(() => connection.close(), 5 * 60_000); timer.unref();
          connection.onClose(() => { pending.delete(connection); clearTimeout(timer); });
          enrollment = { commit(principal) {
            if (!connection.open || !pending.has(connection)) throw new Error("Enrollment connection expired");
            options.deviceStore!.enroll(id as string, secret, principal);
            pending.delete(connection); clearTimeout(timer);
          } };
        }
        try { options.accept(id as string, connection, enrollment); }
        catch { websocket.terminate(); }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => {
        server.removeListener("error", reject); resolve();
      }); });
    } catch (error) { sockets.close(); throw error; }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Peer ingress did not bind a TCP port");
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    return new GatewayPeerServer(server, sockets, `${options.tls ? "wss" : "ws"}://${host}:${address.port}/gateway/v1/peer`);
  }
  async close(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate();
    await new Promise<void>(resolve => this.sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}

export class GatewayPeerClient {
  private socket?: WebSocket;
  private connection?: PeerConnection;
  private retry?: NodeJS.Timeout;
  private stopped = true;
  constructor(private readonly options: PeerClientOptions) {
    checkIdentity(options.nodeId, options.token);
    const url = new URL(options.url);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== "/gateway/v1/peer") throw new Error("Invalid peer URL");
    if (url.protocol !== "wss:" && !loopback(url.hostname) && !options.allowInsecureLan) throw new Error("Peer LAN connection requires wss or explicit allowInsecureLan");
  }
  start(): void { if (this.stopped) { this.stopped = false; this.dial(); } }
  private dial(): void {
    if (this.stopped) return;
    this.options.status?.("connecting");
    const socket = new WebSocket(this.options.url, { headers: { authorization: `Bearer ${this.options.token}`, "x-gateway-peer-id": this.options.nodeId,
      ...(this.options.enroll ? { "x-gateway-peer-enroll": "1" } : {}) },
      ca: peerCertificateAuthority(this.options.url, this.options.ca), rejectUnauthorized: true,
      followRedirects: false, maxPayload: 1024 * 1024, handshakeTimeout: 10_000, perMessageDeflate: false });
    this.socket = socket;
    socket.on("error", () => {});
    socket.once("open", () => {
      if (this.stopped || this.socket !== socket) { socket.terminate(); return; }
      const connection = this.connection = new PeerConnection(socket);
      void Promise.resolve().then(() => this.options.connected(connection)).then(() => {
        if (connection.open) this.options.status?.("connected");
      }, () => connection.close());
    });
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined; this.connection = undefined; this.options.status?.("disconnected");
      if (!this.stopped) this.retry = setTimeout(() => this.dial(), this.options.reconnectMs ?? 2000);
    });
  }
  close(): void { this.stopped = true; clearTimeout(this.retry); this.socket?.terminate(); this.connection = undefined; }
}
