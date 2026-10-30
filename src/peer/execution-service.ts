import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { assertCodexThreadRunnable, CodexBackendCapabilityError, CodexTurnExecutionError,
  type CodexBridgeBackend, type CodexRunnerInput, type CodexInputReceipt, type CodexThreadState } from "../codex/backend.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import { approvalOptions, type CodexApprovalDecision } from "../codex/approval.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { grantSchema, type PeerGrant, type PeerDescription } from "./registry.js";
import { PeerReceipts } from "./receipts.js";
import { PeerConnection, PeerError } from "./rpc.js";
import { FILE_METHODS, PeerFiles } from "./files.js";

const callSchema = z.object({ grant: grantSchema, method: z.enum(["listSessionCatalog", "inspectThread", "readThreadSnapshot", "readTurnLifecycle", "getHistory", "getHistoryPage",
  "getRuntimeInfo", "listModels", "getAccountRateLimits", "run", "steer", "submitThreadMessage", "stop", "receipt", ...FILE_METHODS]),
  args: z.array(z.unknown()).max(4), operationId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const runSchema = z.object({ threadId: z.string(), cwd: z.string(), prompt: z.string().max(500_000), clientUserMessageId: z.string().optional(),
  developerInstructions: z.string().optional(), threadTitle: z.string().optional(), model: z.string().optional(), effort: z.string().optional(),
  projectId: z.string().optional(), projectName: z.string().optional(), projectBinding: z.literal("none").optional(),
  collaborationMode: z.enum(["default", "plan"]).optional(), outputSchema: z.record(z.string(), z.unknown()).optional(),
  expectedTurnId: z.string().optional(), queueKey: z.string().optional() }).strict();
const writes = new Set(["run", "steer", "submitThreadMessage", "stop"]);
const catalogSchema = z.object({ cwd: z.string().optional(), projectId: z.string().optional(), unassigned: z.boolean().optional(),
  persistence: z.enum(["active", "archived", "all"]).optional(), limit: z.number().int().min(1).max(1000).optional() }).strict();
export type PeerExecutionOptions = {
  backend: CodexBridgeBackend; threadId?: string; profileId: string; label?: string; stateDir: string;
  /** True only for an independently managed native daemon, never private exec. */
  independent?: boolean;
  approve: (grant: PeerGrant) => Promise<boolean>;
};

/** Pair a local Codex profile with a chat, then choose sessions in the chat.
 * An optional threadId narrows the export to one existing session. */
export class PeerExecutionService {
  readonly description: PeerDescription;
  private grants: PeerGrant[];
  private readonly receipts: PeerReceipts;
  private readonly files: PeerFiles;
  private constructor(private readonly options: PeerExecutionOptions, description: PeerDescription) {
    this.description = description;
    this.grants = z.array(grantSchema).parse(readJsonFile(path.join(options.stateDir, "grants.json"), []));
    this.receipts = new PeerReceipts(path.join(options.stateDir, "receipts.json"));
    this.files = new PeerFiles(options.stateDir, (id, write) => this.readState(id, write));
  }
  static async create(options: PeerExecutionOptions): Promise<PeerExecutionService> {
    if (!/^[\w-]{1,80}$/.test(options.profileId)) throw new Error("Invalid peer profile ID");
    const state = options.threadId ? await options.backend.inspectThread(options.threadId) : undefined;
    if (state) {
      assertCodexThreadRunnable(state);
      if (state.internal || state.persistence !== "active" || !state.cwd || !path.isAbsolute(state.cwd)) throw new Error("Select an existing active Codex thread with a confirmed local cwd");
    }
    const info = options.backend.backendInfo();
    const capabilities = { ...info.capabilities, dynamicTools: false, structuredOutput: false, nativeQueue: false,
      goals: false, threadLifecycle: false, projectCatalog: false, projects: false, threadNaming: false };
    return new PeerExecutionService(options, { profileId: options.profileId, label: options.label,
      files: { version: 1 },
      thread: state ? { ...state, cwd: state.cwd! } : undefined,
      info: { id: info.id, capabilities }, independent: options.independent === true });
  }
  attach(connection: PeerConnection): void {
    connection.onClose(() => this.files.close(connection));
    connection.handle("binding.approve", async value => {
      const grant = grantSchema.parse(value);
      const allowedScope = this.description.thread ? grant.threadId === this.description.thread.threadId && !grant.scope : grant.scope === "device";
      if (!allowedScope || !await this.options.approve(grant) || !connection.open) return false;
      const next = [...this.grants.filter(g => g.id !== grant.id), grant];
      writeJsonFile(path.join(this.options.stateDir, "grants.json"), next, { durable: true }); this.grants = next;
      return true;
    });
    connection.handle("execution.call", async value => {
      const call = callSchema.parse(value);
      if (!this.grants.some(g => JSON.stringify(g) === JSON.stringify(call.grant)))
        throw new PeerError("access", "This chat/session grant was not approved on this device");
      try {
        if ((FILE_METHODS as readonly string[]).includes(call.method)) return await this.files.call(call.grant, connection, call.method, call.args[0]);
        return await this.execute(connection, call);
      }
      catch (error) {
        if (error instanceof PeerError) throw error;
        if (error instanceof CodexCommunicationError) throw new PeerError("codex-communication", "Codex communication was not confirmed", {
          phase: error.phase, operation: error.operation, threadId: error.threadId, turnId: error.turnId });
        if (error instanceof CodexBackendCapabilityError) throw new PeerError("capability", "The selected Codex profile does not support this operation", { capability: error.capability });
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
          if (call.grant.scope !== "device") throw new PeerError("access", "Device catalog access was not approved");
          const catalog = await backend.listSessionCatalog(catalogSchema.parse(args[0] ?? {}));
          return { ...catalog, hostIds: [], threads: catalog.threads.filter(state => !state.internal && state.persistence === "active"
            && state.cwd && path.isAbsolute(state.cwd)) };
        }
        case "listModels": return backend.listModels();
        case "getAccountRateLimits": return backend.getAccountRateLimits();
        case "receipt": return this.receipts.get(z.string().regex(/^[a-f0-9]{64}$/).parse(args[0])) ?? null;
        case "getRuntimeInfo": {
          const state = await this.readState(args[1] ?? this.description.thread?.threadId);
          return backend.getRuntimeInfo(state.cwd, state.threadId);
        }
        case "inspectThread": return this.readState(args[0]);
        default: await this.readState(args[0]); this.assertThread(args[0]);
      }
      switch (method) {
        case "readThreadSnapshot": return backend.readThreadSnapshot(args[0]);
        case "readTurnLifecycle": return backend.readTurnLifecycle?.(args[0], z.string().min(1).parse(args[1])) ?? { status: "unknown", source: "unknown" };
        case "getHistory": return (await backend.getHistory(args[0])).slice(-1000);
        case "getHistoryPage": return backend.getHistoryPage(args[0], z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional(),
          sortDirection: z.enum(["asc", "desc"]).optional() }).strict().parse(args[1] ?? {}));
      }
      throw new PeerError("unsupported", "Operation unavailable");
    }
    if (!operationId) throw new PeerError("identity", "Writes require a durable source identity");
    const callback = (name: string, values: unknown[]) => connection.request("execution.callback", { operationId, name, args: values },
      name === "onApproval" || name === "onUserInput" ? 120_000 : 30_000);
    const nativeInput = method === "stop" ? undefined : runSchema.parse(args[0]);
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
    const assertCurrent = () => {
      if (!connection.open) throw new CodexCommunicationError("preflight", method);
    };
    const event = async (name: string, values: unknown[]) => { try { return await callback(name, values); } catch { return undefined; } };
    const sourceId = `peer-${operationId}`;
    const input: CodexRunnerInput = { ...nativeInput!, clientUserMessageId: sourceId, assertCurrent,
      onThreadCreated: id => { this.assertThread(id, threadId); return event("onThreadCreated", [id]).then(() => {}); },
      onTurnStarted: async receipt => {
        this.assertThread(receipt.threadId, threadId); this.receipts.accepted(operationId, receipt.turnId);
        await event("onTurnStarted", [receipt]);
      },
      onDelta: text => event("onDelta", [text]).then(() => {}), onProgress: text => event("onProgress", [text]).then(() => {}),
      onRecovery: value => event("onRecovery", [value]).then(() => {}),
      onApproval: async request => {
        try {
          const decision = await callback("onApproval", [request]);
          return approvalOptions(request).some(option => option.id === decision) ? decision as CodexApprovalDecision : "decline";
        } catch { return "decline"; }
      },
      onApprovalResult: (request, result) => event("onApprovalResult", [request, result]).then(() => {}),
      onUserInput: async request => {
        try {
          const answer = await callback("onUserInput", [request]);
          return answer === null ? undefined : z.record(z.string(), z.object({ answers: z.array(z.string()) }).strict()).parse(answer);
        } catch { return undefined; }
      },
      onUserInputResult: (request, result) => event("onUserInputResult", [request, result]).then(() => {}) };
    try {
      let result: unknown;
      if (method === "run") result = await backend.run(input);
      else if (method === "stop") result = await backend.stop(threadId, undefined, assertCurrent);
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
        || error instanceof CodexBackendCapabilityError || error instanceof PeerError && error.code === "unsupported";
      // Preserve a durable accepted turn even if observation later disconnects.
      if (this.receipts.get(operationId)?.phase !== "accepted") this.receipts.failed(operationId, notSubmitted);
      throw error;
    }
  }
}
