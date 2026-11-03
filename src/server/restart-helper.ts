import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { activateNpmRelease, confirmNpmRelease, rollbackNpmRelease, readNpmRelease } from "./npm-release.js";

const [parentPidValue, entryPathValue, logPathValue, releasePlan, portValue] = process.argv.slice(2);
const parentPid = Number(parentPidValue);
const entryPath = path.resolve(entryPathValue || "");
const logPath = path.resolve(logPathValue || path.join(path.dirname(entryPath), "service-restart.log"));

if (!Number.isInteger(parentPid) || parentPid <= 0 || !entryPathValue || !fs.existsSync(entryPath)) {
  appendLog("Invalid restart-helper arguments");
  process.exitCode = 1;
} else {
  try {
    appendLog(`Waiting for service process ${parentPid} to exit`);
    await waitForProcessExit(parentPid, 60_000);
    await delay(400);
    if (releasePlan) {
      const port = Number(portValue);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid update health port");
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const plan = activateNpmRelease(releasePlan);
        child = await startService();
        await waitForVersion(port, plan.version, child);
        confirmNpmRelease(releasePlan);
        appendLog(`Verified npm runtime ${plan.version}`);
        child.unref();
      } catch (error) {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill();
          await waitForProcessExit(child.pid!, 10000);
        }
        rollbackNpmRelease(releasePlan);
        const previous = readNpmRelease(releasePlan).previousVersion;
        const restored = await startService();
        try { await waitForVersion(port, previous, restored); }
        finally { restored.unref(); }
        appendLog(`Update failed; restored npm runtime ${previous}`);
        throw error;
      }
    } else (await startService()).unref();
  } catch (error) {
    appendLog(`Restart failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function startService(): Promise<ReturnType<typeof spawn>> {
  const logFd = fs.openSync(logPath, "a");
  let child;
  try {
    child = spawn(process.execPath, [entryPath], {
      cwd: path.dirname(entryPath), detached: true, env: process.env, shell: false,
      stdio: ["ignore", logFd, logFd], windowsHide: true
    });
  } finally { fs.closeSync(logFd); }
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  appendLog(`Started service process ${child.pid ?? "unknown"}`);
  return child;
}

async function waitForVersion(port: number, version: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Updated service exited before health confirmation");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/build`, { signal: AbortSignal.timeout(1000), redirect: "error" });
      const text = await response.text();
      if (text.length <= 16384 && response.ok) {
        const value = JSON.parse(text);
        // A different process on the same port is not this release's receipt.
        if (value.product === "codex-im-gateway" && value.version === version && value.pid === child.pid) return;
      }
    } catch { /* The owned new process may still be opening its listener. */ }
    await delay(200);
  }
  throw new Error("Updated service did not confirm the expected version");
}

function appendLog(message: string): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // The helper must still attempt the restart when diagnostics cannot be written.
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for codex-im-gateway to stop");
    }
    await delay(200);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
