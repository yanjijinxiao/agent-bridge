import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppServerTransport } from "./app-server-transport.js";
import type { HostInvocation } from "../hosts/script-host.js";

export type OutputFileLease = { readonly path: string; dispose(): Promise<void> };
export type FetchOutputFile = (remotePath: string, options: {
  readonly hostId: string; readonly maxBytes: number; readonly directory?: string;
  /** Required by delegated device transports; ignored by SSH transports. */
  readonly accountId?: string; readonly conversationId?: string; readonly threadId?: string;
  readonly allowedRoots?: readonly string[];
}) => Promise<OutputFileLease>;

/** A read-only port on the selected execution host. Paths arrive over stdin,
 * never in a shell command. Refuse symlinks, devices and changing/oversized files. */
export const OUTPUT_FILE_SENDER = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk;if(Buffer.byteLength(input)>16384)process.exit(2)});
process.stdin.on('end',()=>{try{
 const h=JSON.parse(input);
 if(typeof h.path!=='string'||!h.path.startsWith('/')||h.path.includes('\0')||h.path.length>4096
 ||!Number.isSafeInteger(h.maxBytes)||h.maxBytes<1||h.maxBytes>100*1024*1024)throw Error();
 if(h.allowedRoots){const actual=fs.realpathSync(h.path);if(!h.allowedRoots.some(root=>{try{
   const base=fs.realpathSync(root),relative=path.relative(base,actual);
   return relative===''||relative!=='..'&&!relative.startsWith('../')&&!path.isAbsolute(relative);
 }catch{return false;}}))throw Error('Outside selected workspace');}
 const fd=fs.openSync(h.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 let body;
 try{
  const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>h.maxBytes)throw Error();
  const bytes=Buffer.alloc(stat.size+1);let size=0,n=0;
  do{n=fs.readSync(fd,bytes,size,bytes.length-size,size);size+=n}while(n&&size<bytes.length);
  const after=fs.fstatSync(fd);
  if(size!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw Error();
  body=bytes.subarray(0,size);
 }finally{fs.closeSync(fd)}
 process.stdout.write(JSON.stringify({size:body.length,hash:crypto.createHash('sha256').update(body).digest('hex')})+'\n');
 process.stdout.write(body);
}catch{process.stderr.write('remote output read failed');process.exitCode=1}});
`;

export async function fetchRemoteOutputFile(remotePath: string, options: {
  readonly maxBytes: number; readonly directory?: string; readonly timeoutMs?: number; readonly allowedRoots?: readonly string[];
}, transport: AppServerTransport): Promise<OutputFileLease> {
  if (transport.mode !== "remote-daemon" || !transport.args?.length || !/(?:^|\/)ssh$/.test(transport.command)) {
    throw new Error("远程执行器没有文件回传端口");
  }
  const encoded = Buffer.from(OUTPUT_FILE_SENDER).toString("base64");
  const args = [...transport.args.slice(0, -1), `exec node -e "eval(Buffer.from('${encoded}','base64').toString())"`];
  return fetchOutputUsingCommand(remotePath, options, async () => ({ command: transport.command, args }));
}

/** Read-only fixed helper shared by native SSH and resource-owned hosts. */
export async function fetchOutputUsingCommand(remotePath: string, options: {
  readonly maxBytes: number; readonly directory?: string; readonly timeoutMs?: number; readonly allowedRoots?: readonly string[];
}, command: () => Promise<HostInvocation>, assertCurrent?: () => void): Promise<OutputFileLease> {
  if (!path.posix.isAbsolute(remotePath) || remotePath.includes("\0") || remotePath.length > 4096
    || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error("远程文件路径或大小限制无效");
  const maxBytes = Math.min(options.maxBytes, 100 * 1024 * 1024);
  const call = await command();
  const output = await new Promise<Buffer>((resolve, reject) => {
    assertCurrent?.();
    const child = spawn(call.command, call.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = []; let size = 0, excessive = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes + 8192) { excessive = true; child.kill("SIGKILL"); }
      else chunks.push(chunk);
    });
    child.stderr.resume(); // Do not expose SSH diagnostics or provider credentials.
    child.stdin.on("error", () => undefined);
    child.once("error", () => { clearTimeout(timer); reject(new Error("远程文件传输连接失败")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0 || excessive || timedOut) reject(new Error(timedOut ? "远程文件回传超时" : "远程文件读取失败或超过大小限制"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(JSON.stringify({ path: remotePath, maxBytes, allowedRoots: options.allowedRoots }));
  });
  const newline = output.indexOf(10);
  if (newline < 0 || newline > 8192) throw new Error("远程文件回传头无效");
  const header = JSON.parse(output.subarray(0, newline).toString("utf8")) as { size?: unknown; hash?: unknown };
  const body = output.subarray(newline + 1);
  if (header.size !== body.length || body.length > maxBytes
    || header.hash !== crypto.createHash("sha256").update(body).digest("hex")) throw new Error("远程文件回传校验失败");
  const base = options.directory ?? os.tmpdir();
  await fs.promises.mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await fs.promises.mkdtemp(path.join(base, "output-"));
  const file = path.join(directory, path.posix.basename(remotePath));
  try { await fs.promises.writeFile(file, body, { flag: "wx", mode: 0o600 }); }
  catch (error) { await fs.promises.rm(directory, { recursive: true, force: true }); throw error; }
  return { path: file, dispose: () => fs.promises.rm(directory, { recursive: true, force: true }) };
}
