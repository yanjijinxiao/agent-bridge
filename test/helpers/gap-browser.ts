import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { TestContext } from "node:test";

export async function eventually<T>(read: () => T | Promise<T>, message: string): Promise<NonNullable<T>> {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = await read(); if (value) return value as NonNullable<T>; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error(message);
}

/** A disposable Chrome profile and a page CDP connection; no user's browser. */
export async function isolatedBrowser(t: TestContext, root: string, options: { commandTimeoutMs?: number } = {}) {
  const profile = path.join(root, "chrome");
  const child = spawn(process.env.CODEX_CHROME_TEST_BIN!, ["--headless=new", "--no-first-run", "--disable-sync", "--disable-extensions",
    "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    socket?.close();
    if (child.exitCode === null && !child.signalCode) await new Promise<void>(resolve => {
      child.once("exit", () => resolve()); child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000); timer.unref(); child.once("exit", () => clearTimeout(timer));
    });
  })();
  t.after(close);
  const port = await eventually(() => { try { return Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { return 0; } }, "Chrome did not start");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", reject, { once: true }); });
  let id = 0; const pending = new Map<number, { resolve(value: any): void; reject(reason: unknown): void; timer: NodeJS.Timeout }>();
  const listeners = new Set<(method: string, params: any) => void>();
  socket.addEventListener("message", event => { const value = JSON.parse(String(event.data));
    if (value.method) for (const listener of listeners) listener(value.method, value.params);
    const entry = pending.get(value.id); if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer); value.error ? entry.reject(Error(JSON.stringify(value.error))) : entry.resolve(value.result); });
  const call = (method: string, params = {}) => new Promise<any>((resolve, reject) => { const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(Error(`CDP deadline: ${method}`)); }, options.commandTimeoutMs ?? 10000);
    pending.set(current, { resolve, reject, timer }); socket!.send(JSON.stringify({ id: current, method, params })); });
  await call("Runtime.enable"); await call("Page.enable");
  const evaluate = async <T = any>(expression: string): Promise<T> => { const value = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text); return value.result?.value; };
  return { call, evaluate, close, onEvent(listener: (method: string, params: any) => void) { listeners.add(listener); return () => listeners.delete(listener); } };
}
