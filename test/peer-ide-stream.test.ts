import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import test from "node:test";
import { PeerIDEStreams, IDE_STREAM_LIMIT } from "../src/peer/ide-stream.js";
import { peerFixture } from "./peer-fixture.js";

for (const invalid of ["sequence", "oversize", "encoding", "after-end"] as const) test(`IDE stream ${invalid} violation closes only that stream`, async t => {
  const f = await peerFixture(t), streams = new PeerIDEStreams(f.clientConnection), socket = new net.Socket({ allowHalfOpen: true });
  const id = crypto.randomUUID(); streams.add(id, socket, () => {});
  if (invalid === "after-end") await f.serverConnection.request("ide.stream", { id, seq: 0, kind: "end" });
  await assert.rejects(f.serverConnection.request("ide.stream", { id, seq: invalid === "sequence" ? 9 : invalid === "after-end" ? 1 : 0,
    kind: "data", data: invalid === "oversize" ? "a".repeat(50000) : invalid === "encoding" ? "?" : "YQ==" }));
  assert.equal(socket.destroyed, true); assert.equal(f.clientConnection.open, true); assert.equal(f.runs.length, 0); assert.equal(f.stops.length, 0);
});

test("IDE streams cap sockets, release capacity and reject concurrent unacknowledged blocks", async t => {
  const f = await peerFixture(t), streams = new PeerIDEStreams(f.clientConnection);
  const sockets = Array.from({ length: IDE_STREAM_LIMIT }, () => ({ id: crypto.randomUUID(), socket: new net.Socket() }));
  for (const { id, socket } of sockets) streams.add(id, socket, () => {});
  const extra = new net.Socket(); assert.throws(() => streams.add(crypto.randomUUID(), extra, () => {}), /limit/); assert.equal(extra.destroyed, true);
  streams.close(sockets[0].id); const id = crypto.randomUUID(), socket = new net.Socket(); streams.add(id, socket, () => {});
  let written = false;
  t.mock.method(socket, "write", () => { written = true; return false; });
  const first = f.serverConnection.request("ide.stream", { id, seq: 0, kind: "data", data: "YQ==" });
  const rejected = assert.rejects(first);
  while (!written) await new Promise(r => setTimeout(r, 5));
  await assert.rejects(f.serverConnection.request("ide.stream", { id, seq: 1, kind: "data", data: "Yg==" }), /sequence/);
  await rejected; assert.equal(socket.destroyed, true); assert.equal(f.clientConnection.open, true);
});
