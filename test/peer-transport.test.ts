import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { GatewayPeerClient, GatewayPeerServer } from "../src/peer/transport.js";
import { PeerConnectionError } from "../src/peer/rpc.js";
import { peerFixture, token } from "./peer-fixture.js";

test("the accepted and dialled endpoints use the same bidirectional RPC contract", async t => {
  const f = await peerFixture(t);
  f.serverConnection.handle("echo.server", value => ({ server: value }));
  f.clientConnection.handle("echo.client", value => ({ client: value }));
  assert.deepEqual(await f.clientConnection.request("echo.server", "hello"), { server: "hello" });
  assert.deepEqual(await f.serverConnection.request("echo.client", "world"), { client: "world" });
});

test("peer ingress rejects bad credentials, unknown device IDs, paths and browser origins", async t => {
  const f = await peerFixture(t);
  for (const [id, secret, extra, suffix] of [
    ["laptop", "wrong-credential", {}, ""], ["other", token, {}, ""],
    ["laptop", token, { Origin: "https://example.invalid" }, ""], ["laptop", token, {}, "?token=not-accepted"]
  ] as const) {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(f.server.url + suffix, { headers: { "x-gateway-peer-id": id, authorization: `Bearer ${secret}`, ...extra } });
      socket.on("error", () => {}); socket.once("open", () => { socket.terminate(); reject(Error("unexpected authentication success")); });
      socket.once("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
    });
    assert.equal(status, 401);
  }
});

test("network listeners and clients require TLS unless insecure LAN is explicitly selected", async () => {
  await assert.rejects(GatewayPeerServer.listen({ host: "0.0.0.0", port: 0, credentials: { laptop: token }, accept() {} }), /requires TLS/);
  assert.throws(() => new GatewayPeerClient({ url: "ws://192.0.2.1/gateway/v1/peer", nodeId: "laptop", token, connected() {} }), /requires wss/);
});

test("a disconnect rejects an ambiguous request and reconnect does not replay it", async t => {
  const f = await peerFixture(t), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let calls = 0;
  f.clientConnection.handle("pending", async () => { calls++; entered.resolve(); await release.promise; return "done"; });
  const pending = f.serverConnection.request("pending");
  const rejection = assert.rejects(pending, error => error instanceof PeerConnectionError && error.sent);
  await entered.promise; await f.reconnect(); await rejection; release.resolve();
  assert.equal(calls, 1);
  assert.equal(f.serverConnection.open, true);
});

test("malformed and oversized requests are refused without invoking handlers", async t => {
  const f = await peerFixture(t);
  await assert.rejects(f.serverConnection.request("unused", "x".repeat(1024 * 1024)), /1 MiB/);
  const socket = new WebSocket(f.server.url, { headers: { "x-gateway-peer-id": "laptop", authorization: `Bearer ${token}` } });
  await new Promise<void>(resolve => socket.once("open", resolve));
  const closed = new Promise<number>(resolve => socket.once("close", resolve));
  socket.send(JSON.stringify({ version: 99, type: "request" }));
  assert.equal(await closed, 1008);
});
