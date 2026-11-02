/** An optional, durable mutation identity. Older servers reject this body field
 * rather than silently performing an unprotected write. Identity is separate
 * from the payload fingerprint so reusing an ID for another operation fails. */
export async function readTaskSubmission(raw, scope, ApiError) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.hasOwn(raw, "clientRequestId")) {
    return { body: raw, submission: undefined };
  }
  const { clientRequestId, ...body } = raw;
  if (typeof clientRequestId !== "string" || !/^[a-f0-9]{64}$/.test(clientRequestId)) {
    throw new ApiError(400, "INVALID_REQUEST_ID", "'clientRequestId' must be a SHA-256 submission identity");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(canonical([scope, body])));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return { body, submission: { id: clientRequestId, fingerprint } };
}

export function checkTaskSubmission(existing, submission, ApiError) {
  if (existing && existing.fingerprint !== submission.fingerprint) {
    throw new ApiError(409, "REQUEST_ID_CONFLICT", "This request ID belongs to a different task operation");
  }
  return existing;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
