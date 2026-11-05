import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { runIDEHost, uploadIDEHost } from "./host-command.js";

const exec = promisify(execFile);
export const CODE_SERVER_VERSION = "4.141.1";
export type IDEAsset = { version: string; name: string; directory: string; sha256: string; size: number; url: string };
// Pinned official GitHub release asset digest; unsupported platforms fail closed.
// Add a platform only together with its independently verified release checksum.
const ASSET_PINS: Record<string, { suffix: string; size: number; sha256: string }> = {
  "linux-x64": { suffix: "linux-amd64", size: 240_102_020, sha256: "45fd3cfbff9fd0c36fe37105859b0f4f7a0544341ca4e322657f5b3caeca1cbe" },
  "linux-arm64": { suffix: "linux-arm64", size: 234_750_384, sha256: "898903adc4d28dc23b9147073afe36fcafdb49e6ada8e1007bfc62a330ff9315" },
  "darwin-x64": { suffix: "macos-amd64", size: 231_229_260, sha256: "1e738afeacab655ca063d34c9b651f38a3328002a14a3bf0aa8fe16d41dd19ca" },
  "darwin-arm64": { suffix: "macos-arm64", size: 210_751_651, sha256: "49535c4c908a499814cc32774bdbb7f23ae42fa301384ab9cf81434915f4279d" }
};
export function codeServerAsset(platform: string, arch: string): IDEAsset {
  const pin = ASSET_PINS[`${platform}-${arch}`];
  if (!pin) throw new Error("自动安装暂支持 Linux x64 / ARM64、macOS Intel / Apple Silicon；其他平台请配置已安装的 code-server 绝对路径");
  const directory = `code-server-${CODE_SERVER_VERSION}-${pin.suffix}`, name = `${directory}.tar.gz`;
  return { version: CODE_SERVER_VERSION, directory, name, size: pin.size, sha256: pin.sha256,
    url: `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${name}` };
}
export type IDEInstallStatus = { hostId: string; phase: "checking" | "remote-download" | "gateway-download" | "transferring" | "verifying" | "ready" | "error";
  version: string; updatedAt: string; bytes?: number; total?: number; binary?: string; error?: string };
type Probe = { platform: string; arch: string; binary?: string; glibc?: string };
export interface IDEInstallerIO {
  probe(hostId: string, binary: string, signal: AbortSignal): Promise<Probe>;
  prepare(hostId: string, signal: AbortSignal): Promise<string>;
  remoteDownload(hostId: string, stage: string, asset: IDEAsset, signal: AbortSignal): Promise<void>;
  download(asset: IDEAsset, progress: (bytes: number) => void, signal: AbortSignal): Promise<string>;
  upload(hostId: string, stage: string, file: string, signal: AbortSignal): Promise<void>;
  activate(hostId: string, stage: string, asset: IDEAsset, signal: AbortSignal): Promise<string>;
}
export class IDEInstallPendingError extends Error { constructor() { super("code-server 正在自动安装；请在 Gateway Web IDE 页查看进度，准备完成后重新打开"); } }

/** Host-scoped background jobs, independent of Codex turns and IM queues.
 * Interrupted jobs are visible errors on restart, never silently replayed. */
export class CodeServerInstaller {
  private readonly states = new Map<string, IDEInstallStatus>();
  private readonly jobs = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private readonly io: IDEInstallerIO;
  private readonly file: string;
  constructor(root: string, private readonly options: { allowed: (hostId: string) => boolean; io?: IDEInstallerIO; codexHome?: string }) {
    this.file = path.join(root, "ide", "installations.json");
    this.io = options.io ?? new ProcessIDEInstallerIO(path.join(root, "ide", "downloads"), options.codexHome);
    try {
      for (const state of readJsonFile<IDEInstallStatus[]>(this.file, [])) {
        if (!state || typeof state.hostId !== "string") continue;
        this.states.set(state.hostId, state.phase === "ready" || state.phase === "error" ? state
          : { ...state, phase: "error", error: "上次安装被中断；缓存已保留，请重试" });
      }
    } catch { /* Optional journal corruption cannot affect IM. */ }
  }
  list(): IDEInstallStatus[] { return [...this.states.values()].map(value => ({ ...value })); }
  begin(hostId: string, binary = "code-server"): IDEInstallStatus {
    if (!this.options.allowed(hostId)) throw new Error("请先保存并启用该主机的自动安装授权");
    if (binary !== "code-server") throw new Error("自定义可执行文件不会被自动替换；自动安装请使用 code-server");
    if (this.jobs.has(hostId)) return { ...this.states.get(hostId)! };
    const controller = new AbortController(); this.update(hostId, "checking");
    const promise = this.install(hostId, binary, controller.signal).catch(error => {
      this.update(hostId, "error", { error: controller.signal.aborted ? "安装已取消；缓存保留，可重试"
        : error instanceof InstallerCompatibilityError ? error.message : "安装失败；请检查 SSH、官方制品下载及主机兼容性。缓存保留，可重试。" });
    }).finally(() => { this.jobs.delete(hostId); });
    this.jobs.set(hostId, { controller, promise }); return { ...this.states.get(hostId)! };
  }
  async wait(hostId: string): Promise<IDEInstallStatus | undefined> { await this.jobs.get(hostId)?.promise; return this.states.get(hostId); }
  /** Discover the host's existing managed installation without requesting an
   * install, changing authorization, or replaying an interrupted install job. */
  async existingBinary(hostId: string): Promise<string | undefined> {
    const state = this.states.get(hostId);
    const probe = await this.io.probe(hostId, state?.phase === "ready" && state.binary ? state.binary : "code-server", new AbortController().signal);
    return probe.binary;
  }
  async binary(hostId: string): Promise<string> {
    const state = this.states.get(hostId);
    if (state?.phase === "ready" && state.binary) {
      const probe = await this.io.probe(hostId, state.binary, new AbortController().signal);
      if (probe.binary) return probe.binary;
    }
    if (state?.phase === "error") throw new Error(state.error);
    this.begin(hostId); throw new IDEInstallPendingError();
  }
  async cancelHosts(hosts: ReadonlySet<string>): Promise<void> {
    const jobs = [...this.jobs].filter(([hostId]) => hosts.has(hostId)).map(([, job]) => job);
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.promise));
  }
  async close(): Promise<void> { await this.cancelHosts(new Set(this.jobs.keys())); }
  private check(hostId: string, signal: AbortSignal) {
    signal.throwIfAborted(); if (!this.options.allowed(hostId)) throw new Error("安装授权已撤销");
  }
  private async install(hostId: string, binary: string, signal: AbortSignal): Promise<void> {
    const probe = await this.io.probe(hostId, binary, signal); this.check(hostId, signal);
    if (probe.binary) { this.update(hostId, "ready", { binary: probe.binary }); return; }
    let asset: IDEAsset;
    try { asset = codeServerAsset(probe.platform, probe.arch); } catch (e) { throw new InstallerCompatibilityError((e as Error).message); }
    if (probe.platform === "linux" && (!probe.glibc || compareVersion(probe.glibc, "2.28") < 0)) throw new InstallerCompatibilityError("主机需要 glibc ≥ 2.28；不会自动修改系统运行库");
    const stage = await this.io.prepare(hostId, signal); this.check(hostId, signal);
    try { this.update(hostId, "remote-download", { total: asset.size }); await this.io.remoteDownload(hostId, stage, asset, signal); }
    catch {
      this.check(hostId, signal); this.update(hostId, "gateway-download", { total: asset.size });
      const file = await this.io.download(asset, bytes => this.update(hostId, "gateway-download", { bytes, total: asset.size }), signal);
      this.check(hostId, signal); this.update(hostId, "transferring", { bytes: asset.size, total: asset.size });
      await this.io.upload(hostId, stage, file, signal);
    }
    this.check(hostId, signal); this.update(hostId, "verifying");
    const installed = await this.io.activate(hostId, stage, asset, signal); this.check(hostId, signal);
    this.update(hostId, "ready", { binary: installed, bytes: asset.size, total: asset.size });
  }
  private update(hostId: string, phase: IDEInstallStatus["phase"], fields: Partial<IDEInstallStatus> = {}): void {
    const prior = this.states.get(hostId);
    this.states.set(hostId, { hostId, phase, version: CODE_SERVER_VERSION, updatedAt: new Date().toISOString(),
      ...(phase === "checking" ? {} : { bytes: prior?.bytes, total: prior?.total }), ...fields });
    try { writeJsonFile(this.file, this.list()); fs.chmodSync(this.file, 0o600); } catch { /* Progress is best effort. */ }
  }
}
class InstallerCompatibilityError extends Error {}
function compareVersion(a: string, b: string): number { const av=a.split(".").map(Number),bv=b.split(".").map(Number); return (av[0]-bv[0]) || ((av[1]||0)-(bv[1]||0)); }

// Variable values are base64 JSON passed to fixed Node code, never shell text.
const HOST = String.raw`
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
const root=path.join(os.homedir(),'.local','share','codex-im-gateway','tools','code-server');
const version=input.version,pin=input.pins[process.platform+'-'+process.arch];
const dir=pin?'code-server-'+version+'-'+pin.suffix:undefined,final=dir?path.join(root,dir):undefined,bin=final?path.join(final,'bin','code-server'):undefined;
const run=(file,args,timeout=20000)=>new Promise((resolve,reject)=>cp.execFile(file,args,{timeout,maxBuffer:16*1024*1024},(e,out)=>e?reject(e):resolve(out)));
// code-server reads/writes its YAML configuration even for --version. A probe
// must not inherit a user's broken/read-only config or create credentials in it.
const valid=async binary=>{let probe;try{
 probe=fs.mkdtempSync(path.join(os.tmpdir(),'cig-ide-version-'));
 const config=path.join(probe,'config.yaml');fs.writeFileSync(config,'{}\n',{mode:0o600});
 const output=String(await run(binary,['--config',config,'--user-data-dir',path.join(probe,'data'),'--extensions-dir',path.join(probe,'extensions'),'--version']));
 return output.split(/\r?\n/).some(line=>line.trim().split(/\s+/)[0]===version);
}catch{return false;}finally{if(probe)fs.rmSync(probe,{recursive:true,force:true});}};
const answer=value=>process.stdout.write(JSON.stringify(value));
const safeStage=()=>{if(typeof input.stage!=='string'||path.dirname(input.stage)!==root||!path.basename(input.stage).startsWith('.stage-')||fs.lstatSync(input.stage).isSymbolicLink())throw Error('Invalid stage');};
const sha=async file=>{const h=crypto.createHash('sha256');for await(const data of fs.createReadStream(file))h.update(data);return h.digest('hex');};
(async()=>{
 if(input.op==='probe'){
   const requested=input.binary; let existing;
   if(requested==='code-server') {if(bin&&await valid(bin))existing=bin;else if(await valid(requested))existing=requested;}
   else if(await valid(requested))existing=requested;
   answer({platform:process.platform,arch:process.arch,binary:existing,glibc:process.report?.getReport().header.glibcVersionRuntime});return;
 }
 if(!pin)throw Error('Unsupported platform');
 fs.mkdirSync(root,{recursive:true,mode:0o700});if(fs.lstatSync(root).isSymbolicLink())throw Error('Invalid tool root');fs.chmodSync(root,0o700);
 if(input.op==='prepare'){answer(fs.mkdtempSync(path.join(root,'.stage-')));return;}
 safeStage();const archive=path.join(input.stage,'release.tar.gz');
 if(input.op==='download'){await run('curl',['--fail','--location','--proto','=https','--proto-redir','=https','--connect-timeout','10','--max-time','45','--output',archive,input.asset.url],55000);answer({ok:true});return;}
 if(input.op==='upload'){const stream=fs.createWriteStream(archive,{mode:0o600,flags:'w'});let size=0;process.stdin.on('data',chunk=>{size+=chunk.length;if(size>pin.size)process.exit(1);});process.stdin.pipe(stream);await new Promise((resolve,reject)=>{stream.on('finish',resolve);stream.on('error',reject);});answer({ok:true});return;}
 if(input.op==='activate'){
   if(await valid(bin)){answer(bin);return;}
   if(input.asset.directory!==dir||input.asset.size!==pin.size||input.asset.sha256!==pin.sha256)throw Error('Platform asset mismatch');
   if(fs.statSync(archive).size!==pin.size||await sha(archive)!==pin.sha256)throw Error('Checksum mismatch');
   const listing=String(await run('tar',['-tzf',archive],60000)).split('\n').filter(Boolean);
   if(!listing.length||listing.some(p=>p.startsWith('/')||p.split('/').includes('..')||p.split('/')[0]!==dir))throw Error('Unsafe archive');
   const lock=path.join(root,'.activate-lock');fs.mkdirSync(lock,{mode:0o700});
   try{if(await valid(bin)){answer(bin);return;}await run('tar',['-xzf',archive,'-C',input.stage],120000);
     const staged=path.join(input.stage,dir);if(!await valid(path.join(staged,'bin','code-server')))throw Error('Version/ABI check failed');
     if(fs.existsSync(final))throw Error('Existing managed version is not usable; not overwritten');
     fs.renameSync(staged,final);answer(bin);
   }finally{fs.rmdirSync(lock);}return;
 }
 throw Error('Unknown operation');
})().catch(()=>{process.stderr.write('IDE tool preparation failed\n');process.exitCode=1;});
`;
const assetDownloads = new Map<string, Promise<string>>();
export class ProcessIDEInstallerIO implements IDEInstallerIO {
  constructor(private readonly cache: string, private readonly codexHome?: string) {}
  private input(value: object) { return { ...value, version: CODE_SERVER_VERSION, pins: ASSET_PINS }; }
  probe(hostId: string, binary: string, signal: AbortSignal) { return runIDEHost<Probe>(hostId, HOST, this.input({ op: "probe", binary }), signal, 50_000, { codexHome: this.codexHome }); }
  prepare(hostId: string, signal: AbortSignal) { return runIDEHost<string>(hostId, HOST, this.input({ op: "prepare" }), signal, 30_000, { codexHome: this.codexHome }); }
  async remoteDownload(hostId: string, stage: string, asset: IDEAsset, signal: AbortSignal) { await runIDEHost(hostId, HOST, this.input({ op: "download", stage, asset }), signal, 60_000, { codexHome: this.codexHome }); }
  async download(asset: IDEAsset, progress: (bytes: number) => void, signal: AbortSignal): Promise<string> {
    fs.mkdirSync(this.cache, { recursive: true, mode: 0o700 }); fs.chmodSync(this.cache, 0o700);
    const key = path.join(fs.realpathSync(this.cache), asset.name);
    const previous = assetDownloads.get(key) ?? Promise.resolve("");
    const pending = previous.catch(() => "").then(() => {
      signal.throwIfAborted();
      return this.downloadExclusive(asset, progress, signal);
    });
    assetDownloads.set(key, pending);
    try { return await pending; }
    finally { if (assetDownloads.get(key) === pending) assetDownloads.delete(key); }
  }
  private async downloadExclusive(asset: IDEAsset, progress: (bytes: number) => void, signal: AbortSignal): Promise<string> {
    const file = path.join(this.cache, asset.name);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("缓存不能是符号链接");
    if (await verified(file, asset)) { progress(asset.size); return file; }
    if (fs.existsSync(file) && fs.statSync(file).size >= asset.size) fs.renameSync(file, file + ".rejected-" + crypto.randomBytes(6).toString("hex"));
    const timer = setInterval(() => { try { progress(fs.statSync(file).size); } catch {} }, 2000); timer.unref();
    try {
      await exec("curl", ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--continue-at", "-",
        "--retry", "2", "--retry-delay", "1", "--connect-timeout", "15", "--max-time", "600", "--output", file, asset.url],
        { signal, timeout: 650_000, maxBuffer: 1_000_000, windowsHide: true });
      if (!await verified(file, asset)) throw new Error("官方制品校验失败"); return file;
    } finally { clearInterval(timer); }
  }
  upload(hostId: string, stage: string, file: string, signal: AbortSignal) { return uploadIDEHost(hostId, HOST, this.input({ op: "upload", stage }), file, signal, { codexHome: this.codexHome }); }
  activate(hostId: string, stage: string, asset: IDEAsset, signal: AbortSignal) { return runIDEHost<string>(hostId, HOST, this.input({ op: "activate", stage, asset }), signal, 180_000, { codexHome: this.codexHome }); }
}
async function verified(file: string, asset: IDEAsset): Promise<boolean> {
  try { if (fs.statSync(file).size !== asset.size) return false;
    const hash = crypto.createHash("sha256"); for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === asset.sha256;
  } catch { return false; }
}
