import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { AgentRuntimeAdapter } from "./contracts.js";
import { JsonLineClient } from "./json-line-client.js";
import { HerdrAppAdapter } from "./herdr/app.js";
import { HerdrAppViewClient } from "./herdr/app-view.js";
import { HerdrTuiAdapter } from "./herdr/tui.js";

// Explicit paths only. Discovery, tilde expansion and environment-dependent
// defaults could attach an existing binding to a different running service.
const socket = z.string().min(1).max(4096).refine(value => !value.includes("\0")
  && (path.isAbsolute(value) || process.platform === "win32" && value.startsWith("\\\\.\\pipe\\")), "必须是绝对 socket 路径");
const common = { version: z.literal(1), id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) };
// A single explicitly chosen interrupt key per exact detected agent. No text,
// key sequences, wildcards or automatic fallback can answer a terminal prompt.
const interruptKeys = z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.enum(["esc", "ctrl+c"]))
  .refine(value => Object.keys(value).length <= 64, "中断配置过多").optional();
export const herdrRuntimeConfigSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("herdr-tui"), socketPath: socket, interruptKeys }).strict(),
  z.object({ ...common, kind: z.literal("herdr-app"), windowSocketPath: socket, coreSocketPath: socket,
    expectedCoreId: z.string().min(1).max(200) }).strict()
]);
export type HerdrRuntimeConfig = z.infer<typeof herdrRuntimeConfigSchema>;

/** Changing a connection/core while retaining a friendly config id must not
 * silently reuse old grants or resource bindings. Hash parsed ordered fields,
 * not raw JSON (whose property order is not an identity). No secret is hashed. */
export function runtimeEndpointId(config: HerdrRuntimeConfig): string {
  const identity = config.kind === "herdr-tui" ? [config.version, config.kind, config.id, config.socketPath,
    ...Object.keys(config.interruptKeys ?? {}).length ? [Object.entries(config.interruptKeys!).sort(([a], [b]) => a.localeCompare(b))] : []]
    : [config.version, config.kind, config.id, config.windowSocketPath, config.coreSocketPath, config.expectedCoreId];
  return `${config.id}:${crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** Constructs only the explicitly selected adapter; does not connect, launch
 * services or modify current Connector/Codex configuration. */
export function createHerdrRuntime(value: unknown): AgentRuntimeAdapter {
  const config = herdrRuntimeConfigSchema.parse(value), id = runtimeEndpointId(config);
  if (config.kind === "herdr-tui") return new HerdrTuiAdapter(id,
    new JsonLineClient({ socketPath: config.socketPath, dialect: "herdr-tui" }), config.interruptKeys);
  return new HerdrAppAdapter(id, new JsonLineClient({ socketPath: config.coreSocketPath, dialect: "json-rpc" }),
    new HerdrAppViewClient(config.windowSocketPath), config.expectedCoreId);
}
