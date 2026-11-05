import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import { resolveRemoteSshConnection, type RemoteCodexTransportOptions } from "../codex/remote-host.js";

const exec = promisify(execFile);
export function ideSshConnection(hostId: string, options: RemoteCodexTransportOptions = {}) {
  const ssh = resolveRemoteSshConnection(hostId, options);
  return { ...ssh, args: [...ssh.args, "-o", "ControlMaster=no", "-o", "ControlPath=none"] };
}
export function ideHostCommand(hostId: string, script: string, input: object, options: RemoteCodexTransportOptions = {}) {
  const data = Buffer.from(JSON.stringify(input)).toString("base64");
  if (hostId === "local") return { command: process.execPath, args: ["-e", script, data] };
  const ssh = ideSshConnection(hostId, options), code = Buffer.from(script).toString("base64");
  return { command: ssh.command, args: [...ssh.args, ssh.target,
    `exec node -e "eval(Buffer.from('${code}','base64').toString())" '${data}'`] };
}
export async function runIDEHost<T>(hostId: string, script: string, input: object, signal?: AbortSignal, timeout = 30_000, options: RemoteCodexTransportOptions = {}): Promise<T> {
  const call = ideHostCommand(hostId, script, input, options);
  const { stdout } = await exec(call.command, call.args, { timeout, signal, maxBuffer: 1_000_000, windowsHide: true });
  return JSON.parse(stdout) as T;
}
export async function uploadIDEHost(hostId: string, script: string, input: object, file: string, signal: AbortSignal, options: RemoteCodexTransportOptions = {}): Promise<void> {
  const call = ideHostCommand(hostId, script, input, options);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(call.command, call.args, { signal, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    const source = fs.createReadStream(file); child.stderr.resume();
    let settled = false, copied = false, exited = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // This child belongs to the artifact transfer, not to the independent
      // Codex executor. A failed local read must not leave SSH awaiting stdin.
      source.destroy(); child.stdin.destroy(); child.kill("SIGTERM");
      reject(error);
    };
    const complete = () => {
      if (settled || !copied || !exited) return;
      settled = true; clearTimeout(timer); resolve();
    };
    // Official archives are about 240 MB. Keep a bounded total deadline sized
    // for artifact transport; cancellation still destroys both streams now.
    const timer = setTimeout(() => fail(new Error("SSH 制品传输超时，可重试")), 600_000);
    // An aborted spawn can emit another error if cleanup races the exit.
    // Keep the listener until close; fail itself is idempotent.
    child.on("error", fail);
    child.once("close", code => {
      if (code !== 0) { fail(new Error("SSH 制品传输失败，可重试")); return; }
      exited = true; complete();
    });
    pipeline(source, child.stdin, error => {
      if (error) { fail(error); return; }
      copied = true; complete();
    });
  });
}
