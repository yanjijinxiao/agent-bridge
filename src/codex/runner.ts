/** Import compatibility only. All operations use the one native App Server adapter. */
export { CodexAppServerGateway as CodexBackendRouter, CodexAppServerGateway as HybridCodexRunner } from "./app-server-gateway.js";
export type { CodexBackend, CodexAppServerGatewayOptions as CodexBackendRouterOptions,
  CodexAppServerGatewayOptions as HybridCodexRunnerOptions } from "./app-server-gateway.js";
export type { EphemeralCodexRunnerInput } from "./backend.js";
