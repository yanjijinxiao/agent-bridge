import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ApiError } from "./database.mjs";

const fail = message => { throw new ApiError(400, "WORKFLOW_PROVIDER_CONFIG", message); };
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const isHttpWorkflowNode = kind => ["custom-api", "twitter-post"].includes(kind);

/** Credentials and destinations are device configuration, never canvas fields.
 * A custom endpoint is opt-in per project and kind. Sending a request has a
 * durable pre-dispatch marker; losing its response cannot cause another POST. */
export class WorkflowHttpNodes {
  constructor({ configPath, fetch = globalThis.fetch, environment = process.env }) {
    this.configPath = configPath; this.fetch = fetch; this.environment = environment;
  }

  async profile(name, projectId, kind) {
    let config;
    try { config = JSON.parse(await readFile(this.configPath, "utf8")); }
    catch { fail("外部连接配置尚未安装或无法读取；未发送请求"); }
    const profile = config?.version === 1 && Object.hasOwn(config.profiles ?? {}, name) && config.profiles[name];
    if (!plain(profile) || !Array.isArray(profile.projectIds) || !profile.projectIds.includes(projectId)
      || !Array.isArray(profile.kinds) || !profile.kinds.includes(kind))
      fail("请选择已授权给此项目及节点类型的连接配置");
    const endpoint = kind === "twitter-post" ? "https://api.x.com/2/tweets" : profile.endpoint;
    let url;
    try { url = new URL(endpoint); } catch { fail("连接配置需要有效的 HTTPS 地址"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("连接配置需要不含内嵌凭据的 HTTPS 地址");
    const headers = { "Content-Type": "application/json" };
    let secret;
    if (profile.tokenEnv) {
      secret = this.environment[profile.tokenEnv];
      if (!secret || /[\r\n]/.test(secret)) fail("连接的认证环境变量未配置；未发送请求");
      headers.Authorization = `Bearer ${secret}`;
    }
    if (kind === "twitter-post" && !secret) fail("X 发布需要用户 OAuth 访问令牌配置");
    return { endpoint: url.href, headers, secret, signature: digest([name, profile, url.href]) };
  }

  async advance({ run, node, step, update, isCurrent }) {
    if (step.http?.phase === "received") return step.http.output;
    if (step.http) {
      // The server may have acted before the connection or process died. There
      // is deliberately no generic retry for a non-idempotent provider API.
      update(s => { s.status = "uncertain"; s.error = "外部请求结果待核对，未重发；后续节点尚未执行。"; });
      return null;
    }
    const d = node.data;
    const name = typeof d.providerProfile === "string" && d.providerProfile.trim();
    if (!name) fail("请选择外部连接配置");
    const profile = await this.profile(name, run.projectId, d.kind);
    let body;
    if (d.kind === "twitter-post") {
      if (typeof d.twitterPostContent !== "string" || !d.twitterPostContent.trim()) fail("发布正文不能为空");
      body = { text: d.twitterPostContent };
    } else {
      try { body = JSON.parse(d.providerRequest); } catch { fail("请求正文必须是 JSON"); }
      if (!plain(body)) fail("请求正文必须是 JSON 对象");
      // Typed placeholder substitution, never string concatenation into JSON.
      const bind = value => value === "{{input}}" ? step.input.text ?? ""
        : Array.isArray(value) ? value.map(bind) : plain(value)
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bind(v)])) : value;
      body = bind(body);
    }
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > 256_000) fail("请求正文超出 256 KB");
    if (!isCurrent()) return null;
    update(s => { s.status = "running"; s.http = { phase: "submitting", profile: name,
      configuration: profile.signature, payloadHash: digest(body), submittedAt: new Date().toISOString() }; });
    let response, payload;
    try {
      response = await this.fetch(profile.endpoint, { method: "POST", headers: profile.headers,
        body: serialized, redirect: "error", signal: AbortSignal.timeout(30_000) });
      const reader = response.body?.getReader(); const chunks = []; let size = 0;
      if (reader) try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 1_000_000) throw Error("response too large");
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      // Do not persist fetch exceptions or provider bodies: they can contain
      // credentials, reflected request headers, or authentication redirects.
      if (isCurrent(false)) update(s => { s.status = "uncertain"; s.error = "外部请求已发出，响应未完整确认；不会自动重发。"; });
      return null;
    }
    if (!isCurrent(false)) return null;
    if (!response.ok || response.status === 202) {
      // A provider's server error may follow a committed side effect. All HTTP
      // failures remain explicit and never authorize an automatic retry.
      update(s => { s.status = "uncertain"; s.error = `外部接口返回 HTTP ${response.status}，结果待核对；未重发。`; });
      return null;
    }
    if (d.kind === "twitter-post" && (typeof payload?.data?.id !== "string" || payload.errors?.length)) {
      update(s => { s.status = "uncertain"; s.error = "X 未返回明确的发布回执；未重发。"; }); return null;
    }
    const clean = (value, key = "") => /token|secret|password|authorization|credential|api.?key/i.test(key) ? "[已隐藏]"
      : typeof value === "string" ? (profile.secret ? value.split(profile.secret).join("[已隐藏]") : value)
        : Array.isArray(value) ? value.map(v => clean(v)) : plain(value)
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)])) : value;
    const output = { text: d.kind === "twitter-post" ? `已发布：${payload.data.id}` : JSON.stringify(clean(payload)),
      httpStatus: response.status, ...(d.kind === "twitter-post" ? { postId: payload.data.id } : {}) };
    update(s => { s.http.phase = "received"; s.http.output = output; });
    return output;
  }
}
