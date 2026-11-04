import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { IDEHostTransport, IDEHostContext, IDELaunchInput, IDELaunch } from "../ide/transport.js";
import { parseProfileStatus } from "../ide/transport.js";
import { IDEInstallPendingError } from "../ide/installer.js";
import type { IDEProfileStatus } from "../ide/profile.js";
import { PeerRegistry } from "./registry.js";
import { PeerConnection, PeerError } from "./rpc.js";
import { PeerIDEStreams } from "./ide-stream.js";
import { peerIDETargetSchema } from "./ide-service.js";

/** The local/SSH implementation stays intact. Connector targets use the same
 * IDE manager and access server, with only this socket transport substituted. */
export class ConnectorIDEHostTransport implements IDEHostTransport {
  private readonly multiplexers = new WeakMap<PeerConnection, PeerIDEStreams>();
  constructor(private readonly registry: PeerRegistry, private readonly fallback: IDEHostTransport) {}
  canAccess(hostId: string, context: IDEHostContext): boolean {
    return hostId.startsWith("peer:") ? this.registry.canAccessIDE(hostId, context) : this.fallback.canAccess?.(hostId, context) ?? true;
  }
  private session(hostId: string, context?: IDEHostContext) {
    if (!context) throw new PeerError("access", "Connector IDE requires a browser identity");
    return { ...this.registry.ideConnection(hostId, context), target: peerIDETargetSchema.parse({ threadId: context.threadId,
      workspace: context.workspace, rootPaths: context.rootPaths }) };
  }
  async preparationStatus(hostId: string, context: IDEHostContext) {
    const { connection, grant, guard, target } = this.session(hostId, context); guard();
    const result = await connection.request("ide.call", { method: "status", grant, target }); guard();
    return z.object({ phase: z.enum(["checking", "remote-download", "gateway-download", "transferring", "verifying", "ready", "error"]),
      bytes: z.number().nonnegative().optional(), total: z.number().positive().optional() }).strict().nullable().parse(result) ?? undefined;
  }
  async canonicalDirectory(hostId: string, workspace: string, context?: IDEHostContext): Promise<string> {
    if (!hostId.startsWith("peer:")) return this.fallback.canonicalDirectory(hostId, workspace, context);
    const { connection, grant, guard, target } = this.session(hostId, context); guard();
    const result = await connection.request("ide.call", { method: "resolve", grant, target, workspace }); guard();
    return z.object({ workspace: z.string().refine(p => path.posix.isAbsolute(p) && !/[\r\n\0]/.test(p)) }).strict().parse(result).workspace;
  }
  async launch(input: IDELaunchInput): Promise<IDELaunch> {
    if (!input.hostId.startsWith("peer:")) return this.fallback.launch(input);
    const { connection, grant, guard, target } = this.session(input.hostId, input.context); guard(); input.signal?.throwIfAborted();
    // Request timeout is not a stop acknowledgement. If cancellation races a
    // launch, wait for its lease receipt and retire that exact lease below.
    let result: { lease?: string; prepared?: true; workspaceFile?: string; profile?: IDEProfileStatus };
    try { result = await connection.request("ide.call", { method: "launch", grant, target, id: input.id,
      profile: { settings: input.settings, extensions: input.extensions }, prepare: input.prepare === true, trustWorkspace: input.trustWorkspace === true }, 210_000); }
    catch (error) { if (error instanceof PeerError && error.code === "install-pending") throw new IDEInstallPendingError(); throw error; }
    const receipt = z.object({ lease: z.string().uuid().optional(), prepared: z.literal(true).optional(),
      workspaceFile: z.string().refine(p => path.posix.isAbsolute(p) && p.endsWith("/project.code-workspace") && !/[\r\n\0]/.test(p)).optional(),
      profile: z.unknown().optional() }).strict().parse(result);
    const stopRemote = () => receipt.lease ? connection.request("ide.call", { method: "stop", grant, lease: receipt.lease }, 15000).then(() => {}, () => {}) : Promise.resolve();
    try { guard(); input.signal?.throwIfAborted(); } catch (error) { await stopRemote(); throw error; }
    const profile = result.profile && parseProfileStatus(JSON.stringify(result.profile), input.extensions);
    if (profile) input.onProfile?.(profile);
    if (input.prepare && receipt.prepared) return { socketPath: "", alive: () => false, stop: stopRemote };
    if (!receipt.lease) throw new Error("Connector IDE launch receipt missing");
    let streams = this.multiplexers.get(connection);
    if (!streams) { streams = new PeerIDEStreams(connection); this.multiplexers.set(connection, streams); }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cig-peer-ide-")); fs.chmodSync(temp, 0o700);
    const socketPath = path.join(temp, "ide.sock"), active = new Set<string>();
    let stopped = false, stopping: Promise<void> | undefined, unsubscribe = () => {};
    const server = net.createServer({ allowHalfOpen: true }, socket => {
      const stream = crypto.randomUUID(); socket.pause();
      try {
        guard(); if (stopped) throw new Error("IDE stopped");
        const resume = streams!.add(stream, socket, guard); active.add(stream);
        socket.once("close", () => active.delete(stream));
        void connection.request("ide.call", { method: "connect", grant, lease: receipt.lease, stream }, 20000)
          .then(() => { guard(); resume(); }).catch(() => streams!.close(stream));
      } catch { socket.destroy(); }
    });
    const stop = () => stopping ??= (async () => {
      stopped = true; unsubscribe();
      for (const id of active) streams!.close(id);
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await stopRemote(); fs.rmSync(temp, { recursive: true, force: true });
    })();
    try {
      server.on("error", () => { void stop(); });
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.off("error", reject); fs.chmodSync(socketPath, 0o600); resolve(); }); });
      unsubscribe = connection.onClose(() => { void stop(); });
      guard(); input.signal?.throwIfAborted();
      return { socketPath, workspaceFile: receipt.workspaceFile, alive: () => !stopped && connection.open, stop };
    } catch (error) { await stop(); throw error; }
  }
}
