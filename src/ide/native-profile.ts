import { z } from "zod";

export const extensionIdSchema = z.string().max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "扩展使用 publisher.name，不能填写路径、URL 或命令参数").transform(id => id.toLowerCase());
export const extensionListSchema = z.array(extensionIdSchema).max(200)
  .refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, "扩展重复");
export const nativeSettingsSchema = z.unknown().superRefine((value, context) => {
  const visit = (v: unknown, depth: number): boolean => {
    if (depth > 32) return false;
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (Array.isArray(v)) return v.every(item => visit(item, depth + 1));
    return typeof v === "object" && Object.entries(v!).every(([key, item]) => !["__proto__", "prototype", "constructor"].includes(key) && visit(item, depth + 1));
  };
  if (!value || typeof value !== "object" || Array.isArray(value) || !visit(value, 0) || JSON.stringify(value).length > 128_000) context.addIssue({ code: "custom", message: "设置必须是有界的 JSON 对象，不接受原型字段或非 JSON 值" });
}).pipe(z.record(z.string().min(1).max(300), z.unknown()));

/** JSONC scanner, not regex comment stripping: URLs, escaped quotes and
 * comment-like strings retain their exact values. Only trailing commas relax
 * JSON syntax; malformed strings/comments still fail through JSON.parse. */
export function parseIDEJSONC(text: string): unknown {
  if (text.length > 512_000) throw new Error("导入文件过大（最多 512 KB）");
  const chars = text.replace(/^\uFEFF/, "").split("");
  let quoted = false, escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === "/" && chars[i + 1] === "/") {
      for (; i < chars.length && !/[\r\n]/.test(chars[i]); i++) chars[i] = " "; i--;
    } else if (c === "/" && chars[i + 1] === "*") {
      chars[i++] = " "; chars[i] = " "; let closed = false;
      for (i++; i < chars.length; i++) {
        if (chars[i] === "*" && chars[i + 1] === "/") { chars[i++] = " "; chars[i] = " "; closed = true; break; }
        if (!/[\r\n]/.test(chars[i])) chars[i] = " ";
      }
      if (!closed) throw new Error("JSONC 注释未结束");
    }
  }
  quoted = false; escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { let j = i + 1; while (/\s/.test(chars[j] ?? "") && j < chars.length) j++; if (["}", "]"].includes(chars[j])) chars[i] = " "; }
  }
  return JSON.parse(chars.join(""));
}

export const profileImportSchema = z.object({ kind: z.enum(["settings", "extensions", "profile"]), content: z.string().max(512_000) }).strict();
export function importNativeIDEProfile(input: z.infer<typeof profileImportSchema>): {
  settings?: Record<string, unknown>; extensions?: string[]; warnings: string[];
} {
  const value = parseIDEJSONC(input.content), warnings: string[] = [];
  if (input.kind === "settings") return { settings: nativeSettingsSchema.parse(value), warnings };
  if (input.kind === "extensions") {
    const list = z.object({ recommendations: extensionListSchema.default([]), unwantedRecommendations: extensionListSchema.optional() }).strict().parse(value);
    if (list.unwantedRecommendations?.length) warnings.push("不安装 unwantedRecommendations 中的扩展；不会卸载已有扩展。");
    return { extensions: list.recommendations.filter(id => !list.unwantedRecommendations?.some(v => v.toLowerCase() === id.toLowerCase())), warnings };
  }
  const profile = z.object({ name: z.string().optional(), settings: z.string().optional(), extensions: z.string().optional() }).passthrough().parse(value);
  for (const key of Object.keys(profile)) if (!["name", "settings", "extensions", "icon"].includes(key))
    warnings.push(`未导入 Profile 的 ${key}；本入口只迁移设置和启用的扩展。`);
  if (profile.settings === undefined && profile.extensions === undefined) throw new Error("Profile 没有可导入的 settings 或 extensions");
  let extensions: string[] | undefined;
  if (profile.extensions !== undefined) {
    const entries = z.array(z.object({ identifier: z.object({ id: extensionIdSchema }).passthrough(), disabled: z.boolean().optional() }).passthrough()).max(200)
      .parse(parseIDEJSONC(profile.extensions));
    extensions = extensionListSchema.parse(entries.filter(row => !row.disabled).map(row => row.identifier.id));
    if (entries.some(row => row.disabled)) warnings.push("已跳过 Profile 中禁用的扩展。");
    if (entries.some(row => row.version)) warnings.push("扩展按当前 code-server 注册表选择兼容版本，不固定桌面导出的版本。");
  }
  return { ...(profile.settings !== undefined ? { settings: nativeSettingsSchema.parse(parseIDEJSONC(profile.settings)) } : {}),
    ...(extensions !== undefined ? { extensions } : {}), warnings };
}
