import { peerWriteGuard } from "./write-guard.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CodexBridgeBackend, CodexThreadCreateInput } from "../codex/backend.js";
import { CodexBackendCapabilityError } from "../codex/backend.js";
import { PeerConnection, PeerError } from "./rpc.js";
import type { PeerGrant } from "./registry.js";
import type { PeerReceipts } from "./receipts.js";
import { SessionControlQueue } from "../bridge/session-control.js";

export const MANAGEMENT_METHODS = ["createThread", "renameThread", "archiveThread", "unarchiveThread", "deleteThread"] as const;
const identity = z.string().min(1).max(512);
const createSchema = z.object({ cwd: z.string().min(1).max(16384).optional(), projectId: identity.optional(), projectName: z.string().max(200).optional(),
  title: z.string().trim().min(1).max(120).optional(), standalone: z.boolean().optional(), projectBinding: z.literal("none").optional(),
  sourceThreadId: identity.optional(),
  clientUserMessageId: z.string().max(1024).optional() }).strict();
const lifecycleSchema = z.object({ threadId: identity, title: z.string().trim().min(1).max(120).optional(), clientUserMessageId: z.string().max(1024).optional() }).strict();

/** Native metadata writes only. Project paths must match the device catalog
 * or a confirmed worktree. Whole-device grants may also explicitly select an
 * unassigned directory; fixed-thread/delegated grants cannot create sessions. */
export class PeerManagement {
  private readonly queue = new SessionControlQueue();
  constructor(private readonly backend: CodexBridgeBackend, private readonly stateDir: string, private readonly receipts: PeerReceipts) {}
  async call(grant: PeerGrant, connection: PeerConnection, method: string, raw: unknown, operationId?: string, assertAccess?: () => void): Promise<unknown> {
    if (!operationId) throw new PeerError("identity", "Management writes require a durable source identity");
    const data = method === "createThread" ? createSchema.parse(raw) : lifecycleSchema.parse(raw);
    if (method === "renameThread" && !data.title) throw new PeerError("unsupported", "A session title is required");
    if (method === "createThread" && grant.scope !== "device") throw new PeerError("access", "A fixed-session grant cannot create other sessions");
    const threadId = "threadId" in data ? data.threadId : "new";
    if (grant.threadId && grant.threadId !== threadId) throw new PeerError("scope", "Only the granted thread may be managed");
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([method, data])).digest("hex");
    const previous = () => {
      const prior = this.receipts.get(operationId);
      if (prior && prior.fingerprint !== fingerprint) throw new PeerError("identity", "The management request identity was reused for different input");
      if (prior && prior.phase !== "not-submitted") {
        if (prior.phase === "completed") return prior;
        throw new PeerError("receipt", "The original management operation was not replayed; check the device session catalog", prior);
      }
      return undefined;
    };
    // A retry must not wait behind the original operation after a lost reply.
    const cached = previous();
    if (cached) return cached.result;
    return this.queue.run(method === "createThread" ? operationId : threadId, async () => {
      const queued = previous();
      if (queued) return queued.result;
      const assertCurrent = peerWriteGuard(connection, operationId, method, () => { assertAccess?.(); });
      assertCurrent();
      let input: CodexThreadCreateInput | undefined;
      if (method === "createThread") {
        if (!this.backend.createThread || !this.backend.backendInfo().capabilities.threadLifecycle) throw new PeerError("unsupported", "This device cannot create native sessions");
        input = await this.creationInput(data as z.infer<typeof createSchema>, operationId);
      } else {
        const state = await this.backend.inspectThread(threadId);
        if (state.threadId !== threadId || state.internal || !["active", "archived"].includes(state.persistence) || !state.cwd || !path.isAbsolute(state.cwd))
          throw new PeerError("scope", "The selected native session is unavailable");
        if (state.activeTurnId || state.pendingTurnWithoutId || state.activeFlags.length || state.runtimeStatus === "active" || state.latestTurnStatus === "inProgress")
          throw new PeerError("busy", "The session has active work; management did not interrupt it");
        if (state.persistence === "active" && !["idle", "notLoaded"].includes(state.runtimeStatus))
          throw new PeerError("busy", "The session's idle state is not confirmed");
        if (method === "renameThread" && (!this.backend.renameThread || !this.backend.backendInfo().capabilities.threadNaming))
          throw new PeerError("unsupported", "This device cannot rename native sessions");
        if (method !== "renameThread" && !this.backend.backendInfo().capabilities.threadLifecycle)
          throw new PeerError("unsupported", "This device cannot change native session lifecycle");
        if (method === "deleteThread" && state.persistence !== "archived") throw new PeerError("scope", "Only an already archived session may be deleted remotely");
        if ((method === "archiveThread" || method === "deleteThread") && state.persistence === "active"
          && this.backend.backendInfo().capabilities.nativeQueue && this.backend.listQueuedSubmissions) {
          const queue = await this.backend.listQueuedSubmissions(threadId);
          if (queue.data.length || queue.nextCursor) throw new PeerError("busy", "The session has queued work; management did not interrupt it");
        }
      }
      // Check the origin after all asynchronous metadata reads, before intent.
      try { await connection.request("execution.callback", { operationId, name: "assertCurrent", args: [] }); }
      catch { throw new PeerError("codex-communication", "Management is no longer authorized", { phase: "preflight", operation: method }); }
      assertCurrent(); this.receipts.begin(operationId, fingerprint, threadId, method);
      try {
        let result: unknown;
        if (method === "createThread") {
          const state = await this.backend.createThread!({ ...input, assertCurrent, onThreadCreated: async id => {
            this.receipts.created(operationId, id);
            await connection.request("execution.callback", { operationId, name: "onThreadCreated", args: [id] });
          } });
          if (!state.threadId || state.persistence !== "active" || state.internal || state.cwd !== input!.cwd)
            throw new PeerError("scope", "Native creation did not confirm the selected workspace");
          this.receipts.created(operationId, state.threadId); result = state;
        } else if (method === "renameThread") {
          const title = (data as z.infer<typeof lifecycleSchema>).title;
          if (!title) throw new PeerError("unsupported", "A session title is required");
          result = await this.backend.renameThread!(threadId, title, undefined, assertCurrent);
        } else if (method === "archiveThread") {
          await this.backend.archiveThread(threadId, undefined, assertCurrent); result = { threadId };
        } else if (method === "unarchiveThread") {
          result = await this.backend.unarchiveThread(threadId, undefined, assertCurrent);
        } else if (method === "deleteThread") {
          await this.backend.deleteThread(threadId, undefined, assertCurrent); result = { threadId };
        } else throw new PeerError("unsupported", "Unknown session management operation");
        this.receipts.complete(operationId, result); return result;
      } catch (error) {
        if (this.receipts.get(operationId)?.phase !== "accepted") this.receipts.failed(operationId, error instanceof CodexBackendCapabilityError);
        throw error;
      }
    });
  }
  private async creationInput(data: z.infer<typeof createSchema>, operationId: string): Promise<CodexThreadCreateInput & { cwd: string }> {
    if (data.standalone) {
      if (data.projectId || data.cwd || data.projectName) throw new PeerError("scope", "Standalone creation cannot select a project or path");
      let cwd = fs.realpathSync(this.stateDir);
      for (const part of ["workspaces", operationId]) {
        cwd = path.join(cwd, part);
        try { fs.mkdirSync(cwd, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        if (fs.lstatSync(cwd).isSymbolicLink() || !fs.statSync(cwd).isDirectory() || fs.realpathSync(cwd) !== cwd)
          throw new PeerError("scope", "The device workspace is unavailable");
      }
      return { cwd, title: data.title, projectBinding: "none" };
    }
    // Whole-device approval permits the same explicit unassigned workspace as
    // the native facade. Fixed-thread and delegated grants were rejected above.
    if (!data.projectId && data.cwd && !data.projectName) {
      if (!path.isAbsolute(data.cwd)) throw new PeerError("scope", "Workspace must be absolute");
      const cwd = fs.realpathSync(data.cwd);
      if (!fs.statSync(cwd).isDirectory()) throw new PeerError("scope", "Workspace is unavailable");
      return { cwd, title: data.title, projectBinding: data.projectBinding };
    }
    if (!data.projectId || data.projectBinding === "none") throw new PeerError("scope", "Select a device project or request a standalone session");
    const catalog = await this.backend.listProjects(), project = catalog.projects.find(p => p.id === data.projectId);
    if (!project) throw new PeerError("scope", "The selected project is no longer in the device catalog");
    const requested = data.cwd ?? project.roots[0];
    if (!requested || !path.isAbsolute(requested)) throw new PeerError("scope", "The project workspace is unavailable");
    const cwd = fs.realpathSync(requested);
    const rootMatches = project.roots.some(root => {
      try { return path.isAbsolute(root) && fs.realpathSync(root) === cwd; } catch { return false; }
    });
    let sameWorktree = false;
    if (!rootMatches && data.sourceThreadId) {
      const source = await this.backend.inspectThread(data.sourceThreadId);
      sameWorktree = source.threadId === data.sourceThreadId && source.persistence === "active" && !source.internal
        && source.projectId === project.id && Boolean(source.cwd && fs.realpathSync(source.cwd) === cwd);
    }
    if (!fs.statSync(cwd).isDirectory() || !rootMatches && !sameWorktree)
      throw new PeerError("scope", "New sessions must use a selected project root or its confirmed existing worktree");
    return { cwd, projectId: project.id, projectName: project.name, title: data.title };
  }
}
