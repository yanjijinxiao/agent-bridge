import { z } from "zod";
import type { ChannelStreamCheckpoint } from "./progress.js";

const count = z.number().int().nonnegative();
const failure = z.object({ operation: z.enum(["create", "deliver", "update"]), code: z.string(), httpStatus: count.optional(),
  requestId: z.string().optional(), uncertain: z.boolean(), requestNotSent: z.literal(true).optional() }).strict();
const bootstrap = z.object({ version: z.literal(1), instanceId: z.string().min(1), recipientId: z.string().min(1), messageId: z.string().optional(),
  stage: z.enum(["create-pending", "create-rejected", "create-unconfirmed", "created", "delivery-pending", "delivery-rejected", "delivery-unconfirmed", "delivered"]),
  adapterData: z.record(z.string(), z.string()).optional(), failure: failure.optional() }).strict();
const phaseProgress = z.object({ version: z.literal(1), phases: z.array(z.object({ text: z.string(), summary: z.string().optional() }).strict()),
  live: z.array(z.string()), completed: count, failed: count, lastTool: z.string().optional() }).strict();

/** Durable presentation data must be fully validated before it can name a
 * provider message or replay an acknowledged page plan. Recursive segments use
 * the same contract; no unvalidated passthrough becomes a delivery instruction. */
export const channelStreamCheckpointSchema: z.ZodType<ChannelStreamCheckpoint> = z.lazy(() => z.object({
  streamId: z.string().optional(), messageId: z.string().optional(), creationAttempted: z.boolean().optional(),
  bootstrap: bootstrap.optional(), presentationFailure: failure.optional(), startedAt: count,
  progressEntries: z.array(z.string()), progressReceipts: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  phaseProgress: phaseProgress.optional(), thought: z.string(), answerPreview: z.string(), finished: z.boolean(),
  communicationNotice: z.string().optional(), recoveryNotice: z.string().optional(),
  presentationCorrection: z.object({ text: z.string(), delivered: z.boolean() }).strict().optional(),
  toolActivity: z.object({ completed: count, failed: count, active: z.string().optional(), last: z.string().optional() }).strict().optional(),
  terminal: z.object({ text: z.string(), error: z.boolean(), outcome: z.enum(["completed", "failed", "interrupted", "continued", "detached",
    "session-restored", "session-unconfirmed", "terminal-idle", "terminal-exited", "terminal-error", "input-not-sent"]).optional() }).strict().optional(),
  statusHeader: z.literal(true).optional(), activity: z.enum(["running", "waiting-input", "waiting-approval", "waiting-external", "recovering", "unconfirmed", "waiting-result"]).optional(),
  terminalNoticeSent: z.boolean().optional(), terminalNoticeAttempted: z.boolean().optional(), resultPageBytes: z.number().int().positive().optional(),
  resultPresentation: z.enum(["card", "native-text"]).optional(),
  terminalPages: z.array(z.object({ messageId: z.string().optional(), delivered: z.boolean(), attempted: z.boolean().optional(), bootstrap: bootstrap.optional() }).strict()).optional(),
  segments: z.object({ acceptedInputs: z.array(z.string()), previous: z.array(z.object({ inputId: z.string(),
    checkpoint: channelStreamCheckpointSchema, attempts: count, retryAt: count.optional() }).strict()),
    answerPrefix: z.object({ length: count, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict().optional()
}).strict());
