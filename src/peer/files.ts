import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { PeerGrant } from "./registry.js";
import { PeerConnection, PeerError } from "./rpc.js";
import type { CodexInboundFile } from "../codex/inbound-files.js";
import type { OutboundFile } from "../codex/outbound-files.js";

export const FILE_METHODS = ["fileUploadBegin", "fileUploadChunk", "fileUploadFinish", "fileDownloadBegin", "fileDownloadChunk", "fileClose"] as const;
export const FILE_CHUNK_BYTES = 256 * 1024;
export const MAX_PEER_FILE_BYTES = 100 * 1024 * 1024;
const ttl = 5 * 60_000;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sizeSchema = z.number().int().min(0).max(MAX_PEER_FILE_BYTES);
const threadSchema = z.string().min(1).max(512);
const hash = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };
function name(value: string): string {
  const clean = path.basename(value.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f/:*?"<>|]/g, "_").replace(/^\.+/, "");
  if (Buffer.byteLength(clean) <= 160) return clean || "attachment";
  const extension = path.extname(clean).slice(0, 20);
  let stem = "";
  for (const char of clean.slice(0, extension ? -extension.length : undefined)) {
    if (Buffer.byteLength(stem + char + extension) > 160) break;
    stem += char;
  }
  return stem + extension;
}
function limit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new PeerError("size", "Invalid file size limit");
  return Math.min(maxBytes, MAX_PEER_FILE_BYTES);
}
function regular(fd: number, maxBytes: number): fs.Stats {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size > maxBytes) throw new PeerError("size", "File is not regular or exceeds the transfer limit");
  return stat;
}
function digest(fd: number, size: number): string {
  const sum = crypto.createHash("sha256"), bytes = Buffer.alloc(FILE_CHUNK_BYTES);
  for (let offset = 0; offset < size;) {
    const read = fs.readSync(fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
    if (!read) throw new PeerError("changed", "File changed during transfer");
    sum.update(bytes.subarray(0, read)); offset += read;
  }
  return sum.digest("hex");
}
function open(file: string, maxBytes: number): { fd: number; stat: fs.Stats } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try { return { fd, stat: regular(fd, maxBytes) }; } catch (error) { fs.closeSync(fd); throw error; }
}
type Lease = {
  kind: "upload" | "download"; owner: PeerConnection; grantId: string; threadId: string;
  fd: number; size: number; offset: number; expected: string; timer: NodeJS.Timeout;
  temporary?: string; target?: string; sum?: crypto.Hash; stat?: fs.Stats;
};

/** Private upload storage and bounded descriptor leases. No caller chooses an upload path. */
export class PeerFiles {
  private readonly leases = new Map<string, Lease>();
  constructor(private readonly stateDir: string,
    private readonly inspect: (threadId: string, write: boolean) => Promise<{ cwd: string }>) {}
  private directory(grant: PeerGrant, threadId: string, scope?: string): string {
    let dir = fs.realpathSync(this.stateDir);
    for (const part of ["files", "inbound", grant.id, hash(threadId), ...(scope ? [hash(scope)] : [])]) {
      dir = path.join(dir, part);
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw new PeerError("path", "Attachment directory is unavailable");
    }
    return dir;
  }
  private add(value: Omit<Lease, "timer">): string {
    if (this.leases.size >= 8 || [...this.leases.values()].reduce((n, l) => n + l.size, 0) + value.size > 2 * MAX_PEER_FILE_BYTES)
      throw new PeerError("busy", "Too many file transfers");
    const id = crypto.randomUUID(), timer = setTimeout(() => this.remove(id), ttl); timer.unref();
    this.leases.set(id, { ...value, timer }); return id;
  }
  private remove(id: string): void {
    const lease = this.leases.get(id); if (!lease) return;
    this.leases.delete(id); clearTimeout(lease.timer);
    try { fs.closeSync(lease.fd); } catch { /* Already closed on completion. */ }
    if (lease.temporary) {
      try { fs.rmSync(lease.temporary, { force: true }); }
      catch { console.warn("[codex-im-gateway] incomplete peer attachment cleanup deferred"); }
    }
  }
  close(owner: PeerConnection): void { for (const [id, lease] of this.leases) if (lease.owner === owner) this.remove(id); }
  async call(grant: PeerGrant, owner: PeerConnection, method: string, payload: unknown, authorize?: (threadId: string) => void): Promise<unknown> {
    if (method === "fileUploadBegin") {
      const p = z.object({ threadId: threadSchema, scope: z.string().min(1).max(4096), name: z.string().max(1024), size: sizeSchema, hash: hashSchema }).strict().parse(payload);
      if (grant.threadId && grant.threadId !== p.threadId) throw new PeerError("scope", "File transfer thread is not granted");
      await this.inspect(p.threadId, true);
      authorize?.(p.threadId);
      if (!owner.open) throw new PeerError("offline", "File transfer connection closed");
      const dir = this.directory(grant, p.threadId, p.scope), target = path.join(dir, `${p.hash}-${name(p.name)}`);
      if (fs.existsSync(target)) {
        const prior = open(target, p.size);
        try { if (prior.stat.size !== p.size || digest(prior.fd, p.size) !== p.hash) throw new PeerError("changed", "Stored attachment does not match"); }
        finally { fs.closeSync(prior.fd); }
        return { complete: true, path: target };
      }
      const temporary = path.join(dir, `.${crypto.randomUUID()}.part`), fd = fs.openSync(temporary, "wx", 0o600);
      try { return { id: this.add({ kind: "upload", owner, grantId: grant.id, threadId: p.threadId, fd, size: p.size, offset: 0, expected: p.hash, temporary, target, sum: crypto.createHash("sha256") }) }; }
      catch (error) { fs.closeSync(fd); fs.rmSync(temporary, { force: true }); throw error; }
    }
    if (method === "fileDownloadBegin") {
      const p = z.object({ threadId: threadSchema, path: z.string().min(1).max(16384), maxBytes: sizeSchema }).strict().parse(payload);
      if (grant.threadId && grant.threadId !== p.threadId) throw new PeerError("scope", "File transfer thread is not granted");
      const state = await this.inspect(p.threadId, false);
      authorize?.(p.threadId);
      if (!owner.open) throw new PeerError("offline", "File transfer connection closed");
      if (!path.isAbsolute(p.path)) throw new PeerError("path", "An absolute output file path is required");
      const file = fs.realpathSync(p.path), workspace = fs.realpathSync(state.cwd), inbound = this.directory(grant, p.threadId);
      if (!inside(workspace, file) && !inside(inbound, file)) throw new PeerError("path", "Output file must belong to the selected session workspace or its received attachments");
      const { fd, stat } = open(file, p.maxBytes);
      try {
        const expected = digest(fd, stat.size), current = fs.statSync(file);
        if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || fs.realpathSync(p.path) !== file)
          throw new PeerError("changed", "Output file changed before transfer");
        return { id: this.add({ kind: "download", owner, grantId: grant.id, threadId: p.threadId, fd, size: stat.size, offset: 0, expected, stat }),
          size: stat.size, hash: expected, name: name(inside(inbound, file) ? path.basename(file).replace(/^[a-f0-9]{64}-/, "") : p.path) };
      } catch (error) { fs.closeSync(fd); throw error; }
    }
    const p = z.object({ id: z.string().uuid(), offset: sizeSchema.optional(), data: z.string().max(Math.ceil(FILE_CHUNK_BYTES / 3) * 4).optional() }).strict().parse(payload);
    const lease = this.leases.get(p.id);
    if (!lease || lease.owner !== owner || lease.grantId !== grant.id) throw new PeerError("scope", "File transfer expired or belongs to another connection or chat");
    authorize?.(lease.threadId);
    if (method === "fileClose") { this.remove(p.id); return null; }
    try {
      if (method === "fileUploadChunk" && lease.kind === "upload") {
        const bytes = Buffer.from(p.data ?? "", "base64");
        if (p.offset !== lease.offset || !bytes.length || bytes.length > FILE_CHUNK_BYTES || bytes.toString("base64") !== p.data || lease.offset + bytes.length > lease.size)
          throw new PeerError("size", "Invalid attachment chunk or offset");
        let written = 0;
        while (written < bytes.length) { const n = fs.writeSync(lease.fd, bytes, written, bytes.length - written); if (!n) throw Error("Attachment disk write failed"); written += n; }
        lease.sum!.update(bytes); lease.offset += bytes.length; return { offset: lease.offset };
      }
      if (method === "fileUploadFinish" && lease.kind === "upload") {
        await this.inspect(lease.threadId, true);
        if (lease.offset !== lease.size || lease.sum!.digest("hex") !== lease.expected) throw new PeerError("hash", "Attachment is incomplete or checksum does not match");
        fs.fsyncSync(lease.fd);
        try { fs.linkSync(lease.temporary!, lease.target!); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const prior = open(lease.target!, lease.size);
          try { if (prior.stat.size !== lease.size || digest(prior.fd, lease.size) !== lease.expected) throw new PeerError("hash", "Stored attachment does not match"); }
          finally { fs.closeSync(prior.fd); }
        }
        const result = { path: lease.target }; this.remove(p.id); return result;
      }
      if (method === "fileDownloadChunk" && lease.kind === "download") {
        const stat = regular(lease.fd, lease.size);
        if (p.offset !== lease.offset || stat.size !== lease.size || stat.mtimeMs !== lease.stat!.mtimeMs || stat.ctimeMs !== lease.stat!.ctimeMs)
          throw new PeerError("changed", "Output file changed during transfer");
        const bytes = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, lease.size - lease.offset));
        const count = fs.readSync(lease.fd, bytes, 0, bytes.length, lease.offset);
        if (count !== bytes.length) throw new PeerError("changed", "Output file changed during transfer");
        lease.offset += count; return { data: bytes.toString("base64"), offset: lease.offset };
      }
      throw new PeerError("unsupported", "Invalid file transfer operation");
    } catch (error) { this.remove(p.id); throw error; }
  }
}

export type FileCall = <T = unknown>(method: string, payload: unknown) => Promise<T>;
export async function uploadPeerFiles(files: CodexInboundFile[], scope: string, threadId: string, maxBytes: number, call: FileCall): Promise<CodexInboundFile[]> {
  const output: CodexInboundFile[] = [], max = limit(maxBytes);
  if (files.length > 20) throw new PeerError("size", "Too many attachments");
  for (const file of files) {
    const { fd, stat } = open(file.path, max); let id: string | undefined;
    try {
      const expected = digest(fd, stat.size);
      const begin = await call<{ id?: string; complete?: boolean; path?: string }>("fileUploadBegin", { threadId, scope, name: file.label, size: stat.size, hash: expected });
      let remotePath = begin.path;
      if (!begin.complete) {
        id = z.string().uuid().parse(begin.id);
        const bytes = Buffer.alloc(FILE_CHUNK_BYTES);
        for (let offset = 0; offset < stat.size;) {
          const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, stat.size - offset), offset);
          if (!count) throw new PeerError("changed", "Attachment changed during transfer");
          const reply = await call<{ offset: number }>("fileUploadChunk", { id, offset, data: bytes.subarray(0, count).toString("base64") });
          offset += count; if (reply.offset !== offset) throw new PeerError("protocol", "Attachment offset was not acknowledged");
        }
        const result = await call<{ path: string }>("fileUploadFinish", { id }); remotePath = result.path;
      }
      if (typeof remotePath !== "string" || !path.isAbsolute(remotePath) || path.basename(remotePath) !== `${expected}-${name(file.label)}`)
        throw new PeerError("protocol", "Device did not acknowledge attachment path");
      output.push({ ...file, path: remotePath });
    } finally {
      fs.closeSync(fd);
      if (id) await call("fileClose", { id }).catch(() => {});
    }
  }
  return output;
}
export async function downloadPeerFile(threadId: string, file: string, maxBytes: number, call: FileCall): Promise<OutboundFile> {
  const begin = z.object({ id: z.string().uuid(), size: sizeSchema, hash: hashSchema, name: z.string().min(1).max(1024) }).strict()
    .parse(await call("fileDownloadBegin", { threadId, path: file, maxBytes: limit(maxBytes) }));
  let dir: string | undefined, fd: number | undefined;
  try {
    if (begin.size > limit(maxBytes)) throw new PeerError("size", "Output exceeds configured size limit");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-peer-output-")); fs.chmodSync(dir, 0o700);
    const target = path.join(dir, name(begin.name)); fd = fs.openSync(target, "wx", 0o600);
    const sum = crypto.createHash("sha256");
    for (let offset = 0; offset < begin.size;) {
      const result = z.object({ data: z.string().max(Math.ceil(FILE_CHUNK_BYTES / 3) * 4), offset: sizeSchema }).strict()
        .parse(await call("fileDownloadChunk", { id: begin.id, offset }));
      const bytes = Buffer.from(result.data, "base64");
      if (!bytes.length || bytes.length > FILE_CHUNK_BYTES || bytes.toString("base64") !== result.data || result.offset !== offset + bytes.length || result.offset > begin.size)
        throw new PeerError("protocol", "Invalid output file chunk");
      let written = 0;
      while (written < bytes.length) { const n = fs.writeSync(fd, bytes, written, bytes.length - written); if (!n) throw Error("Output disk write failed"); written += n; }
      sum.update(bytes); offset = result.offset;
    }
    if (sum.digest("hex") !== begin.hash) throw new PeerError("hash", "Output file checksum does not match");
    fs.closeSync(fd); fd = undefined;
    return { path: target, dispose: () => fs.rmSync(dir!, { recursive: true, force: true }) };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally { await call("fileClose", { id: begin.id }).catch(() => {}); }
}
