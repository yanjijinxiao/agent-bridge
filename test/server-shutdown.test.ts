import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { defaultConfig, saveConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { trackHTTPShutdown } from "../src/server/http-shutdown.js";

for (const mode of ["headers", "body", "upgrade"] as const) test(`HTTP shutdown retires a stalled ${mode} connection`, { timeout: 2000 }, async t => {
  const server = http.createServer(request => request.resume()), close = trackHTTPShutdown(server, 50);
  server.on("upgrade", (_request, socket) => socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const socket = net.createConnection((server.address() as net.AddressInfo).port, "127.0.0.1");
  socket.on("error", () => {}); socket.resume();
  t.after(async () => { socket.destroy(); await close(); });
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write(mode === "headers" ? "GET / HTTP/1.1\r\nHost: localhost\r\n" : mode === "body"
    ? "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx"
    : "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
  await new Promise(resolve => setTimeout(resolve, 25));
  const work = close(); assert.equal(close(), work, "repeated shutdown reuses the same cleanup");
  await work;
  assert.equal(server.listening, false);
});

test("HTTP shutdown lets a normal in-flight response drain before closing", { timeout: 2000 }, async t => {
  let complete!: () => void, entered!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const server = http.createServer((_request, response) => { complete = () => response.end("saved-once"); entered(); });
  const close = trackHTTPShutdown(server, 500);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(close);
  const response = fetch(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  await requested; const closing = close(); complete();
  assert.equal(await (await response).text(), "saved-once"); await closing;
});

test("SIGTERM exits the real Gateway with an unfinished HTTP request without stopping an independent executor", { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-shutdown-")), paths = resolveStatePaths(path.join(root, "state"));
  saveConfig(paths, { ...defaultConfig(root), taskboardEnabled: false });
  // This stand-in owns its lifetime just as the separately supervised native
  // service does. The Gateway must never signal it when retiring HTTP ingress.
  const executor = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, CODEX_HOME: path.join(root, "codex"),
      CODEX_IM_GATEWAY_STATE_DIR: paths.root, CODEX_IM_GATEWAY_PORT: "0", CODEX_IM_GATEWAY_OPEN: "0", CODEX_IM_GATEWAY_PEER_CONFIG: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  let socket: net.Socket | undefined;
  t.after(async () => {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    executor.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 7000;
  const ready = () => output.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .find(record => record.event === "runtime.ready" && record.surface === "management");
  while (!ready() && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 25));
  const record = ready(); assert.ok(record, output);
  assert.equal(record.schemaVersion, 1); assert.equal(record.runtime.component, "gateway");
  assert.equal(record.runtime.pid, child.pid); assert.ok(record.port > 0);
  socket = net.createConnection(record.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
  // An incomplete header is an accepted connection but has no request callback
  // yet. server.closeIdleConnections() alone cannot retire it.
  socket.write("GET /api/build HTTP/1.1\r\nHost: localhost\r\n");
  await new Promise(resolve => setTimeout(resolve, 50));
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([exited, new Promise<undefined>(resolve => { timer = setTimeout(resolve, 6500); })]);
  clearTimeout(timer);
  assert.ok(result, `Gateway did not finish shutdown:\n${output}`);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(fs.existsSync(path.join(paths.root, "service.lock")), false);
  assert.equal(executor.exitCode, null); assert.equal(executor.signalCode, null);
});
