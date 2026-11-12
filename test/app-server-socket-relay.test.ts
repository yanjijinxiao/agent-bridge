import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { APP_SERVER_SOCKET_RELAY } from "../src/codex/app-server-socket-relay.js";

function wire(payload: Buffer, opcode = 1, final = true, declared = payload.length) {
  const header = Buffer.alloc(declared < 126 ? 2 : declared <= 65535 ? 4 : 10);
  header[0] = (final ? 128 : 0) | opcode;
  if (header.length === 2) header[1] = declared;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(declared, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(declared), 2); }
  return Buffer.concat([header, payload]);
}

async function fixture(t: test.TestContext, copyBudget = 64 * 1024 * 1024) {
  const root = fs.mkdtempSync("/private/tmp/ab-relay-"), endpoint = path.join(root, "rpc.sock"), stats = path.join(root, "stats.json");
  const server = http.createServer(), wss = new WebSocketServer({ server });
  const connected = once(wss, "connection");
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  // Count bytes actually copied by the production subprocess. The old growing
  // concat trips this budget without depending on wall-clock speed or RAM size.
  const instrumentation = `const fs=require('node:fs'),oldConcat=Buffer.concat,oldCopy=Buffer.prototype.copy;let copied=0;
function track(n){copied+=n;if(copied>${copyBudget})throw Error('COPY_BUDGET_EXCEEDED');}
Buffer.concat=function(a,n){track(n??a.reduce((s,b)=>s+b.length,0));return oldConcat.call(this,a,n);};
Buffer.prototype.copy=function(b,t=0,s=0,e=this.length){const n=oldCopy.call(this,b,t,s,e);track(n);return n;};
process.on('exit',()=>fs.writeFileSync(${JSON.stringify(stats)},JSON.stringify({copied})));\n`;
  const child = spawn(process.execPath, ["-e", instrumentation + APP_SERVER_SOCKET_RELAY, endpoint], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", b => stderr += b);
  const output: Buffer[] = [];
  child.stdout.on("data", b => output.push(b));
  const stopped = once(child, "close");
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    child.kill(); await stopped;
    wss.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const [peer, request] = await connected;
  const socket = request.socket;
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw Error("Relay condition timed out: " + stderr);
      if (child.exitCode !== null) throw Error("Relay exited: " + stderr);
      await new Promise(r => setTimeout(r, 5));
    }
  };
  return { child, peer, socket, stopped, stats, until, error: () => stderr,
    text: () => Buffer.concat(output).toString("utf8"),
    async finish() { child.stdin.end(); await stopped; return JSON.parse(fs.readFileSync(stats, "utf8")); } };
}

for (const mib of [8, 84]) test(`NATIVE-01.6: ${mib} MiB split frames use linear copying and deliver the following small reply under stdout backpressure`, { timeout: 15000 }, async t => {
  const payload = Buffer.from(JSON.stringify({ id: 1, result: "x".repeat(mib * 1024 * 1024) }));
  const f = await fixture(t, payload.length * 4);
  let inputs = 0; f.peer.on("message", () => inputs++);
  f.child.stdin.write('{"id":1,"method":"thread/read"}\n');
  const packet = wire(payload), tail = '{"id":2,"result":"after-large"}';
  for (let at = 0; at < packet.length; at += 8192) {
    if (f.socket.destroyed) break;
    f.socket.write(packet.subarray(at, at + 8192));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  if (!f.socket.destroyed) f.socket.write(wire(Buffer.from(tail)));
  await f.until(() => f.text().endsWith(tail + "\n"));
  const lines = f.text().trimEnd().split("\n");
  assert.equal(lines.length, 2); assert.equal(lines[0], payload.toString()); assert.equal(lines[1], tail);
  const result = await f.finish();
  assert.ok(result.copied < payload.length * 4, "copy work scales with bytes, not chunk count");
  assert.equal(inputs, 1, "receiving a large reply never replays the input");
});

test("NATIVE-01.6: fragmented UTF-8, interleaved ping and ignored binary data preserve message boundaries", async t => {
  const f = await fixture(t), body = Buffer.from('{"text":"阶段成果🙂"}'), cut = body.indexOf(Buffer.from("🙂")) + 1;
  const pong = once(f.peer, "pong");
  const packets = [wire(body.subarray(0, cut), 1, false), wire(Buffer.from("alive"), 9),
    wire(body.subarray(cut), 0), wire(Buffer.from([0, 1, 2]), 2), wire(Buffer.from('{"tail":true}'))];
  for (const packet of packets) {
    // Split every extended/header byte as well as data across socket reads.
    for (let i = 0; i < Math.min(packet.length, 10); i++) { f.socket.write(packet.subarray(i, i + 1)); await new Promise<void>(r => setImmediate(r)); }
    if (packet.length > 10) f.socket.write(packet.subarray(10));
  }
  await f.until(() => f.text().endsWith('{"tail":true}\n'));
  assert.equal(f.text(), body.toString() + '\n{"tail":true}\n');
  assert.equal((await pong)[0].toString(), "alive");
});

for (const length of [125, 126, 65535, 65536]) test(`NATIVE-01.6: frame length ${length} survives partial headers`, async t => {
  const f = await fixture(t), payload = Buffer.alloc(length, 97), packet = wire(payload);
  for (let i = 0; i < 10 && i < packet.length; i++) { f.socket.write(packet.subarray(i, i + 1)); await new Promise<void>(r => setImmediate(r)); }
  if (packet.length > 10) f.socket.write(packet.subarray(10));
  await f.until(() => f.text().endsWith("\n")); assert.equal(f.text(), payload.toString() + "\n");
});

for (const fragmented of [false, true]) test(`NATIVE-01.6: oversized ${fragmented ? "cumulative message" : "frame"} fails from its header without allocation or partial output`, async t => {
  const f = await fixture(t, 1024 * 1024);
  if (fragmented) f.socket.write(wire(Buffer.from("x"), 1, false));
  f.socket.write(wire(Buffer.alloc(0), fragmented ? 0 : 1, true, 256 * 1024 * 1024 + (fragmented ? 0 : 1)));
  const [code] = await f.stopped;
  assert.equal(code, 1); assert.equal(f.text(), ""); assert.match(f.error(), /too large/);
});

test("NATIVE-01.6: closing an incomplete payload ends only its relay and emits no partial message", async t => {
  const f = await fixture(t);
  f.socket.end(wire(Buffer.from("cut"), 1, true, 1000));
  assert.equal((await f.stopped)[0], 1); assert.equal(f.text(), "");
  assert.equal(f.peer.readyState, 3);
});
