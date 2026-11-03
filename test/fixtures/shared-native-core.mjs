import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { APP_SERVER_SOCKET_RELAY } from "../../src/codex/app-server-socket-relay.ts";
import { AppServerCodexRunner } from "../../src/codex/app-server-runner.ts";

export const message = (text, n = 0) => ({ type: "message", id: `msg_${n}`, role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }] });
export const tool = (name, args, n = 0) => ({ type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args) });
export const until = async (predicate, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= deadline) throw Error("Isolated native condition timed out"); await new Promise(r => setTimeout(r, 20)); }
};

/** One test-owned native process, a fresh home and a localhost fake model.
 * No account credentials, external inference or real Desktop sessions. */
export async function sharedNativeCore(t, respond = (_body, n) => message(`DONE_${n}`, n)) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-shared-native-")));
  const endpoint = path.join(root, "core.sock"), closers = [], children = [];
  const calls = []; let core;
  const model = http.createServer((request, response) => {
    let body = ""; request.on("data", b => { body += b; });
    request.on("end", async () => {
      try {
        const parsed = JSON.parse(body); calls.push(parsed);
        const item = await respond(parsed, calls.length);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const emit = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        emit("response.created", { response: { id: `resp_${calls.length}`, status: "in_progress", output: [] } });
        emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
        emit("response.output_item.done", { output_index: 0, item });
        emit("response.completed", { response: { id: `resp_${calls.length}`, status: "completed", output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); response.end();
      } catch { response.writeHead(500); response.end(); }
    });
  });
  t.after(async () => {
    await Promise.allSettled(closers.map(close => close()));
    for (const child of children) child.kill();
    if (core) {
      const ended = new Promise(resolve => { if (core.exitCode !== null) resolve(); else core.once("exit", resolve); });
      try { process.kill(-core.pid, "SIGTERM"); } catch {}
      await Promise.race([ended, new Promise(r => setTimeout(r, 2000))]);
      if (core.exitCode === null) try { process.kill(-core.pid, "SIGKILL"); } catch {}
    }
    model.closeAllConnections(); await new Promise(r => model.close(r));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(root, "config.toml"), [
    'model_provider="gateway_mock"', 'model="mock-model"', '[model_providers.gateway_mock]',
    'name="Local isolated shared-core test"', `base_url="http://127.0.0.1:${model.address().port}/v1"`,
    'wire_api="responses"', 'requires_openai_auth=false'
  ].join("\n"));
  core = spawn(process.env.CODEX_NATIVE_QUEUE_TEST_BIN, ["app-server", "--listen", `unix://${endpoint}`], {
    env: { ...process.env, CODEX_HOME: root }, detached: true, stdio: ["ignore", "ignore", "pipe"]
  });
  core.stderr.resume(); await until(() => fs.existsSync(endpoint));
  const transport = mode => ({ command: process.execPath, args: ["-e", APP_SERVER_SOCKET_RELAY, endpoint], mode });
  const runner = (options = {}) => {
    const value = new AppServerCodexRunner({ codexHome: root, catalogSource: "native", requestTimeoutMs: 5000,
      transport: transport("daemon-proxy"), ...options }); closers.push(() => value.close()); return value;
  };
  const rpc = async name => {
    const child = spawn(process.execPath, ["-e", APP_SERVER_SOCKET_RELAY, endpoint], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child); child.stderr.resume(); let nextId = 1;
    const pending = new Map(), events = [], requests = [], methods = [];
    const send = value => child.stdin.write(JSON.stringify(value) + "\n");
    readline.createInterface({ input: child.stdout }).on("line", line => {
      const m = JSON.parse(line);
      if (m.method && m.id !== undefined) { requests.push(m); return; }
      if (m.method) { events.push(m); return; }
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer);
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
    child.on("exit", () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error("Isolated native client exited")); } pending.clear(); });
    const request = (method, params = {}) => {
      const id = nextId++; methods.push(method);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error(`Isolated RPC timeout ${method}`)); }, 8000);
        pending.set(id, { resolve, reject, timer }); send({ id, method, params });
      });
    };
    await request("initialize", { clientInfo: { name: `gateway_isolated_${name}`, version: "1" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized" }); return { request, send, events, requests, methods, close: () => child.kill() };
  };
  return { root, endpoint, calls, transport, runner, rpc };
}
