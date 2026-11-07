import { z } from "zod";
import { RuntimeError, type RuntimeResource, type RuntimeDescriptor, type RuntimeOutput, type RuntimeInterrupt } from "./contracts.js";
import { runtimeHandoffRecordSchema } from "./handoff.js";
import { PEER_CAPABILITIES } from "../runtime/versions.js";

/** Independent, additive wire contract. Product/npm versions do not authorize
 * a peer to reinterpret a terminal receipt as a native conversation turn. */
export const RUNTIME_PROTOCOL_VERSION = PEER_CAPABILITIES.runtimeContract;
const operationSchema = z.enum(["catalog", "inspect", "read", "send", "interrupt", "create", "rename", "archive", "delete",
  "native-steer", "native-queue", "models", "settings", "goal", "usage", "interaction", "structured-output"]);
export const runtimeDescriptorSchema = z.object({ kind: z.enum(["codex", "herdr-tui", "herdr-app"]), endpointId: z.string().min(1).max(200),
  serverId: z.string().min(1).max(512).optional(), version: z.string().min(1).max(100),
  protocol: z.object({ name: z.string().min(1).max(100), generation: z.number().int().nonnegative().optional() }).strict(),
  operations: z.record(operationSchema, z.discriminatedUnion("supported", [
    z.object({ supported: z.literal(true), semantics: z.string().min(1).max(200) }).strict(),
    z.object({ supported: z.literal(false), reason: z.string().min(1).max(1000),
      availability: z.enum(["native-unavailable", "not-adapted", "configuration-required"]).optional() }).strict()
  ]))
}).strict() satisfies z.ZodType<RuntimeDescriptor>;
export const runtimeRefSchema = z.object({ endpointId: z.string().min(1).max(200), id: z.string().min(1).max(512) }).strict();
export const runtimeResourceSchema = z.object({ ref: runtimeRefSchema, kind: z.enum(["terminal", "conversation"]),
  title: z.string().max(4096), projectId: z.string().max(512).optional(), cwd: z.string().max(4096).optional(),
  machine: z.string().min(1).max(512).optional(), agent: z.string().max(512).optional(),
  state: z.enum(["idle", "working", "blocked", "done", "error", "exited", "unknown"]),
  evidence: z.enum(["native-lifecycle", "program-report", "terminal-detection", "process-exit", "unknown"]),
  incarnation: z.string().min(1).max(512).optional(), identityStrength: z.enum(["native", "observed", "unknown"]),
  observationSequence: z.number().int().nonnegative().optional(), blockedKind: z.string().max(512).optional()
}).strict() satisfies z.ZodType<RuntimeResource>;
export const runtimeSendSchema = z.object({ threadId: z.string().min(1).max(512), target: runtimeResourceSchema,
  text: z.string().min(1).max(500000), clientUserMessageId: z.string().min(1).max(512) }).strict();
export const runtimeInterruptSchema = runtimeSendSchema.omit({ text: true });
export const runtimeReceiptSchema = z.object({ threadId: z.string().min(1).max(512),
  clientUserMessageId: z.string().min(1).max(512), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type RuntimeReceiptInput = z.infer<typeof runtimeReceiptSchema>;
export const runtimeErrorSchema = z.object({ code: z.enum(["unsupported", "incompatible", "scope", "changed", "not-ready", "protocol", "transport"]),
  submission: z.enum(["not-sent", "unknown"]) }).strict();
export const runtimeOutputSchema = z.object({ kind: z.literal("terminal-screen"), ref: runtimeRefSchema,
  text: z.string().max(1_000_000), complete: z.boolean(), source: z.enum(["screen", "recent"]) }).strict() satisfies z.ZodType<RuntimeOutput>;
export const runtimeInterruptResultSchema = z.object({ kind: z.enum(["interrupt-requested", "not-active"]), ref: runtimeRefSchema,
  observation: z.enum(["stopped", "exited", "still_working", "unknown"]).optional() }).strict() satisfies z.ZodType<RuntimeInterrupt>;
/** Decode at the transport boundary; never attach malformed response bodies to
 * user-facing/logged errors, and never classify an invalid write ack as unsent. */
export function runtimeResponse<T>(schema: z.ZodType<T>, raw: unknown, write = false): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new RuntimeError("protocol", "运行接口回执格式不兼容", write ? "unknown" : "not-sent");
  return result.data;
}
export { runtimeHandoffRecordSchema };
export const RUNTIME_METHODS = ["runtimeRead", "runtimeSend", "runtimeInterrupt", "runtimeReceipt", "runtimeLifecycle"] as const;
export type RuntimeSendInput = z.infer<typeof runtimeSendSchema> & { assertCurrent: () => void };
export type RuntimeInterruptInput = z.infer<typeof runtimeInterruptSchema> & { assertCurrent: () => void };
