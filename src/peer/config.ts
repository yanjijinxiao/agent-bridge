import { z } from "zod";
import { herdrRuntimeConfigSchema } from "../agents/config.js";
import { peerIDEConfigSchema } from "./ide-service.js";
import { deviceIdSchema } from "./credentials.js";
import { managedExportSchema } from "./managed-route.js";

/** Old Codex configurations keep their executor; Herdr is explicit and may
 * not inherit native-host discovery or silently launch another service. */
export const connectorConfigSchema = z.object({ url: z.string().url(), nodeId: deviceIdSchema.optional(), tokenFile: z.string().min(1).optional(), caFile: z.string().optional(),
    allowInsecureLan: z.boolean().default(false), profileId: z.string().default("default"), label: z.string().min(1).max(80).optional(), threadId: z.string().min(1).optional(),
    codexHome: z.string().optional(), codexBin: z.string().optional(), backend: z.enum(["app-server", "herdr-tui", "herdr-app"]).default("app-server"), runtime: herdrRuntimeConfigSchema.optional(),
    appServerTransport: z.enum(["daemon", "stdio"]).optional(),
    webIDE: peerIDEConfigSchema.optional(),
    managedRoute: managedExportSchema.optional(),
    managedHosts: z.array(managedExportSchema.extend({ webIDE: peerIDEConfigSchema.optional() }).strict()).max(100).optional(),
    stateDir: z.string().optional() }).strict().refine(value => value.backend === "app-server" ? !value.runtime : value.runtime?.kind === value.backend && !value.managedHosts?.length
      && value.codexHome === undefined && value.codexBin === undefined && value.appServerTransport === undefined,
      "Herdr 必须配置同种 runtime；不能同时导出 Codex 主机或继承 Codex profile")
    .refine(value => Boolean(value.nodeId) === Boolean(value.tokenFile),
      "旧凭据必须同时保留 nodeId 和 tokenFile；新设备请同时省略，由 Connector 自动生成身份")
    .refine(value => !value.managedRoute || !!value.tokenFile && !value.threadId, "托管迁移必须预配置设备身份且导出完整主机")
    .transform(value => ({ ...value, codexBin: value.codexBin ?? "codex", appServerTransport: value.appServerTransport ?? "daemon" as const }));
export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;
