import { PeerRecoveryJournal } from "./recovery-journal.js";
import { peerOperationId } from "./identity.js";
import { PeerInteractionService } from "./interaction-service.js";
import { peerWriteGuard } from "./write-guard.js";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { assertCodexThreadRunnable, CodexBackendCapabilityError, CodexQueueAdmissionError, CodexInterventionError, CodexThreadStateError, CodexRunAdmissionError, CodexTurnExecutionError,
  type CodexBridgeBackend, type CodexRunnerInput, type CodexInputReceipt, type CodexThreadState } from "../codex/backend.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { approvalOptions, type CodexApprovalDecision } from "../codex/approval.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { grantSchema, type PeerGrant, type PeerDescription } from "./registry.js";
import { PeerReceipts } from "./receipts.js";
import { PeerConnection, PeerError, PEER_EXECUTION_TIMEOUT_MS } from "./rpc.js";
import { FILE_METHODS, PeerFiles } from "./files.js";
import { MANAGEMENT_METHODS, PeerManagement } from "./management.js";
import { PeerSharingAuthority, type OwnerConfirmation } from "./sharing-authority.js";
import { PeerIDEService, type PeerIDEConfig } from "./ide-service.js";
import { matchesManagedGrant, type ManagedConnectorExport } from "./managed-route.js";
import { CodexSessionCompletionMonitor } from "../server/codex-session-monitor.js";
import { PeerHostDirectories } from "./host-directories.js";
import { SharedWorkspaceHost } from "./shared-workspace.js";

const callSchema = z.object({ grant: grantSchema, method: z.enum(["monitorSessionEvents", "unmonitorSessionEvents", "listSessionCatalog", "inspectThread", "readThreadSnapshot", "readTurnLifecycle", "readTurnActivities", "getHistory", "getHistoryPage",
  "getRuntimeInfo", "updateThreadSettings", "warmUp", "listSkills", "listMcpServers", "serverIdentity", "readThreadProvenance", "listQueuedSubmissions", "addQueuedSubmission", "deleteQueuedSubmission", "runQueuedSubmission", "resumeAfterCapacity", "recoverSystemError", "listModels", "getAccountRateLimits", "listProjects", "run", "steer", "submitThreadMessage", "stop", "interruptTurn", "getGoal", "setGoal", "clearGoal", "receipt", "observeThreadInteractions", "unobserveThreadInteractions", ...FILE_METHODS, ...MANAGEMENT_METHODS]),
  args: z.array(z.unknown()).max(4), operationId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const runSchema = z.object({ threadId: z.string().optional(), ephemeral: z.boolean().optional(), cwd: z.string(), prompt: z.string().max(500_000), clientUserMessageId: z.string().optional(),
  developerInstructions: z.string().optional(), threadTitle: z.string().optional(), model: z.string().optional(), effort: z.string().optional(),
  projectId: z.string().optional(), projectName: z.string().optional(), projectRoots: z.array(z.string()).max(1000).optional(), projectBinding: z.literal("none").optional(),
  collaborationMode: z.enum(["default", "plan"]).optional(), outputSchema: z.record(z.string(), z.unknown()).optional(),
  expectedTurnId: z.string().optional(), queueKey: z.string().optional(),
  dynamicTools: z.array(z.record(z.string(), z.unknown())).optional(), _dynamicToolCallback: z.boolean().optional(),
  nativeSettings: z.object({ sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
    approvalPolicy: z.enum(["untrusted", "on-request", "never"]), approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]),
    runtimeWorkspaceRoots: z.array(z.string()) }).strict().optional(),
  imagePaths: z.array(z.string()).optional(), sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional() }).strict();
const metadataObservation = z.object({ timeoutMs: z.number().int().positive().max(120000), purpose: z.literal("status").optional() }).strict().optional();
const observationSchema = z.object({ includeTurns: z.literal(false), timeoutMs: z.number().int().positive().max(120000), purpose: z.literal("status").optional() }).strict().optional();
const queueAddSchema = z.object({ threadId: z.string().min(1), prompt: z.string().max(500000), clientUserMessageId: z.string().min(1), enqueueOnly: z.boolean().optional() }).strict();
const queuedRunSchema = runSchema.omit({ prompt: true }).extend({ threadId: z.string().min(1), queuedSubmissionId: z.string().optional(), acceptedTurnId: z.string().optional(), observeOnly: z.boolean().optional() });
const capacitySchema = z.object({ threadId: z.string().min(1), failedTurnId: z.string().min(1), clientUserMessageId: z.string().min(1) }).strict();
const recoverySchema = z.object({ threadId: z.string().min(1), failedTurnId: z.string().min(1), lifecycle: z.object({ restoring: z.boolean().optional(), archiveConfirmed: z.boolean().optional() }).strict().optional() }).strict();
const writes = new Set(["updateThreadSettings", "run", "steer", "submitThreadMessage", "stop", "interruptTurn", "setGoal", "clearGoal", "addQueuedSubmission", "deleteQueuedSubmission", "runQueuedSubmission", "resumeAfterCapacity", "recoverSystemError"]);
const goalSchema = z.object({ objective: z.string().max(500000).optional(), status: z.enum(["active", "paused", "complete", "blocked", "usageLimited", "budgetLimited"]).optional(), tokenBudget: z.number().int().positive().optional() }).strict();
const catalogSchema = z.object({ cwd: z.string().optional(), projectId: z.string().optional(), unassigned: z.boolean().optional(),
  persistence: z.enum(["active", "archived", "all"]).optional(), limit: z.number().int().min(1).max(1000).optional() }).strict();
export type PeerExecutionOptions = {
  backend: CodexBridgeBackend; threadId?: string; profileId: string; label?: string; stateDir: string;
  /** True only for an independently managed native daemon, never private exec. */
  independent?: boolean;
  approve: (grant: PeerGrant) => Promise<boolean>;
  approveOwner?: (confirmation: OwnerConfirmation) => Promise<boolean>;
  webIDE?: PeerIDEConfig;
  managedRoute?: ManagedConnectorExport;
  codexHome?: string;
  nativeHostId?: string;
  inheritedDeviceGrant?: (grant: PeerGrant) => boolean;
};

/** Pair a local Codex profile with a chat, then choose sessions in the chat.
 * An optional threadId narrows the export to one existing session. */
export class PeerExecutionService {
  readonly description: PeerDescription;
  private grants: PeerGrant[];
  private privatePolicy = false;
  private readonly receipts: PeerReceipts;
  private readonly recovery: PeerRecoveryJournal;
  private readonly files: PeerFiles;
  private readonly queueLeases = new WeakMap<PeerConnection, Map<string, () => void>>();
  private readonly management: PeerManagement;
  private readonly interactions: PeerInteractionService;
  private readonly sharing: PeerSharingAuthority;
  private readonly ide?: PeerIDEService;
  private constructor(private readonly options: PeerExecutionOptions, description: PeerDescription) {
    this.description = description;
    this.recovery = new PeerRecoveryJournal(options.stateDir);
    const stored = readJsonFile<unknown>(path.join(options.stateDir, "grants.json"), []);
    if (Array.isArray(stored)) this.grants = z.array(grantSchema).parse(stored);
    else { this.grants = z.object({ version: z.literal(2), grants: z.array(grantSchema) }).strict().parse(stored).grants; this.privatePolicy = true; }
    this.receipts = new PeerReceipts(path.join(options.stateDir, "receipts.json"));
    this.files = new PeerFiles(options.stateDir, (id, write) => this.readState(id, write), grant => matchesManagedGrant(options.managedRoute, grant),
      options.nativeHostId && options.nativeHostId !== "local" ? options.backend : undefined);
    this.interactions = new PeerInteractionService(options.backend);
    this.management = new PeerManagement(options.backend, options.stateDir, this.receipts, new PeerHostDirectories(options.nativeHostId, options.codexHome));
    this.sharing = new PeerSharingAuthority(path.join(options.stateDir, "sharing.json"), options.backend, options.approveOwner ?? (async () => false), Date.now, new SharedWorkspaceHost(options.nativeHostId, options.codexHome));
    if (options.webIDE?.enabled) this.ide = new PeerIDEService({ config: options.webIDE, backend: options.backend, stateDir: options.stateDir, managedRoute: options.managedRoute, nativeHostId: options.nativeHostId, codexHome: options.codexHome,
      authorize: (grant, threadId) => {
        this.assertThread(threadId);
        if (grant.delegation || !(matchesManagedGrant(options.managedRoute, grant) || options.inheritedDeviceGrant?.(grant) || this.grants.some(g => JSON.stringify(g) === JSON.stringify(grant)))) throw new PeerError("access", "设备授权已失效。");
        this.sharing.assert(grant, "inspectThread", [threadId]);
      } });
    if (this.sharing.hasResources() && !this.privatePolicy) this.saveGrants(this.grants, true);
  }
  private saveGrants(grants: PeerGrant[], privatePolicy = this.privatePolicy): void {
    // An old Connector expects an array and must refuse this format instead
    // of silently bypassing locally confirmed ownership after a downgrade.
    writeJsonFile(path.join(this.options.stateDir, "grants.json"), privatePolicy ? { version: 2, grants } : grants, { durable: true });
    this.grants = grants; this.privatePolicy = privatePolicy;
  }
  /** A full-profile pairing covers its exported hosts; fixed thread and shared
   * grants cannot inherit authority to another host, even for an identical ID. */
  authorizesDevice(grant: PeerGrant): boolean {
    return grant.scope === "device" && !grant.threadId && !grant.delegation && this.grants.some(g =>
      g.scope === "device" && !g.delegation && JSON.stringify({ ...grant, hostId: g.hostId }) === JSON.stringify(g));
  }
  confirmOwner(confirmation: OwnerConfirmation): Promise<boolean> { return this.options.approveOwner?.(confirmation) ?? Promise.resolve(false); }
  static async create(options: PeerExecutionOptions): Promise<PeerExecutionService> {
    if (options.managedRoute && options.threadId) throw new Error("Managed Connector exports a host, not a single thread");
    if (!/^[\w-]{1,80}$/.test(options.profileId)) throw new Error("Invalid peer profile ID");
    const state = options.threadId ? await options.backend.inspectThread(options.threadId) : undefined;
    if (state) {
      if (state.persistence === "active") assertCodexThreadRunnable(state);
      if (state.internal || !["active", "archived"].includes(state.persistence) || !state.cwd || !path.isAbsolute(state.cwd)) throw new Error("Select an existing ordinary Codex thread with a confirmed local cwd");
    }
    const info = options.backend.backendInfo();
    const capabilities = { ...info.capabilities,
      skills: info.capabilities.skills === true && !!options.backend.listSkills,
      mcpServers: info.capabilities.mcpServers === true && !!options.backend.listMcpServers,
      nativeQueue: info.capabilities.nativeQueue === true && !!options.backend.addQueuedSubmission && !!options.backend.runQueuedSubmission && !!options.backend.listQueuedSubmissions && !!options.backend.deleteQueuedSubmission,
      projectCatalog: !options.threadId && info.capabilities.projectCatalog,
      projects: !options.threadId && info.capabilities.projects };
    const service = new PeerExecutionService(options, { profileId: options.profileId, label: options.label,
      ...(options.managedRoute ? { managedHost: options.managedRoute.hostId } : {}),
      writeGuard: 1, nativeContract: 1,
      ...(options.webIDE?.enabled ? { fullIDE: 1 as const } : {}),
      ...(options.backend.observeThreadInteractions ? { interactions: 1 as const } : {}),
      files: { version: 1 },
      management: { version: 1 },
      sharing: { version: 2 },
      thread: state ? { ...state, cwd: state.cwd! } : undefined,
      info: { id: info.id, capabilities }, independent: options.independent === true });
    await service.recovery.restorePending(options.backend);
    return service;
  }
  attach(connection: PeerConnection): void {
    const monitors = new Map<string, () => void>();
    connection.onClose(() => { for (const stop of monitors.values()) stop(); });
    this.ide?.attach(connection);
    const queues = new Map<string, () => void>(); this.queueLeases.set(connection, queues);
    connection.onClose(() => { this.files.close(connection); for (const retire of queues.values()) retire(); });
    const approved = (grant: PeerGrant) => matchesManagedGrant(this.options.managedRoute, grant) || this.options.inheritedDeviceGrant?.(grant) === true
      || (!this.options.managedRoute && (grant.delegation ? this.sharing.valid(grant) : this.grants.some(g => JSON.stringify(g) === JSON.stringify(grant))));
    connection.handle("sharing.call", async value => {
      const call = z.object({ method: z.enum(["claim", "status", "invite", "request", "approve", "deny", "revoke", "workspace.list", "workspace.read", "workspace.write"]), input: z.unknown(), grant: grantSchema.optional() }).strict().parse(value);
      if (call.method !== "request" && (!call.grant || !approved(call.grant))) throw new PeerError("access", "资源授权未获本机确认或已失效。");
      if (call.method === "request" && call.grant) throw new PeerError("scope", "访问申请不能携带其他人的授权。");
      if (call.method === "claim" && !this.privatePolicy) this.saveGrants(this.grants, true);
      return this.sharing.call(call.method, call.input, call.grant, () => {
        if (!connection.open || call.grant && !approved(call.grant)) throw new PeerError("access", "连接或授权已失效。");
      });
    });
    connection.handle("binding.approve", async value => {
      if (this.options.managedRoute) return false;
      const grant = grantSchema.parse(value);
      const allowedScope = this.description.thread ? grant.threadId === this.description.thread.threadId && !grant.scope : grant.scope === "device";
      if (!allowedScope || !await this.options.approve(grant) || !connection.open) return false;
      const next = [...this.grants.filter(g => g.id !== grant.id), grant];
      this.saveGrants(next);
      return true;
    });
    connection.handle("execution.call", async value => {
      const call = callSchema.parse(value);
      if (!approved(call.grant))
        throw new PeerError("access", "This chat/session grant was not approved on this device");
      try {
        if (call.method === "monitorSessionEvents" || call.method === "unmonitorSessionEvents") {
          if (!matchesManagedGrant(this.options.managedRoute, call.grant) || this.options.managedRoute?.hostId !== "local")
            throw new PeerError("access", "Profile monitoring requires the configured local deployment route");
          if (call.method === "unmonitorSessionEvents") { monitors.get(z.string().parse(call.args[0]))?.(); return null; }
          if (!call.operationId || monitors.size) throw new PeerError("busy", "Profile monitor already registered");
          const send = (name: string) => (event: unknown) => connection.request("execution.callback", { operationId: call.operationId, name, args: [event] }).then(() => {});
          const monitor = new CodexSessionCompletionMonitor({ codexHome: this.options.codexHome,
            onCompletion: send("onCompletion"), onRecoveredCompletion: send("onRecoveredCompletion"), onTaskChanged: send("onTaskChanged"), onActivity: send("onActivity") });
          const closed = new Promise<void>(resolve => monitors.set(call.operationId!, resolve));
          monitor.start();
          try { await monitor.ready(); await send("onReady")(null); await closed; }
          finally { monitors.delete(call.operationId); await monitor.stop(); }
          return null;
        }
        await this.sharing.verify(call.grant, call.method, call.args);
        const assertAccess = (args = call.args) => {
          if (!approved(call.grant) || !connection.open) throw new PeerError("access", "连接或设备授权已失效。");
          this.sharing.assert(call.grant, call.method, args);
        };
        if ((FILE_METHODS as readonly string[]).includes(call.method)) return await this.files.call(call.grant, connection, call.method, call.args[0], threadId => assertAccess([{ threadId }]));
        if ((MANAGEMENT_METHODS as readonly string[]).includes(call.method)) return await this.management.call(call.grant, connection, call.method, call.args[0], call.operationId, () => assertAccess());
        if (["observeThreadInteractions", "unobserveThreadInteractions"].includes(call.method)) {
          await this.readState(call.args[0]); this.assertThread(call.args[0]);
          const id = z.string().regex(/^[a-f0-9]{64}$/).parse(call.method === "observeThreadInteractions" ? call.operationId : call.args[1]);
          return await this.interactions.call(connection, call.method, call.args[0], id, () => {
            if (!approved(call.grant)) throw new PeerError("access", "交互授权已失效。");
            this.sharing.assert(call.grant, call.method, call.args);
          });
        }
        const result = await this.execute(connection, call);
        this.sharing.assert(call.grant, call.method, call.args);
        return result;
      }
      catch (error) {
        if (error instanceof PeerError) throw error;
        if (error instanceof CodexCommunicationError) throw new PeerError("codex-communication", "Codex communication was not confirmed", {
          phase: error.phase, operation: error.operation, threadId: error.threadId, turnId: error.turnId });
        if (error instanceof CodexBackendCapabilityError) throw new PeerError("capability", "The selected Codex profile does not support this operation", { capability: error.capability });
        if (error instanceof CodexQueueAdmissionError) throw new PeerError("queue-admission", error.message);
        if (error instanceof CodexThreadStateError) throw new PeerError("thread-state", error.message, {
          code: error.code, threadId: error.threadId, lastTurnFailure: error.lastTurnFailure, systemRecovery: error.systemRecovery });
        if (error instanceof CodexRunAdmissionError) throw new PeerError("run-admission", "Native admission rejected this input before submission", { reason: error.reason });
        if (error instanceof CodexTurnExecutionError) throw new PeerError("turn-failed", "The native turn ended without success", { status: error.status, failureCode: error.failureCode });
        if (error instanceof CodexInterventionError) throw new PeerError("intervention", error.message);
        throw new PeerError("native-failed", "The device rejected the operation; inspect Codex on the device");
      }
    });
  }
  private assertThread(value: unknown, expected = this.description.thread?.threadId): asserts value is string {
    if (typeof value !== "string" || !value || expected !== undefined && value !== expected)
      throw new PeerError("scope", "Only the locally selected thread is exported");
  }
  async close(): Promise<void> { await this.ide?.close(); }
  private async readState(id: unknown, write = false, observation?: import("../codex/backend.js").CodexMetadataObservation): Promise<CodexThreadState & { cwd: string }> {
    this.assertThread(id);
    const state = await this.options.backend.inspectThread(id, undefined, observation);
    if (state.threadId !== id || state.internal || !["active", "archived"].includes(state.persistence) || !state.cwd || !path.isAbsolute(state.cwd))
      throw new PeerError("scope", "The selected local session is unavailable");
    if (write) assertCodexThreadRunnable(state);
    return { ...state, cwd: state.cwd };
  }
  private async execute(connection: PeerConnection, call: z.infer<typeof callSchema>): Promise<unknown> {
    const { method, args, operationId } = call, backend = this.options.backend;
    const principalKey = crypto.createHash("sha256").update(JSON.stringify(call.grant.principal)).digest("hex");
    const original = (id: string) => this.receipts.originalSource(id, principalKey);
    if (!writes.has(method)) {
      switch (method) {
        case "listSessionCatalog": {
          if (call.grant.delegation) {
            const input = catalogSchema.parse(args[0] ?? {}), states = await Promise.all(this.sharing.catalog(call.grant).map(async g => { await this.sharing.verify(g, "inspectThread", [g.threadId]); return this.readState(g.threadId); }));
            return { backend: backend.backendInfo().id, source: "app-server-storage", hostIds: [], complete: true, warnings: [], threads: states.filter(s => (input.persistence === "all" || s.persistence === (input.persistence ?? "active")) && (!input.cwd || input.cwd === s.cwd) && (!input.projectId || input.projectId === s.projectId)) };
          }
          if (call.grant.scope !== "device") throw new PeerError("access", "Device catalog access was not approved");
          const input = catalogSchema.parse(args[0] ?? {});
          const catalog = input.persistence === "archived"
            ? { backend: backend.backendInfo().id, source: "app-server-storage" as const, threads: await backend.listThreads(input), hostIds: [], complete: true, warnings: [] }
            : await backend.listSessionCatalog({ ...input, persistence: "active" });
          if (input.persistence === "all") catalog.threads = [...catalog.threads, ...await backend.listThreads({ ...input, persistence: "archived" })];
          const threads = new Map(catalog.threads.map(s => [s.threadId, s]));
          // A newly created empty thread can precede Desktop's catalog sync.
          for (const id of this.receipts.createdThreads()) if (!threads.has(id)) {
            try { threads.set(id, await backend.inspectThread(id)); } catch { /* Native catalog remains usable. */ }
          }
          return { ...catalog, hostIds: [], threads: [...threads.values()].filter(state => !state.internal && this.sharing.visible(call.grant, state.threadId)
            && (input.persistence === "all" ? ["active", "archived"].includes(state.persistence) : state.persistence === (input.persistence ?? "active"))
            && state.cwd && path.isAbsolute(state.cwd) && (!input.cwd || state.cwd === input.cwd)
            && (!input.projectId || state.projectId === input.projectId) && (!input.unassigned || !state.projectId)) };
        }
        case "listProjects": {
          if (call.grant.delegation) return { backend: backend.backendInfo().id, projects: [] };
          if (call.grant.scope !== "device") throw new PeerError("access", "Project catalog requires a device grant");
          const catalog = await backend.listProjects(undefined, metadataObservation.parse(args[0] ?? undefined));
          if ((this.options.nativeHostId ?? "local") !== "local") return catalog;
          return { ...catalog, projects: catalog.projects.flatMap(project => {
            const roots = [...new Set(project.roots.flatMap(root => {
              if (!path.isAbsolute(root) || /[\r\n\0]/.test(root)) return [];
              // Missing mounts do not delete a project or one of its roots.
              // Execution/IDE validate the complete directory set at use time.
              try { return [fs.realpathSync(root)]; }
              catch { return [root]; }
            }))];
            const available = roots.every(root => { try { return fs.statSync(root).isDirectory(); } catch { return false; } });
            return roots.length ? [{ ...project, roots, ...(!available ? { available: false } : {}) }] : [];
          }) };
        }
        case "serverIdentity": {
          if (call.grant.scope !== "device" || call.grant.delegation) throw new PeerError("scope", "Process diagnostics require a device grant");
          if (!backend.serverIdentity) throw new PeerError("unsupported", "Native process diagnostics unavailable");
          return backend.serverIdentity();
        }
        case "listSkills": case "warmUp": {
          const cwd = z.string().min(1).parse(args[0]);
          if (call.grant.scope !== "device") {
            const state = await this.readState(call.grant.threadId);
            if (path.resolve(cwd) !== path.resolve(state.cwd)) throw new PeerError("scope", "Workspace does not match the granted thread");
          }
          if (method === "warmUp") { await backend.warmUp(cwd); return null; }
          if (!backend.listSkills) throw new CodexBackendCapabilityError("skills", backend.backendInfo().id);
          return backend.listSkills(cwd);
        }
        case "listMcpServers": {
          if (args[0] !== null && args[0] !== undefined) await this.readState(args[0]);
          else if (call.grant.scope !== "device") throw new PeerError("scope", "A thread grant requires its thread ID");
          if (!backend.listMcpServers) throw new CodexBackendCapabilityError("mcpServers", backend.backendInfo().id);
          return backend.listMcpServers(z.string().optional().parse(args[0] ?? undefined));
        }
        case "listModels": return backend.listModels();
        case "getAccountRateLimits": return backend.getAccountRateLimits(undefined, z.string().max(200).optional().parse(args[1] ?? undefined));
        case "receipt": return this.receipts.get(z.string().regex(/^[a-f0-9]{64}$/).parse(args[0])) ?? null;
        case "getRuntimeInfo": {
          const observation = metadataObservation.parse(args[3] ?? undefined);
          if (!args[1] && call.grant.scope === "device") return backend.getRuntimeInfo(z.string().parse(args[0]), undefined, undefined, observation);
          const state = await this.readState(args[1] ?? this.description.thread?.threadId, false,
            observation && { ...observation, includeTurns: false });
          return backend.getRuntimeInfo(state.cwd, state.threadId, undefined, observation);
        }
        case "inspectThread": {
          this.assertThread(args[0]);
          const state = await backend.inspectThread(args[0], undefined, observationSchema.parse(args[2] ?? undefined));
          if (state.threadId !== args[0] || state.internal) throw new PeerError("scope", "Native observation identity changed");
          return state;
        }
        default: this.assertThread(args[0]);
      }
      switch (method) {
        case "readThreadProvenance": return backend.readThreadProvenance?.(args[0]) ?? null;
        case "listQueuedSubmissions": {
          if (!backend.listQueuedSubmissions) throw new CodexBackendCapabilityError("nativeQueue", backend.backendInfo().id);
          const page = await backend.listQueuedSubmissions(args[0], z.string().optional().parse(args[1] ?? undefined));
          return { ...page, data: page.data.map(item => ({ ...item, clientUserMessageId: original(item.clientUserMessageId) })) };
        }
        case "getGoal": return backend.getGoal(args[0]);
        case "readThreadSnapshot": {
          const snapshot = await backend.readThreadSnapshot(args[0]);
          return { ...snapshot, turns: snapshot.turns.map(turn => ({ ...turn, messages: turn.messages.map(item => ({ ...item,
            ...(item.clientUserMessageId ? { clientUserMessageId: this.receipts.originalSource(item.clientUserMessageId, principalKey, snapshot.state.threadId) } : {})
          })) })) };
        }
        case "readTurnActivities": {
          if (!backend.readTurnActivities) throw new PeerError("unsupported", "设备不支持原生轮次活动查询。");
          return backend.readTurnActivities(args[0], z.string().min(1).parse(args[1]));
        }
        case "readTurnLifecycle": return backend.readTurnLifecycle?.(args[0], z.string().min(1).parse(args[1])) ?? { status: "unknown", source: "unknown" };
        case "getHistory": return (await backend.getHistory(args[0])).map(item => ({ ...item, ...(item.clientUserMessageId ? { clientUserMessageId: original(item.clientUserMessageId) } : {}) }));
        case "getHistoryPage": { const page = await backend.getHistoryPage(args[0], z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(1000).optional(),
          sortDirection: z.enum(["asc", "desc"]).optional() }).strict().parse(args[1] ?? {}));
          return { ...page, messages: page.messages.map(item => ({ ...item, ...(item.clientUserMessageId ? { clientUserMessageId: original(item.clientUserMessageId) } : {}) })) }; }
      }
      throw new PeerError("unsupported", "Operation unavailable");
    }
    if (!operationId) throw new PeerError("identity", "Writes require a durable source identity");
    const callback = (name: string, values: unknown[]) => connection.request("execution.callback", { operationId, name, args: values },
      name === "onApproval" || name === "onUserInput" ? PEER_EXECUTION_TIMEOUT_MS : 30_000);
    const nativeInput = ["run", "steer", "submitThreadMessage"].includes(method) ? runSchema.parse(args[0])
      : method === "addQueuedSubmission" ? queueAddSchema.parse(args[0])
      : method === "runQueuedSubmission" ? queuedRunSchema.parse(args[0])
      : method === "resumeAfterCapacity" ? capacitySchema.parse(args[0])
      : method === "recoverSystemError" ? recoverySchema.parse(args[0]) : undefined;
    const fresh = method === "run" && !nativeInput?.threadId;
    if (fresh && (call.grant.scope !== "device" || call.grant.delegation || this.description.thread))
      throw new PeerError("scope", "Starting a new native thread requires a device grant");
    const cwd = fresh ? z.string().min(1).parse((nativeInput as any)?.cwd) : undefined;
    const directories = new PeerHostDirectories(this.options.nativeHostId, this.options.codexHome);
    if (cwd) { if (!path.isAbsolute(cwd)) throw new PeerError("scope", "Native workspace must be an existing device directory"); await directories.canonical(cwd); }
    const state = fresh ? { threadId: "new", cwd: cwd! } : await this.readState(nativeInput?.threadId ?? args[0],
      !["recoverSystemError", "resumeAfterCapacity"].includes(method) && !(method === "runQueuedSubmission" && (nativeInput as any)?.observeOnly));
    let threadId = state.threadId;
    if (nativeInput && "cwd" in nativeInput && path.resolve(nativeInput.cwd) !== path.resolve(state.cwd)) throw new PeerError("scope", "The exported working directory cannot be changed remotely");
    if (nativeInput && "nativeSettings" in nativeInput && nativeInput.nativeSettings && call.grant.delegation)
      throw new PeerError("access", "Delegated sessions inherit native permissions; only a device owner can choose settings");
    if (nativeInput && "imagePaths" in nativeInput && nativeInput.imagePaths?.length) {
      try { await directories.assertImages(state.cwd, nativeInput.imagePaths); }
      catch { throw new PeerError("scope", "Image is outside the granted workspace"); }
    }
    // Every native write asks the origin to recheck its live binding and ACL.
    // Failure here is known not-submitted, before the write intent is recorded.
    try { await callback("assertCurrent", []); }
    catch { throw new PeerError("codex-communication", "Origin no longer authorizes the write", { phase: "preflight", operation: method }); }
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([method, args])).digest("hex");
    const prior = this.receipts.begin(operationId, fingerprint, threadId, method,
      ["addQueuedSubmission", "resumeAfterCapacity"].includes(method) ? { sourceId: (nativeInput as any).clientUserMessageId, principal: principalKey } : undefined);
    if (prior) {
      if (prior.phase === "completed") return method === "addQueuedSubmission" ? { ...prior.result as object, _peerQueueCallback: false } : prior.result;
      throw new PeerError("receipt", "The original input may already be submitted; it was not replayed", prior);
    }
    const assertCurrent = peerWriteGuard(connection, operationId, method, () => this.sharing.assert(call.grant, method, args));
    const event = async (name: string, values: unknown[]) => { try { this.sharing.assert(call.grant, method, args); return await callback(name, values); } catch { return undefined; } };
    const queueSource = method === "runQueuedSubmission" && (nativeInput as any)?.clientUserMessageId;
    const queueOperation = queueSource && peerOperationId(call.grant.hostId, "addQueuedSubmission", call.grant.principal, queueSource);
    // Entries accepted before the direct→Connector migration already have a
    // native client ID. Native runQueuedSubmission still verifies the exact
    // queued item/accepted turn; this never re-enqueues or resends its prompt.
    const sourceId = queueSource ? this.options.managedRoute && !this.receipts.get(queueOperation)
      ? queueSource : `peer-${queueOperation}` : `peer-${operationId}`;
    let queuePoll: NodeJS.Timeout | undefined, queueKey: string | undefined;
    let keepQueueCallback = false, queueRetired = false;
    let detachQueueClose = () => {};
    const stopQueuePoll = () => {
      queueRetired = true; if (queuePoll) clearTimeout(queuePoll); detachQueueClose();
      if (queueKey) this.queueLeases.get(connection)?.delete(queueKey);
    };
    if (method === "addQueuedSubmission") detachQueueClose = connection.onClose(stopQueuePoll);
    const retireQueue = async () => { stopQueuePoll(); try { await callback("queueRetired", []); } catch { /* A lost observer never answers native input. */ } };
    const pollQueueTurn = async (turnId: string) => {
      if (!connection.open || queueRetired) return;
      try { this.sharing.assert(call.grant, method, args); } catch { await retireQueue(); return; }
      try {
        const observed = await backend.readTurnLifecycle?.(threadId, turnId);
        if (observed?.source !== "unknown" && observed?.status && !["unknown", "inProgress"].includes(observed.status)) {
          await retireQueue(); return;
        }
      } catch { if (!connection.open) return; }
      if (!queueRetired) { queuePoll = setTimeout(() => void pollQueueTurn(turnId), 5000); queuePoll.unref(); }
    };
    const input = { ...nativeInput!, clientUserMessageId: sourceId, assertCurrent,
      onThreadCreated: async id => {
        if (fresh && threadId === "new") { this.assertThread(id); threadId = id; this.receipts.created(operationId, id); }
        else this.assertThread(id, threadId);
        // This is the origin's durable identity handoff, not a best-effort
        // progress notification. The native runner awaits it before turn/start.
        // Keep the device's created receipt, but never submit if the origin
        // cannot persist that identity or has revoked this operation.
        this.sharing.assert(call.grant, method, args);
        await callback("onThreadCreated", [id]);
      },
      onTurnStarted: async receipt => {
        this.assertThread(receipt.threadId, threadId); this.receipts.accepted(operationId, receipt.turnId);
        await event("onTurnStarted", [receipt]);
      },
      onDelta: text => event("onDelta", [text]).then(() => {}), onProgress: text => event("onProgress", [text]).then(() => {}),
      onItem: item => event("onItem", [item]).then(() => {}),
      ...((nativeInput as any)?._dynamicToolCallback ? {
        onDynamicToolCall: (request: import("../codex/backend.js").CodexDynamicToolCall) => callback("onDynamicToolCall", [request]).then(value => z.string().parse(value))
      } : {}),
      onAccepted: async (turn: string) => {
        await event("onAccepted", [turn]);
        // Queue/add returns before automatic consumption and its interactions.
        // Retain that callback route until the native owner confirms completion.
        if (method === "addQueuedSubmission" && !queueRetired) { queuePoll = setTimeout(() => void pollQueueTurn(turn), 5000); queuePoll.unref(); }
      },
      onQueueStarting: () => callback("onQueueStarting", []).then(() => {}),
      onRecovery: value => event("onRecovery", [value]).then(() => {}),
      onApproval: async request => {
        try {
          this.sharing.assert(call.grant, method, args);
          const decision = await callback("onApproval", [request]);
          this.sharing.assert(call.grant, method, args);
          return approvalOptions(request).some(option => option.id === decision) ? decision as CodexApprovalDecision : undefined;
        } catch { return undefined; }
      },
      onApprovalResult: (request, result) => event("onApprovalResult", [request, result]).then(() => {}),
      onUserInput: async request => {
        try {
          const answer = await callback("onUserInput", [request]);
          this.sharing.assert(call.grant, method, args);
          return answer === null ? undefined : z.record(z.string(), z.object({ answers: z.array(z.string()) }).strict()).parse(answer);
        } catch { return undefined; }
      },
      onUserInputResult: (request, result) => event("onUserInputResult", [request, result]).then(() => {}) } as CodexRunnerInput & Record<string, any>;
    try {
      let result: unknown;
      if (method === "recoverSystemError") {
        const recovery = nativeInput as z.infer<typeof recoverySchema>;
        const pendingRestore = this.recovery.get(threadId, recovery.failedTurnId);
        if (recovery.lifecycle?.restoring && pendingRestore?.restored) {
          await callback("restored", []); this.recovery.acknowledged(threadId);
          result = { status: "deferred", reason: "changed", state: await backend.inspectThread(threadId) };
        } else result = await backend.recoverSystemError?.({ threadId: recovery.threadId, failedTurnId: recovery.failedTurnId, assertCurrent, ...(recovery.lifecycle ? { lifecycle: {
          ...recovery.lifecycle, beforeArchive: async () => {
            await callback("beforeArchive", []); this.recovery.start(threadId, recovery.failedTurnId);
          },
          archived: async () => { this.recovery.confirmed(threadId); await callback("archived", []); },
          restored: async () => { this.recovery.restored(threadId); await callback("restored", []); this.recovery.acknowledged(threadId); }
        } } : {}) }) ?? { status: "unsupported", reason: "owner-unsupported" };
      } else if (method === "addQueuedSubmission") {
        if (!backend.addQueuedSubmission) throw new CodexBackendCapabilityError("nativeQueue", backend.backendInfo().id);
        const item = await backend.addQueuedSubmission(input as any);
        result = { ...item, clientUserMessageId: (nativeInput as any).clientUserMessageId }; keepQueueCallback = !queueRetired;
        if (keepQueueCallback) {
          queueKey = JSON.stringify([threadId, item.id]);
          this.queueLeases.get(connection)?.set(queueKey, stopQueuePoll);
        }
      } else if (method === "deleteQueuedSubmission") {
        if (!backend.deleteQueuedSubmission) throw new CodexBackendCapabilityError("nativeQueue", backend.backendInfo().id);
        result = await backend.deleteQueuedSubmission(threadId, z.string().min(1).parse(args[1]), undefined, assertCurrent);
        if (result === true) this.queueLeases.get(connection)?.get(JSON.stringify([threadId, args[1]]))?.();
      } else if (method === "runQueuedSubmission") {
        if (!backend.runQueuedSubmission) throw new CodexBackendCapabilityError("nativeQueue", backend.backendInfo().id);
        result = await backend.runQueuedSubmission(input as any);
        this.queueLeases.get(connection)?.get(JSON.stringify([threadId, input.queuedSubmissionId]))?.();
      } else if (method === "resumeAfterCapacity") {
        if (!backend.resumeAfterCapacity) throw new PeerError("unsupported", "Native capacity recovery unavailable");
        result = await backend.resumeAfterCapacity(input as any);
      } else if (method === "run") result = await backend.run(input);
      else if (method === "stop") result = await backend.stop(threadId, undefined, assertCurrent);
      else if (method === "interruptTurn") {
        if (!backend.interruptTurn) throw new PeerError("unsupported", "设备不支持精确轮次中断。");
        await backend.interruptTurn(threadId, z.string().min(1).max(512).parse(args[1]), undefined, assertCurrent); result = null;
      } else if (method === "setGoal") result = await backend.setGoal(threadId, goalSchema.parse(args[1]), undefined, assertCurrent);
      else if (method === "updateThreadSettings") {
        if (!backend.updateThreadSettings) throw new PeerError("unsupported", "设备尚未支持原生会话设置，请升级 Connector。");
        const patch = z.object({ model: z.string().trim().min(1).max(200).optional(), effort: z.string().trim().min(1).max(50).optional(),
          collaborationMode: z.enum(["default", "plan", "toggle"]).optional() }).strict().parse(args[1]);
        result = await backend.updateThreadSettings(threadId, patch, undefined, assertCurrent);
      }
      else if (method === "clearGoal") { await backend.clearGoal(threadId, undefined, assertCurrent); result = null; }
      else {
        if (method !== "steer" && method !== "submitThreadMessage") throw new PeerError("unsupported", "Native operation unavailable");
        if (method === "submitThreadMessage" && !backend.submitThreadMessage) throw new PeerError("unsupported", "Native operation unavailable");
        result = method === "steer" ? await backend.steer({ ...input, threadId })
          : await backend.submitThreadMessage!({ ...input, threadId, clientUserMessageId: sourceId });
        const receipt = result as CodexInputReceipt;
        this.assertThread(receipt.threadId, threadId); this.receipts.accepted(operationId, receipt.turnId);
      }
      if (result && typeof result === "object" && "threadId" in result && result.threadId !== undefined) this.assertThread(result.threadId, threadId);
      // Provider-specific raw JSON is not needed by the Gateway facade.
      if (result && typeof result === "object" && "raw" in result) result = { ...result, raw: "" };
      this.receipts.complete(operationId, result); return method === "addQueuedSubmission" ? { ...result as object, _peerQueueCallback: keepQueueCallback } : result;
    } catch (error) {
      const notSubmitted = error instanceof CodexCommunicationError && error.submission === "not-submitted"
        || error instanceof CodexBackendCapabilityError || error instanceof CodexQueueAdmissionError || error instanceof CodexRunAdmissionError || error instanceof PeerError && error.code === "unsupported";
      // Preserve a durable accepted turn even if observation later disconnects.
      if (this.receipts.get(operationId)?.phase !== "accepted") this.receipts.failed(operationId, notSubmitted);
      throw error;
    } finally { if (!keepQueueCallback) { stopQueuePoll(); if (queuePoll) clearTimeout(queuePoll); } }
  }
}
