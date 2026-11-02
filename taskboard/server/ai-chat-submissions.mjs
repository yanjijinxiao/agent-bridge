import { createHash } from "node:crypto";
import { ApiError } from "./database.mjs";

export function parseAiRequestId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new ApiError(400, "INVALID_REQUEST_ID", "clientRequestId must be a UUID");
  return value;
}

/** Only a digest and concrete target identity are retained by the dedup table.
 * Bodies/files still belong to the normal user event and attachment lifecycle. */
export function aiSubmission(input, kind, scope) {
  const id = parseAiRequestId(input.clientRequestId);
  if (!id) return undefined;
  const hash = createHash("sha256");
  hash.update(JSON.stringify(kind === "thread"
    ? [input.projectId, input.issueId, input.title, input.model, input.reasoningEffort, input.sandbox]
    : [input.message, input.skillIds ?? [], input.dangerFullAccessConfirmed ?? false]));
  for (const file of input.attachments ?? []) {
    hash.update(JSON.stringify([file.filename, file.contentType, createHash("sha256").update(file.data).digest("hex")]));
  }
  return { id, kind, scope, fingerprint: hash.digest("hex") };
}

export function findAiSubmission(database, request) {
  if (!request) return null;
  const existing = database.getAiChatSubmission(request.id);
  if (!existing) return null;
  if (existing.kind !== request.kind || existing.scope !== request.scope || existing.fingerprint !== request.fingerprint)
    throw new ApiError(409, "REQUEST_ID_CONFLICT", "This request id already belongs to another AI operation; no input was resubmitted");
  const target = existing.kind === "thread" ? database.getAiChatThread(existing.targetId) : database.getAiChatRun(existing.targetId);
  if (!target) throw new ApiError(410, "REQUEST_RETIRED", "The original AI operation was retired; no replacement was created");
  return target;
}

export function readAiSubmission(database, id) {
  parseAiRequestId(id);
  const existing = database.getAiChatSubmission(id);
  if (!existing) return { clientRequestId: id, status: "unknown" };
  const target = existing.kind === "thread" ? database.getAiChatThread(existing.targetId) : database.getAiChatRun(existing.targetId);
  return { clientRequestId: id, status: target ? "acknowledged" : "retired", kind: existing.kind, scope: existing.scope,
    ...(target ? existing.kind === "thread" ? { thread: target } : { run: target } : {}) };
}
