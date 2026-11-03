import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decryptFile } from "@wecom/aibot-node-sdk";
import type { ChannelAttachment, ChannelMessage, ChannelReference } from "./message.js";
import { fetchWithBudget } from "./network-request.js";
import { sanitizeFileName } from "../weixin/media.js";

/** Decode only provider-supplied structured content. A quote never becomes
 * the current command. Voice callbacks contain a transcript, not audio bytes. */
export function decodeWeComContent(body: Record<string, any>): { text: string; attachments: ChannelAttachment[]; unsupportedMessageType?: string } {
  const kind = body.msgtype ?? "text";
  if (kind === "text" || kind === "voice") {
    const text = body[kind]?.content;
    if (typeof text !== "string") throw new Error("企业微信文本内容缺失，未提交。");
    return { text: text.trim(), attachments: [] };
  }
  if (["image", "file", "video"].includes(kind)) {
    const value = body[kind];
    if (typeof value?.url !== "string" || !value.url) throw new Error("企业微信附件下载凭据缺失，未提交。");
    return { text: "", attachments: [{ kind, label: kind === "image" ? "image.jpg" : kind === "video" ? "video.mp4" : "file",
      item: { url: value.url, ...(value.aeskey ? { aeskey: value.aeskey } : {}) } }] };
  }
  if (kind === "mixed") {
    if (!Array.isArray(body.mixed?.msg_item) || !body.mixed.msg_item.length || body.mixed.msg_item.length > 40)
      throw new Error("企业微信混排消息格式无效，未提交。");
    const rows = body.mixed.msg_item.map((item: Record<string, any>) => {
      if (!item || !["text", "image"].includes(item.msgtype)) throw new Error("企业微信混排项类型无效，未提交。");
      return decodeWeComContent(item);
    });
    if (rows.some((row: ReturnType<typeof decodeWeComContent>) => row.unsupportedMessageType))
      throw new Error("企业微信混排消息包含未知内容，未提交。");
    return { text: rows.map((row: ReturnType<typeof decodeWeComContent>) => row.text).filter(Boolean).join("\n"),
      attachments: rows.flatMap((row: ReturnType<typeof decodeWeComContent>) => row.attachments) };
  }
  return { text: "", attachments: [], unsupportedMessageType: String(kind) };
}

export function decodeWeComQuote(quote: unknown): ChannelReference[] | undefined {
  if (!quote || typeof quote !== "object") return undefined;
  const value = quote as Record<string, any>;
  try {
    const decoded = decodeWeComContent(value);
    if (decoded.unsupportedMessageType) throw new Error();
    return [{ type: value.msgtype ?? "unknown", text: decoded.text, attachments: decoded.attachments, availability: "available" }];
  } catch {
    return [{ type: typeof value.msgtype === "string" ? value.msgtype : "unknown", attachments: [], availability: "metadata-only",
      reason: "引用缺少正文或有效附件下载凭据，请直接发送原内容。" }];
  }
}

/** The Bridge calls this only after admission. Download signed URLs with a
 * finite budget before decrypting; never log their URL, AES key or SDK errors. */
export async function resolveWeComAttachments(message: ChannelMessage, options: {
  inboundDir?: string; maxInboundBytes?: number; fetch?: typeof fetch; timeoutMs?: number;
}): Promise<ChannelAttachment[]> {
  if (!options.inboundDir) throw new Error("企业微信附件目录尚未配置。");
  const limit = Math.min(options.maxInboundBytes ?? 100 * 1024 * 1024, 100 * 1024 * 1024);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("企业微信附件大小限制无效。");
  const created: string[] = [], result: ChannelAttachment[] = [];
  try {
    for (const attachment of message.attachments) {
      if (attachment.path) { result.push(attachment); continue; }
      const { url, aeskey } = attachment.item;
      if (typeof url !== "string" || typeof aeskey !== "string" || Buffer.from(aeskey, "base64").length !== 32)
        throw new Error("企业微信附件下载凭据缺失或无效。");
      const endpoint = new URL(url);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("企业微信附件地址无效。");
      const response = await fetchWithBudget(options.fetch ?? fetch, endpoint, { timeoutMs: options.timeoutMs ?? 30_000, maxResponseBytes: limit + 32 });
      if (!response.ok) throw new Error("企业微信附件下载失败。");
      const encrypted = Buffer.from(await response.arrayBuffer());
      const bytes = decryptFile(encrypted, aeskey);
      if (bytes.length > limit) throw new Error("企业微信附件超过大小限制。");
      const disposition = response.headers.get("content-disposition") ?? "";
      const encodedName = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition)?.[1];
      let name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? attachment.label;
      if (encodedName) { try { name = decodeURIComponent(encodedName); } catch { /* Keep the safe default label. */ } }
      const label = sanitizeFileName(name).slice(0, 180) || attachment.label;
      fs.mkdirSync(options.inboundDir, { recursive: true, mode: 0o700 });
      const target = path.join(options.inboundDir, `${crypto.randomUUID()}-${label}`);
      const fd = fs.openSync(target, "wx", 0o600);
      // Own the new file before writing: ENOSPC can leave a partial file even
      // when writeFileSync throws. Cleanup must never touch earlier downloads.
      created.push(target);
      try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
      result.push({ ...attachment, item: {}, label, path: target });
    }
    return result;
  } catch {
    for (const file of created) { try { fs.rmSync(file, { force: true }); } catch { /* A failed cleanup must not submit an incomplete input. */ } }
    throw new Error("企业微信附件下载、解密或保存失败，消息未提交；请检查大小限制或重新发送原文件。");
  }
}
