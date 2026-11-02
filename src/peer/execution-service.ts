import { PeerInteractionService } from "./interaction-service.js";
import { peerWriteGuard } from "./write-guard.js";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { assertCodexThreadRunnable, CodexBackendCapabilityError, CodexRunAdmissionError, CodexTurnExecutionError,
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

const callSchema = z.object({ grant: grantSchema, method: z.enum(["listSessionCatalog", "inspectThread", "readThreadSnapshot", "readTurnLifecycle", "readTurnActivities", "getHistory", "getHistoryPage",
  "getRuntimeInfo", "listModels", "getAccountRateLimits", "listProjects", "run", "steer", "submitThreadMessage", "stop", "interruptTurn", "getGoal", "setGoal", "clearGoal", "receipt", "observeThreadInteractions", "unobserveThreadInteractions", ...FILE_METHODS, ...MANAGEMENT_METHODS]),
  args: z.array(z.unknown()).max(4), operationId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const runSchema = z.object({ threadId: z.string(), cwd: z.string(), prompt: z.string().max(500_000), clientUserMessageId: z.string().optional(),
  developerInstructions: z.string().optional(), threadTitle: z.string().optional(), model: z.string().optional(), effort: z.string().optional(),
  projectId: z.string().optional(), projectName: z.string().optional(), projectRoots: z.array(z.string()).max(100).optional(), projectBinding: z.literal("none").optional(),
  collaborationMode: z.enum(["default", "plan"]).optional(), outputSchema: z.record(z.string(), z.unknown()).optional(),
  expectedTurnId: z.string().optional(), queueKey: z.string().optional() }).strict();
const writes = new Set(["run", "steer", "submitThreadMessage", "stop", "interruptTurn", "setGoal", "clearGoal"]);
const goalSchema = z.object({ objective: z.string().max(500000).optional(), status: z.enum(["active", "paused", "complete", "blocked", "usageLimited", "budgetLimited"]).optional(), tokenBudget: z.number().int().positive().optional() }).strict();
const catalogSchema = z.object({ cwd: z.string().optional(), projectId: z.string().optional(), unassigned: z.boolean().optional(),
  persistence: z.enum(["active", "archived", "all"]).optional(), limit: z.number().int().min(1).max(1000).optional() }).strict();
export type PeerExecutionOptions = {
  backend: CodexBridgeBackend; threadId?: string; profileId: string; label?: string; stateDir: string;
  /** True only for an independently managed native daemon, never private exec. */
  independent?: boolean;
  approve: (grant: PeerGrant) => Promise<boolean>;
  approveOwner?: (confirmation: OwnerConfirmation) => Promise<boolean>;
};

/** Pair a local Codex profile with a chat, then choose sessions in the chat.
 * An optional threadId narrows the export to one existing session. */
export class PeerExecutionService {
  readonly description: PeerDescription;
  private grants: PeerGrant[];
  private privatePolicy = false;
  private readonly receipts: PeerReceipts;
  private readonly files: PeerFiles;
  private readonly management: PeerManagement;
  private readonly interactions: PeerInteractionService;
  private readonly sharing: PeerSharingAuthority;
  private constructor(private readonly options: PeerExecutionOptions, description: PeerDescription) {
    this.description = description;
    const stored = readJsonFile<unknown>(path.join(options.stateDir, "grants.json"), []);
    if (Array.isArray(stored)) this.grants = z.array(grantSchema).parse(stored);
    else { this.grants = z.object({ version: z.literal(2), grants: z.array(grantSchema) }).strict().parse(stored).grants; this.privatePolicy = true; }
    this.receipts = new PeerReceipts(path.join(options.stateDir, "receipts.json"));
    this.files = new PeerFiles(options.stateDir, (id, write) => this.readState(id, write));
    this.interactions = new PeerInteractionService(options.backend);
    this.management = new PeerManagement(options.backend, options.stateDir, this.receipts);
    this.sharing = new PeerSharingAuthority(path.join(options.stateDir, "sharing.json"), options.backend, options.approveOwner ?? (async () => false));
    if (this.sharing.hasResources() && !this.privatePolicy) this.saveGrants(this.grants, true);
  }
  private saveGrants(grants: PeerGrant[], privatePolicy = this.privatePolicy): void {
    // An old Connector expects an array and must refuse this format instead
    // of silently bypassing locally confirmed ownership after a downgrade.
    writeJsonFile(path.join(this.options.stateDir, "grants.json"), privatePolicy ? { version: 2, grants } : grants, { durable: true });
    this.grants = grants; this.privatePolicy = privatePolicy;
  }
  static async create(options: PeerExecutionOptions): Promise<PeerExecutionService> {
    if (!/^[\w-]{1,80}$/.test(options.profileId)) throw new Error("Invalid peer profile ID");
    const state = options.threadId ? await options.backend.inspectThread(options.threadId) : undefined;
    if (state) {
      if (state.persistence === "active") assertCodexThreadRunnable(state);
      if (state.internal || !["active", "archived"].includes(state.persistence) || !state.cwd || !path.isAbsolute(state.cwd)) throw new Error("Select an existing ordinary Codex thread with a confirmed local cwd");
    }
    const info = options.backend.backendInfo();
    const capabilities = { ...info.capabilities, dynamicTools: false, structuredOutput: false, nativeQueue: false,
      skills: false, mcpServers: false, projectCatalog: !options.threadId && info.capabilities.projectCatalog,
      projects: !options.threadId && info.capabilities.projects };
    return new PeerExecutionService(options, { profileId: options.profileId, label: options.label,
      writeGuard: 1,
      ...(options.backend.observeThreadInteractions ? { interactions: 1 as const } : {}),
      files: { version: 1 },
      management: { version: 1 },
      sharing: { version: 2 },
      thread: state ? { ...state, cwd: state.cwd! } : undefined,
      info: { id: info.id, capabilities }, independent: options.independent === true });
  }
  attach(connection: PeerConnection): void {
    connection.onClose(() => this.files.close(connection));
    const approved = (grant: PeerGrant) => grant.delegation ? this.sharing.valid(grant) : this.grants.some(g => JSON.stringify(g) === JSON.stringify(grant));
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
        await this.sharing.verify(call.grant, call.method, call.args);
        if ((FILE_METHODS as readonly string[]).includes(call.method)) return await this.files.call(call.grant, connection, call.method, call.args[0], threadId => this.sharing.assert(call.grant, call.method, [{ threadId }]));
        if ((MANAGEMENT_METHODS as readonly string[]).includes(call.method)) return await this.management.call(call.grant, connection, call.method, call.args[0], call.operationId, () => this.sharing.assert(call.grant, call.method, call.args));
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
        if (error instanceof CodexRunAdmissionError) throw new PeerError("run-admission", "Native admission rejected this input before submission", { reason: error.reason });
        if (error instanceof CodexTurnExecutionError) throw new PeerError("turn-failed", "The native turn ended without success", { status: error.status, failureCode: error.failureCode });
        throw new PeerError("native-failed", "The device rejected the operation; inspect Codex on the device");
      }
    });
  }
  private assertThread(value: unknown, expected = this.description.thread?.threadId): asserts value is string {
    if (typeof value !== "string" || !value || expected !== undefined && value !== expected)
      throw new PeerError("scope", "Only the locally selected thread is exported");
  }
  private async readState(id: unknown, write = false): Promise<CodexThreadState & { cwd: string }> {
    this.assertThread(id);
    const state = await this.options.backend.inspectThread(id);
    if (state.threadId !== id || state.internal || !["active", "archived"].includes(state.persistence) || !state.cwd || !path.isAbsolute(state.cwd))
      throw new PeerError("scope", "The selected local session is unavailable");
    if (write) assertCodexThreadRunnable(state);
    return { ...state, cwd: state.cwd };
  }
  private async execute(connection: PeerConnection, call: z.infer<typeof callSchema>): Promise<unknown> {
    const { method, args, operationId } = call, backend = this.options.backend;
    if (!writes.has(method)) {
      switch (method) {
        case "listSessionCatalog": {
          if (call.grant.delegation) {
            const input = catalogSchema.parse(args[0] ?? {}), states = await Promise.all(this.sharing.catalog(call.grant).map(async g => { await this.sharing.verify(g, "inspectThread", [g.threadId]); return this.readState(g.threadId); }));
            return { backend: backend.backendInfo().id, source: "app-server-storage", hostIds: [], complete: true, warnings: [], threads: states.filter(s => (input.persistence === "all" || s.persistence === (input.persistence ?? "active")) && (!input.cwd || input.cwd === s.cwd) && (!input.projectId || input.projectId === s.projectId)) };
          }
          if (call.grant.scope !== "device") throw new PeerError("access", "Device catalog access was not approved");
          const input = catalogSchema.parse(args[0] ?? {}), catalog = await backend.listSessionCatalog(input);
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
          const catalog = await backend.listProjects();
          return { ...catalog, projects: catalog.projects.flatMap(project => {
            const roots = [...new Set(project.roots.flatMap(root => {
              try { if (!path.isAbsolute(root)) return []; const actual = fs.realpathSync(root); return fs.statSync(actual).isDirectory() ? [actual] : []; }
              catch { return []; }
            }))];
            return roots.length ? [{ ...project, roots }] : [];
          }) };
        }
        case "listModels": return backend.listModels();
        case "getAccountRateLimits": return backend.getAccountRateLimits(undefined, z.string().max(200).optional().parse(args[1] ?? undefined));
        case "receipt": return this.receipts.get(z.string().regex(/^[a-f0-9]{64}$/).parse(args[0])) ?? null;
        case "getRuntimeInfo": {
          const state = await this.readState(args[1] ?? this.description.thread?.threadId);
          return backend.getRuntimeInfo(state.cwd, state.threadId);
        }
        case "inspectThread": return this.readState(args[0]);
        default: await this.readState(args[0]); this.assertThread(args[0]);
      }
      switch (method) {
        case "getGoal": return backend.getGoal(args[0]);
        case "readThreadSnapshot": return backend.readThreadSnapshot(args[0]);
        case "readTurnActivities": {
          if (!backend.readTurnActivities) throw new PeerError("unsupported", "设备不支持原生轮次活动查询。");
          return backend.readTurnActivities(args[0], z.string().min(1).parse(args[1]));
        }
        case "readTurnLifecycle": return backend.readTurnLifecycle?.(args[0], z.string().min(1).parse(args[1])) ?? { status: "unknown", source: "unknown" };
        case "getHistory": return (await backend.getHistory(args[0])).slice(-1000);
        case "getHistoryPage": return backend.getHistoryPage(args[0], z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional(),
          sortDirection: z.enum(["asc", "desc"]).optional() }).strict().parse(args[1] ?? {}));
      }
      throw new PeerError("unsupported", "Operation unavailable");
    }
    if (!operationId) throw new PeerError("identity", "Writes require a durable source identity");
    const callback = (name: string, values: unknown[]) => connection.request("execution.callback", { operationId, name, args: values },
      name === "onApproval" || name === "onUserInput" ? PEER_EXECUTION_TIMEOUT_MS : 30_000);
    const nativeInput = ["run", "steer", "submitThreadMessage"].includes(method) ? runSchema.parse(args[0]) : undefined;
    const state = await this.readState(nativeInput?.threadId ?? args[0], true), threadId = state.threadId;
    if (nativeInput && path.resolve(nativeInput.cwd) !== path.resolve(state.cwd)) throw new PeerError("scope", "The exported working directory cannot be changed remotely");
    // Every native write asks the origin to recheck its live binding and ACL.
    // Failure here is known not-submitted, before the write intent is recorded.
    try { await callback("assertCurrent", []); }
    catch { throw new PeerError("codex-communication", "Origin no longer authorizes the write", { phase: "preflight", operation: method }); }
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([method, args])).digest("hex");
    const prior = this.receipts.begin(operationId, fingerprint, threadId);
    if (prior) {
      if (prior.phase === "completed") return prior.result;
      throw new PeerError("receipt", "The original input may already be submitted; it was not replayed", prior);
    }
    const assertCurrent = peerWriteGuard(connection, operationId, method, () => this.sharing.assert(call.grant, method, args));
    const event = async (name: string, values: unknown[]) => { try { this.sharing.assert(call.grant, method, args); return await callback(name, values); } catch { return undefined; } };
    const sourceId = `peer-${operationId}`;
    const input: CodexRunnerInput = { ...nativeInput!, clientUserMessageId: sourceId, assertCurrent,
      onThreadCreated: id => { this.assertThread(id, threadId); return event("onThreadCreated", [id]).then(() => {}); },
      onTurnStarted: async receipt => {
        this.assertThread(receipt.threadId, threadId); this.receipts.accepted(operationId, receipt.turnId);
        await event("onTurnStarted", [receipt]);
      },
      onDelta: text => event("onDelta", [text]).then(() => {}), onProgress: text => event("onProgress", [text]).then(() => {}),
      onItem: item => event("onItem", [item]).then(() => {}),
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
      onUserInputResult: (request, result) => event("onUserInputResult", [request, result]).then(() => {}) };
    try {
      let result: unknown;
      if (method === "run") result = await backend.run(input);
      else if (method === "stop") result = await backend.stop(threadId, undefined, assertCurrent);
      else if (method === "interruptTurn") {
        if (!backend.interruptTurn) throw new PeerError("unsupported", "设备不支持精确轮次中断。");
        await backend.interruptTurn(threadId, z.string().min(1).max(512).parse(args[1]), undefined, assertCurrent); result = null;
      } else if (method === "setGoal") result = await backend.setGoal(threadId, goalSchema.parse(args[1]), undefined, assertCurrent);
      else if (method === "clearGoal") { await backend.clearGoal(threadId, undefined, assertCurrent); result = null; }
      else {
        if (method !== "steer" && method !== "submitThreadMessage") throw new PeerError("unsupported", "Native operation unavailable");
        if (method === "submitThreadMessage" && !backend.submitThreadMessage) throw new PeerError("unsupported", "Native operation unavailable");
        result = method === "steer" ? await backend.steer({ ...nativeInput!, clientUserMessageId: sourceId, assertCurrent })
          : await backend.submitThreadMessage!({ ...nativeInput!, clientUserMessageId: sourceId, assertCurrent });
        const receipt = result as CodexInputReceipt;
        this.assertThread(receipt.threadId, threadId); this.receipts.accepted(operationId, receipt.turnId);
      }
      if (result && typeof result === "object" && "threadId" in result && result.threadId !== undefined) this.assertThread(result.threadId, threadId);
      // Provider-specific raw JSON is not needed by the Gateway facade.
      if (result && typeof result === "object" && "raw" in result) result = { ...result, raw: "" };
      this.receipts.complete(operationId, result); return result;
    } catch (error) {
      const notSubmitted = error instanceof CodexCommunicationError && error.submission === "not-submitted"
        || error instanceof CodexBackendCapabilityError || error instanceof CodexRunAdmissionError || error instanceof PeerError && error.code === "unsupported";
      // Preserve a durable accepted turn even if observation later disconnects.
      if (this.receipts.get(operationId)?.phase !== "accepted") this.receipts.failed(operationId, notSubmitted);
      throw error;
    }
  }
}
