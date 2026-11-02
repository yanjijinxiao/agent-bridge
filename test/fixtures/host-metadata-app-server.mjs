#!/usr/bin/env node
import readline from "node:readline";

// Different native hosts deliberately advertise different accounts and models.
const host = process.argv.find(arg => arg.startsWith("--host="))?.slice(7) ?? "local";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = { userAgent: "host-metadata-fixture" };
  else if (request.method === "config/read") result = { config: { model: `${host}-model`, model_provider: `${host}-provider` } };
  else if (host === "unavailable") {
    process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: "Host unavailable" } })}\n`);
    continue;
  } else if (request.method === "model/list") result = { data: [{ id: `${host}-model`, model: `${host}-model`, displayName: host,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }], defaultReasoningEffort: "medium" }], nextCursor: null };
  else if (request.method === "account/rateLimits/read") result = { rateLimits: { limitId: host, limitName: host,
    primary: { usedPercent: host === "local" ? 10 : 80, windowDurationMins: 300, resetsAt: null } } };
  else throw new Error(`Unexpected native request: ${request.method}`);
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
}
