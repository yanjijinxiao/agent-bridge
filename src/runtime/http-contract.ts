import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONTRACTS, runtimeIdentity } from "./versions.js";
import { diagnostic, withDiagnosticContext } from "./diagnostics.js";

/** Gateway-owned HTTP surfaces share an additive header contract. Proxied
 * Code Server bodies/streams keep their upstream protocol and authentication. */
export function withHttpContract(request: IncomingMessage, response: ServerResponse, surface: string,
  action: () => Promise<void>): Promise<void> {
  const runtime = runtimeIdentity("gateway"), requestId = crypto.randomUUID(), started = Date.now();
  response.setHeader("X-Gateway-API-Version", `${CONTRACTS.http.major}.${CONTRACTS.http.minor}`);
  response.setHeader("X-Gateway-Instance", runtime.instanceId);
  response.setHeader("X-Gateway-Request-ID", requestId);
  response.setHeader("X-Gateway-Interface", surface);
  let finished = false;
  const record = (status: string | number) => { if (finished) return; finished = true;
    diagnostic("http.request.finished", { requestId, method: request.method, surface, status, durationMs: Date.now() - started }); };
  response.once("finish", () => record(response.statusCode));
  response.once("close", () => record("connection-closed"));
  const version = request.headers["x-gateway-api-version"];
  if (version !== undefined && (typeof version !== "string" || !new RegExp(`^${CONTRACTS.http.major}\\.\\d+$`).test(version))) {
    response.writeHead(426, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Gateway API version is incompatible", code: "api-version-incompatible",
      supported: CONTRACTS.http, submission: "not-submitted" })); return Promise.resolve();
  }
  return withDiagnosticContext({ requestId }, action);
}
