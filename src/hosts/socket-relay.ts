import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { HostCommandResolver } from "./script-host.js";

// Raw socket bytes use pipes, never a PTY or terminal.screen. This supports
// HTTP upgrades/WebSocket and binary IDE payloads through the same configured
// reach command as file helpers (including Herdr's --via transports).
const RELAY = String.raw`
const net=require('node:net');const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
const socket=net.createConnection({path:input.socket,allowHalfOpen:true});
const timer=setTimeout(()=>{socket.destroy();process.exitCode=1;},10000);
socket.on('connect',()=>{clearTimeout(timer);process.stdin.pipe(socket);socket.pipe(process.stdout);});
socket.on('error',()=>{clearTimeout(timer);process.stdin.destroy();process.exitCode=1;});
socket.on('close',()=>{clearTimeout(timer);process.stdin.destroy();});
process.stdout.on('error',()=>socket.destroy());process.stdin.on('error',()=>socket.destroy());
process.on('SIGTERM',()=>{socket.destroy();process.stdin.destroy();});
`;

/** Private local listener, whose every connection is separately authorized by
 * the host resolver. Closing it owns only relay children, never the agent. */
export async function openHostSocketRelay(hostId: string, remoteSocket: string, resolve: HostCommandResolver) {
  if (!path.posix.isAbsolute(remoteSocket) || /[\r\n\0]/.test(remoteSocket)) throw Error("Invalid remote IDE socket");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ab-relay-")); fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, "ide.sock"), sockets = new Set<net.Socket>(), children = new Set<ChildProcess>();
  let closed = false, stopping: Promise<void> | undefined;
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on("error", () => socket.destroy()); socket.once("close", () => sockets.delete(socket));
    void (async () => {
      const call = await resolve(hostId, RELAY, { socket: remoteSocket });
      if (closed || socket.destroyed) { socket.destroy(); return; }
      const child = spawn(call.command, call.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      children.add(child); child.stderr.resume();
      child.stdin.on("error", () => socket.destroy()); child.stdout.on("error", () => socket.destroy());
      child.on("error", () => socket.destroy());
      // A successful helper may exit while bytes are still buffered for the
      // browser. end() drains them; destroy() would truncate large IDE frames.
      child.once("close", code => { children.delete(child); if (code === 0) socket.end(); else socket.destroy(); });
      socket.once("close", () => { child.stdin.destroy(); child.kill("SIGTERM"); });
      socket.pipe(child.stdin); child.stdout.pipe(socket);
    })().catch(() => socket.destroy());
  });
  server.maxConnections = 32;
  try { await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(socketPath, () => { server.off("error", fail); ok(); }); }); }
  catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  server.on("error", () => { closed = true; for (const socket of sockets) socket.destroy(); });
  const stop = () => stopping ??= (async () => {
      closed = true; for (const socket of sockets) socket.destroy();
      await Promise.all([...children].map(child => new Promise<void>(done => {
        if (child.exitCode !== null || child.signalCode) { done(); return; }
        const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 3000);
        child.once("close", () => { clearTimeout(timer); done(); }); child.kill("SIGTERM");
      })));
      try { await new Promise<void>(done => server.close(() => done())); }
      finally { fs.rmSync(directory, { recursive: true, force: true }); }
    })();
  return { socketPath, alive: () => !closed && server.listening, stop };
}
