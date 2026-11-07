import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { RuntimeError, assertSameResource } from "../agents/contracts.js";
import { bindingResourceRef, type RuntimeResourceCatalog } from "../agents/resource-catalog.js";
import { RuntimeHandoffCoordinator, RuntimeHandoffJournal } from "../agents/handoff.js";
import { runtimeSendSchema, runtimeInterruptSchema, runtimeReceiptSchema } from "../agents/protocol.js";
import { PeerConnection, PeerError } from "./rpc.js";
import type { PeerGrant } from "./registry.js";
import { peerOperationId } from "./identity.js";
import { PeerReceipts } from "./receipts.js";
import { RuntimeLifecycleCoordinator, runtimeLifecycleSchema } from "../agents/lifecycle.js";
import { RuntimeWriteGate } from "../agents/write-gate.js";

/** Resource RPC lives behind the existing Connector grant/sharing envelope.
 * It cannot call native conversation methods, execute arbitrary upstream RPC,
 * turn terminal text into actions, or retry an ambiguous PTY write. */
export class PeerRuntimeService {
  private readonly handoff: RuntimeHandoffCoordinator;
  private readonly interrupts: PeerReceipts;
  private readonly lifecycle: RuntimeLifecycleCoordinator;
  private readonly writes = new RuntimeWriteGate();
  constructor(private readonly catalog: RuntimeResourceCatalog, stateDir: string) {
    this.handoff = new RuntimeHandoffCoordinator(catalog.runtime,
      new RuntimeHandoffJournal(path.join(stateDir, "runtime-handoffs-v1.json")), this.writes);
    this.interrupts = new PeerReceipts(path.join(stateDir, "runtime-interrupts-v1.json"));
    this.lifecycle = new RuntimeLifecycleCoordinator(catalog.runtime, path.join(stateDir, "runtime-lifecycle-v1.json"), this.writes);
  }
  async call(connection: PeerConnection, call: { method: string; args: unknown[]; operationId?: string; grant: PeerGrant }, assertAccess: () => void): Promise<unknown> {
    assertAccess();
    if (call.method === "runtimeLifecycle") {
      if (call.args.length !== 1) throw new PeerError("scope", "生命周期参数不完整。");
      const input = runtimeLifecycleSchema.parse(call.args[0]);
      if (!call.operationId || call.operationId !== peerOperationId(call.grant.hostId, call.method, call.grant.principal, input.clientUserMessageId))
        throw new PeerError("identity", "生命周期操作缺少匹配的来源标识。");
      if (call.grant.delegation || input.action === "create" && (call.grant.scope !== "device" || call.grant.threadId))
        throw new PeerError("scope", "此授权不包含资源生命周期管理。");
      if (input.action !== "create") {
        const ref = bindingResourceRef(input.threadId, this.catalog.descriptor.endpointId);
        if (ref.id !== input.target.ref.id || ref.endpointId !== input.target.ref.endpointId
          || call.grant.threadId && call.grant.threadId !== input.threadId)
          throw new PeerError("scope", "资源生命周期目标与授权不一致。");
      }
      const guard = () => { assertAccess(); if (!connection.open) throw new RuntimeError("scope", "原生命周期连接已结束"); };
      const prepare = async () => {
        guard();
        try { await connection.request("execution.callback", { operationId: call.operationId, name: "assertCurrent", args: [] }); }
        catch { throw new RuntimeError("scope", "原聊天不再授权此生命周期操作"); }
        guard();
      };
      await prepare();
      return this.lifecycle.execute(input, { operationId: call.operationId, sourceId: input.clientUserMessageId,
        principal: crypto.createHash("sha256").update(JSON.stringify(call.grant.principal)).digest("hex") }, guard, prepare);
    }
    if (call.method === "runtimeReceipt") {
      if (call.args.length !== 1 || call.operationId) throw new PeerError("scope", "回执查询必须是只读请求。");
      const input = runtimeReceiptSchema.parse(call.args[0]);
      const ref = bindingResourceRef(input.threadId, this.catalog.descriptor.endpointId);
      return this.handoff.lookup({ principal: crypto.createHash("sha256").update(JSON.stringify(call.grant.principal)).digest("hex"),
        sourceId: input.clientUserMessageId,
        operationId: peerOperationId(call.grant.hostId, "runtimeSend", call.grant.principal, input.clientUserMessageId) }, ref, input.fingerprint, assertAccess);
    }
    if (call.method === "runtimeRead") {
      if (call.args.length !== 1) throw new PeerError("scope", "读取资源参数不完整。");
      const ref = bindingResourceRef(z.string().parse(call.args[0]), this.catalog.descriptor.endpointId);
      const result = await this.catalog.runtime.read(ref); assertAccess(); return result;
    }
    if (!["runtimeSend", "runtimeInterrupt"].includes(call.method) || call.args.length !== 1)
      throw new PeerError("unsupported", "未知运行接口操作。");
    const input = call.method === "runtimeSend" ? runtimeSendSchema.parse(call.args[0]) : runtimeInterruptSchema.parse(call.args[0]);
    const ref = bindingResourceRef(input.threadId, this.catalog.descriptor.endpointId);
    if (input.target.ref.endpointId !== ref.endpointId || input.target.ref.id !== ref.id)
      throw new RuntimeError("scope", "绑定资源与写入目标不一致");
    if (!call.operationId || call.operationId !== peerOperationId(call.grant.hostId, call.method, call.grant.principal, input.clientUserMessageId))
      throw new PeerError("identity", "运行接口写入缺少匹配的来源标识。");
    const guard = () => { assertAccess(); if (!connection.open) throw new RuntimeError("scope", "原转发连接已经结束"); };
    const prepareWrite = async () => {
      guard();
      try { await connection.request("execution.callback", { operationId: call.operationId, name: "assertCurrent", args: [] }); }
      catch { throw new RuntimeError("scope", "原聊天或绑定已不再授权本次写入"); }
      guard();
    };
    // Cached receipts are also private data: check current origin before reading
    // the journal, and again at the actual transport write after connection.
    await prepareWrite();
    if (call.method === "runtimeSend" && "text" in input) {
      return this.handoff.sendOnce({ target: input.target, text: runtimeSendSchema.parse(call.args[0]).text, assertCurrent: guard, prepareWrite,
        source: { principal: crypto.createHash("sha256").update(JSON.stringify(call.grant.principal)).digest("hex"),
          sourceId: input.clientUserMessageId, operationId: call.operationId } });
    }
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([ref, input.target.incarnation, input.target.cwd, input.target.machine])).digest("hex");
    const old = this.interrupts.get(call.operationId);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new PeerError("identity", "中断来源标识对应其他目标。");
      if (old.phase === "completed") return old.result;
      throw new RuntimeError("transport", "原中断操作没有确认，未重复发送", "unknown");
    }
    const actual = await this.catalog.runtime.inspect(ref); assertSameResource(input.target, actual); guard();
    // Another request can finish inspect() while this one is in flight. The
    // durable begin result is authoritative; do not ignore a concurrent intent.
    const prior = this.interrupts.begin(call.operationId, fingerprint, input.threadId, call.method);
    if (prior) {
      if (prior.phase === "completed") return prior.result;
      throw new RuntimeError("transport", "原中断操作没有确认，未重复发送", "unknown");
    }
    let release: () => void;
    try { release = this.writes.acquire(ref); }
    catch (error) { this.interrupts.failed(call.operationId, true); throw error; }
    try {
      const result = await this.catalog.runtime.interrupt({ target: input.target, assertCurrent: guard, prepareWrite });
      if (result.ref.endpointId !== ref.endpointId || result.ref.id !== ref.id)
        throw new RuntimeError("changed", "中断回执来自其他资源", "unknown");
      this.interrupts.complete(call.operationId, result); return result;
    } catch (error) {
      this.interrupts.failed(call.operationId, error instanceof RuntimeError && error.submission === "not-sent");
      throw error;
    } finally { release(); }
  }
}
