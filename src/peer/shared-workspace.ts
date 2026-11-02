import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PeerError } from "./rpc.js";

export type SharedDirectory = { path: string; dev: number; ino: number };
const maxBytes = 128 * 1024;
const fail = () => new PeerError("workspace", "目录、文件或版本已改变，未读取或写入；请刷新并请所有者核对。");
export function sharedDirectory(cwd: string): SharedDirectory {
  const actual = fs.realpathSync(cwd), stat = fs.statSync(actual);
  if (!path.isAbsolute(actual) || !stat.isDirectory()) throw fail();
  return { path: actual, dev: stat.dev, ino: stat.ino };
}
function target(root: SharedDirectory, relative: string, directory = false): string {
  const current = sharedDirectory(root.path);
  if (current.dev !== root.dev || current.ino !== root.ino || current.path !== root.path) throw fail();
  if (typeof relative !== "string" || relative.length > 4096 || /[\\\0\r\n]/.test(relative) || path.isAbsolute(relative)) throw fail();
  const parts = relative ? relative.split("/") : [];
  if (parts.some(p => !p || p === "." || p === ".." || [".git", ".ssh", ".aws", ".codex"].includes(p) || /^\.env(?:\.|$)/i.test(p))) throw fail();
  let file = root.path;
  for (const part of parts) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file) throw fail();
  }
  const stat = fs.statSync(file);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw fail();
  return file;
}
const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
function read(root: SharedDirectory, relative: string): { file: string; bytes: Buffer; hash: string } {
  const file = target(root, relative), fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd), actual = fs.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || stat.ino !== actual.ino || stat.dev !== actual.dev || target(root, relative) !== file) throw fail();
    const bytes = fs.readFileSync(fd);
    if (bytes.length > maxBytes || bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) throw fail();
    return { file, bytes, hash: sha(bytes) };
  } finally { fs.closeSync(fd); }
}
/** Text editor only: no process/terminal API and no user-selected root. */
export function sharedWorkspace(root: SharedDirectory, method: string, input: { path: string; text?: string; hash?: string }, guard: () => void): unknown {
  guard();
  if (method === "workspace.list") {
    const dir = target(root, input.path, true);
    return { entries: fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.isSymbolicLink() && (e.isDirectory() || e.isFile()))
      .filter(e => { try { target(root, [...input.path.split("/").filter(Boolean), e.name].join("/"), e.isDirectory()); return true; } catch { return false; } })
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 300)
      .map(e => ({ name: e.name, directory: e.isDirectory() })) };
  }
  const before = read(root, input.path);
  if (method === "workspace.read") return { text: before.bytes.toString("utf8"), hash: before.hash };
  if (method !== "workspace.write" || typeof input.text !== "string" || Buffer.byteLength(input.text) > maxBytes || input.text.includes("\0") || input.hash !== before.hash) throw fail();
  const fd = fs.openSync(before.file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd), current = fs.statSync(before.file), bytes = fs.readFileSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== current.dev || stat.ino !== current.ino || sha(bytes) !== input.hash || target(root, input.path) !== before.file) throw fail();
    guard(); // Revocation and expiry are checked immediately before the write.
    const replacement = Buffer.from(input.text);
    let offset = 0;
    while (offset < replacement.length) offset += fs.writeSync(fd, replacement, offset, replacement.length - offset, offset);
    fs.ftruncateSync(fd, replacement.length); fs.fsyncSync(fd);
    return { hash: sha(replacement) };
  } finally { fs.closeSync(fd); }
}
