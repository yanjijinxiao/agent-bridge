import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PeerError } from "./rpc.js";
import { spawn } from "node:child_process";
import { ideHostCommand, runIDEHost } from "../ide/host-command.js";
import type { HostCommandResolver } from "../hosts/script-host.js";

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

// Reuse the exact same boundary checks on the selected host. No second remote
// text-editor implementation, and no caller-controlled executable or script.
function hostHelper(): string {
  return `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const __name=(fn)=>fn;class PeerError extends Error{};const maxBytes=${maxBytes};
const fail=${fail.toString()},sha=${sha.toString()};
${sharedDirectory.toString()}\n${target.toString()}\n${read.toString()}\n${sharedWorkspace.toString()}`;
}
export class SharedWorkspaceHost {
  constructor(private readonly hostId = "local", private readonly codexHome?: string, private readonly resolveHostCommand?: HostCommandResolver) {}
  directory(cwd: string): Promise<SharedDirectory> {
    return this.hostId === "local" ? Promise.resolve(sharedDirectory(cwd)) : runIDEHost(this.hostId,
      `${hostHelper()}\nconst input=JSON.parse(Buffer.from(process.argv[1],'base64').toString());process.stdout.write(JSON.stringify(sharedDirectory(input.cwd)));`, { cwd }, undefined, 30000, { codexHome: this.codexHome, resolveHostCommand: this.resolveHostCommand });
  }
  async workspace(root: SharedDirectory, method: string, input: { path: string; text?: string; hash?: string }, guard: () => void): Promise<unknown> {
    if (this.hostId === "local") return sharedWorkspace(root, method, input, guard);
    guard();
    const script = `${hostHelper()}
const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
const result=sharedWorkspace(input.root,input.method,input.input,()=>{
 process.stdout.write('READY\\n');const b=Buffer.alloc(1);if(fs.readSync(0,b,0,1,null)!==1||b[0]!==49)throw fail();
});process.stdout.write(JSON.stringify(result));`;
    const call = this.resolveHostCommand ? await this.resolveHostCommand(this.hostId, script, { root, method, input })
      : ideHostCommand(this.hostId, script, { root, method, input }, { codexHome: this.codexHome });
    guard();
    return new Promise((resolve, reject) => {
      const child = spawn(call.command, call.args, { stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.resume(); child.stdin.on("error", () => {});
      let output = "", ready = false, failure: unknown;
      const timer = setTimeout(() => { failure = fail(); child.kill("SIGKILL"); }, 30000);
      child.stdout.on("data", bytes => {
        output += String(bytes);
        if (Buffer.byteLength(output) > 1_000_000) { failure = fail(); child.kill("SIGKILL"); return; }
        while (output.startsWith("READY\n")) {
          ready = true; output = output.slice(6);
          try { guard(); child.stdin.write("1"); } catch (error) { failure = error; child.stdin.end(); }
        }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); try {
        if (failure) throw failure; if (code !== 0 || !ready) throw fail(); guard(); resolve(JSON.parse(output));
      } catch (error) { reject(error); } });
    });
  }
}
