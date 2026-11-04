import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { IDETLSManager } from "../src/ide/tls.js";
// Deployment script uses the same Node runtime without a compiler.
// @ts-expect-error JavaScript deployment helper
import { createPeerIDEFront } from "../scripts/peer-ide-tls-front.mjs";

test("fixed TLS entrance routes IDE HTTP and both WebSockets without exposing management", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cig-ide-front-")), authority = new IDETLSManager(root), tls = await authority.prepare("127.0.0.1");
  const servers: http.Server[] = [], clients: WebSocket[] = [];
  const listen = async (server: http.Server) => { servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); return (server.address() as AddressInfo).port; };
  const upstream = (name: string) => {
    const server = http.createServer((req, res) => { res.setHeader("Set-Cookie", ["first=1", "second=2"]); res.end(JSON.stringify({ name, path: req.url, method: req.method, host: req.headers.host, cookie: req.headers.cookie })); });
    const ws = new WebSocketServer({ noServer: true }); server.on("upgrade", (req, socket, head) => ws.handleUpgrade(req, socket, head, peer => {
      peer.on("message", bytes => peer.send(name + ":" + bytes.toString()));
    })); return server;
  };
  const peerPort = await listen(upstream("peer")), idePort = await listen(upstream("ide"));
  const front = createPeerIDEFront({ key: fs.readFileSync(tls.keyFile), cert: fs.readFileSync(tls.certFile), peerPort, idePort });
  const port = await listen(front), origin = `https://127.0.0.1:${port}`, ca = authority.caCertificate();
  t.after(async () => { for (const ws of clients) ws.terminate(); for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } fs.rmSync(root, { recursive: true, force: true }); });
  const request = (url: string, method = "GET") => new Promise<{ status: number; body: string; cookies: string[] | undefined }>((resolve, reject) => {
    const req = https.request(origin + url, { ca, agent: false, method, headers: { Cookie: "browser=secret" } }, res => { let body = ""; res.on("data", b => body += b); res.on("end", () => resolve({ status: res.statusCode!, body, cookies: res.headers["set-cookie"] })); }); req.on("error", reject); req.end();
  });
  const id = "a".repeat(32);
  for (const [url, method] of [[`/workspace/${id}`, "GET"], [`/open/${id}`, "POST"], [`/ide/${id}/resource?a=1`, "PATCH"], ["/authorize", "POST"]]) {
    const result = await request(url, method); assert.equal(result.status, 200); assert.deepEqual(result.cookies, ["first=1", "second=2"]);
    assert.deepEqual(JSON.parse(result.body), { name: "ide", path: url, method, host: `127.0.0.1:${port}`, cookie: "browser=secret" });
  }
  for (const url of ["/api/bootstrap", "/api/ide", "/gateway/v1/peer", `/workspace/${id}/../api/bootstrap`]) assert.equal((await request(url)).status, 404);
  for (const [url, name] of [["/gateway/v1/peer", "peer"], [`/ide/${id}/?reconnectionToken=test`, "ide"]]) {
    const ws = new WebSocket(origin.replace("https:", "wss:") + url, { ca, ...(name === "ide" ? { origin } : {}) }); clients.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const result = new Promise<string>(resolve => ws.once("message", b => resolve(b.toString()))); ws.send("payload"); assert.equal(await result, name + ":payload");
    await new Promise<void>(resolve => { ws.once("close", () => resolve()); ws.close(); });
  }
});
