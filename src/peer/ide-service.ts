import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import type { CodexBridgeBackend } from "../codex/backend.js";
import { ideConfigSchema } from "../ide/config.js";
import { CodeServerInstaller, IDEInstallPendingError } from "../ide/installer.js";
import { ProcessIDEHostTransport, type IDEHostTransport, type IDELaunch } from "../ide/transport.js";
import type { IDEProfileStatus } from "../ide/profile.js";
import { peerGrantSchema, type SharedPeerGrant } from "./sharing-types.js";
import { PeerConnection, PeerError } from "./rpc.js";
import { PeerIDEStreams } from "./ide-stream.js";

const directory = z.string().max(4096).refine(p => path.isAbsolute(p) && !/[\r\n\0]/.test(p));
export const peerIDETargetSchema = z.object({ threadId: z.string().min(1).max(512), workspace: directory,
  rootPaths: z.array(directory).min(2).max(32).optional() }).strict();
export const peerIDEConfigSchema = z.object({ enabled: z.boolean().default(false),
  dataRoot: directory.optional(), binary: ideConfigSchema.shape.hosts.element.shape.binary.default("code-server"), autoInstall: z.boolean().default(false) }).strict();
export type PeerIDEConfig = z.infer<typeof peerIDEConfigSchema>;
type Target = z.infer<typeof peerIDETargetSchema>;
const common = { grant: peerGrantSchema, target: peerIDETargetSchema };
const callSchema = z.discriminatedUnion("method", [
  z.object({ ...common, method: z.literal("resolve"), workspace: directory }).strict(),
  z.object({ ...common, method: z.literal("status") }).strict(),
  z.object({ ...common, method: z.literal("launch"), id: z.string().regex(/^[a-f0-9]{32}$/),
    profile: ideConfigSchema.shape.profile, prepare: z.boolean(), trustWorkspace: z.boolean() }).strict(),
  z.object({ grant: peerGrantSchema, method: z.literal("connect"), lease: z.string().uuid(), stream: z.string().uuid() }).strict(),
  z.object({ grant: peerGrantSchema, method: z.literal("stop"), lease: z.string().uuid() }).strict()
]);
type Lease = { grant: SharedPeerGrant; target: Target; launch?: IDELaunch; abort: AbortController; streams: Set<string>; timer?: NodeJS.Timeout; claimed: boolean; created: number };

/** The device owns executable selection, native membership and socket paths.
 * A Gateway can request this explicitly enabled capability only for a locally
 * approved owner. Text-sharing delegations never grant a shell. */
export class PeerIDEService {
  private readonly transport: IDEHostTransport;
  private readonly installer: CodeServerInstaller;
  private readonly leases = new Set<Lease>();
  private readonly checks = new Map<string, Promise<void>>();
  private readonly cleanups = new Set<() => Promise<void>>();
  private closed = false;
  constructor(private readonly options: { config: PeerIDEConfig; backend: CodexBridgeBackend; stateDir: string;
    authorize(grant: SharedPeerGrant, threadId: string): void; transport?: IDEHostTransport }) {
    this.transport = options.transport ?? new ProcessIDEHostTransport({ localDataRoot: options.config.dataRoot ?? path.join(options.stateDir, "ide", "instances") });
    this.installer = new CodeServerInstaller(path.join(options.stateDir, "ide"), { allowed: host => host === "local" && options.config.enabled && options.config.autoInstall });
  }
  private guard(grant: SharedPeerGrant, threadId: string): void {
    if (this.closed || !this.options.config.enabled || grant.delegation || grant.threadId && grant.threadId !== threadId)
      throw new PeerError("access", "完整 IDE 需要本机启用及本人的设备授权；文本共享不能授予终端。");
    this.options.authorize(grant, threadId);
  }
  private validate(grant: SharedPeerGrant, target: Target): Promise<void> {
    const key = JSON.stringify([grant, target]);
    let check = this.checks.get(key);
    if (!check) { check = this.validateCurrent(grant, target).finally(() => this.checks.delete(key)); this.checks.set(key, check); }
    return check;
  }
  private async validateCurrent(grant: SharedPeerGrant, target: Target): Promise<void> {
    this.guard(grant, target.threadId);
    const state = await this.options.backend.inspectThread(target.threadId, undefined, { includeTurns: false, timeoutMs: 5000 });
    this.guard(grant, target.threadId);
    if (state.threadId !== target.threadId || state.internal || state.persistence !== "active" || !state.cwd
      || state.projectMembership !== "assigned" || !state.projectId) throw new PeerError("scope", "无法确认 IDE 的原生项目归属。");
    const catalog = await this.options.backend.listProjects(undefined, { timeoutMs: 5000 });
    this.guard(grant, target.threadId);
    const project = catalog.projects.find(p => p.id === state.projectId);
    const canonical = (p: string) => { const result = fs.realpathSync(p); if (!fs.statSync(result).isDirectory()) throw new Error("Not a directory"); return result; };
    if (!project?.roots.length) throw new PeerError("scope", "原生项目目录不可用。");
    const cwd = canonical(state.cwd), roots = [...new Set(project.roots.map(canonical))];
    // Worktree replaces the native project's primary root; siblings stay in
    // the explicit root set. No ancestor or guessed nearby folder is included.
    const expected = roots.includes(cwd) ? roots : [cwd, ...roots.slice(1)];
    const requested = (target.rootPaths ?? [target.workspace]).map(canonical);
    if (canonical(target.workspace) !== cwd || !requested.includes(cwd) || new Set(requested).size !== requested.length
      || JSON.stringify([...expected].sort()) !== JSON.stringify([...requested].sort()))
      throw new PeerError("scope", "IDE 目录与当前原生项目不一致。");
  }
  attach(connection: PeerConnection): void {
    const streams = new PeerIDEStreams(connection), leases = new Map<string, Lease>();
    const stop = async (id: string) => {
      const lease = leases.get(id); if (!lease) return;
      leases.delete(id); this.leases.delete(lease); clearTimeout(lease.timer); lease.abort.abort();
      for (const stream of lease.streams) streams.close(stream);
      await lease.launch?.stop();
    };
    const cleanup = async () => { this.cleanups.delete(cleanup); await Promise.allSettled([...leases.keys()].map(stop)); };
    this.cleanups.add(cleanup);
    connection.onClose(() => { void cleanup(); });
    connection.handle("ide.call", async raw => {
      const call = callSchema.parse(raw);
      if (call.method === "stop" || call.method === "connect") {
        const lease = leases.get(call.lease);
        if (!lease || JSON.stringify(lease.grant) !== JSON.stringify(call.grant)) throw new PeerError("access", "IDE lease is unavailable");
        // Cleanup remains possible after revocation, without granting new IO.
        if (call.method === "stop") { await stop(call.lease); return; }
        await this.validate(lease.grant, lease.target);
        if (!connection.open || leases.get(call.lease) !== lease || !lease.launch?.alive()) throw new PeerError("stale", "IDE lease ended");
        lease.claimed = true;
        const socket = net.createConnection({ path: lease.launch.socketPath, allowHalfOpen: true });
        const resume = streams.add(call.stream, socket, () => {
          this.guard(lease.grant, lease.target.threadId);
          if (leases.get(call.lease) !== lease || !connection.open) throw new PeerError("stale", "IDE lease ended");
        });
        lease.streams.add(call.stream); socket.once("close", () => lease.streams.delete(call.stream));
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { socket.destroy(); reject(new Error("IDE connect timeout")); }, 10000);
            socket.once("connect", () => { clearTimeout(timer); resolve(); });
            socket.once("error", e => { clearTimeout(timer); reject(e); });
            socket.once("close", () => { clearTimeout(timer); reject(new Error("IDE connection closed")); });
          });
          resume(); return;
        } catch (error) { streams.close(call.stream); throw error; }
      }
      await this.validate(call.grant, call.target);
      if (!connection.open) throw new PeerError("stale", "IDE connection ended");
      if (call.method === "status") {
        const status = this.installer.list().find(s => s.hostId === "local");
        return status ? { phase: status.phase, bytes: status.bytes, total: status.total } : null;
      }
      if (call.method === "resolve") {
        if (![call.target.workspace, ...(call.target.rootPaths ?? [])].includes(call.workspace)) throw new PeerError("scope", "Directory is not an IDE root");
        return { workspace: await this.transport.canonicalDirectory("local", call.workspace) };
      }
      if (this.leases.size >= 8) throw new PeerError("busy", "Device IDE limit reached");
      let binary = this.options.config.binary;
      if (this.options.config.autoInstall && binary === "code-server") {
        try { binary = await this.installer.binary("local"); }
        catch (error) { if (error instanceof IDEInstallPendingError) throw new PeerError("install-pending", "设备正在安装官方 code-server，请稍后重试。"); throw error; }
      }
      this.guard(call.grant, call.target.threadId);
      if (!connection.open || this.leases.size >= 8) throw new PeerError("busy", "Device IDE limit reached or disconnected");
      const id = crypto.randomUUID(), lease: Lease = { grant: call.grant, target: call.target, abort: new AbortController(), streams: new Set(), claimed: false, created: Date.now() };
      leases.set(id, lease); this.leases.add(lease);
      let profile: IDEProfileStatus | undefined;
      try {
        lease.launch = await this.transport.launch({ hostId: "local", workspace: fs.realpathSync(call.target.workspace),
          rootPaths: call.target.rootPaths?.map(p => fs.realpathSync(p)),
          id: crypto.createHash("sha256").update(JSON.stringify([call.grant.principal, call.id])).digest("hex").slice(0, 32),
          binary, ...call.profile, prepare: call.prepare, trustWorkspace: call.trustWorkspace,
          signal: lease.abort.signal, onProfile: p => { profile = p; } });
        await this.validate(call.grant, call.target);
        if (!connection.open || leases.get(id) !== lease) { await lease.launch.stop(); throw new PeerError("stale", "IDE launch cancelled"); }
        if (call.prepare) { await stop(id); return { prepared: true, profile }; }
        const verify = async () => {
          try { await this.validate(lease.grant, lease.target); if (!lease.launch?.alive() || !lease.claimed && Date.now() - lease.created > 240000) throw new Error("IDE stopped or unclaimed"); }
          catch { await stop(id); return; }
          if (leases.get(id) === lease) { lease.timer = setTimeout(verify, 10000); lease.timer.unref(); }
        };
        lease.timer = setTimeout(verify, 10000); lease.timer.unref();
        return { lease: id, workspaceFile: lease.launch.workspaceFile, profile };
      } catch (error) { await stop(id); await lease.launch?.stop(); throw error; }
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.installer.close();
    await Promise.allSettled([...this.cleanups].map(cleanup => cleanup()));
  }
}
