import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import vm from "node:vm";
import test from "node:test";

// Execute production functions without importing main: never discover or inject the user's App.
const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const fetchSource = source.slice(source.indexOf("async function fetchJson("), source.indexOf("async function isReachable("));
const cdpSource = source.slice(source.indexOf("class CdpConnection"), source.indexOf("async function codexTargets("));
const fetchJson = vm.runInNewContext(`${fetchSource}; fetchJson`, { fetch, AbortSignal });

for (const phase of ["headers", "body", "healthy"]) {
  test(`CDP target discovery bounds a stalled ${phase} response and still accepts healthy JSON`, async (t) => {
    const server = http.createServer((_request, response) => {
      if (phase === "headers") return;
      response.writeHead(200, { "Content-Type": "application/json" });
      if (phase === "body") { response.write("["); return; }
      response.end('[{"id":"main"}]');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    let timer;
    try {
      const result = await Promise.race([
        fetchJson(`http://127.0.0.1:${server.address().port}/json/list`, phase === "healthy" ? 2_000 : 40)
          .then(value => ({ value }), error => ({ error })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ stalled: true }), phase === "healthy" ? 5_000 : 700); }),
      ]);
      assert.equal(result.stalled, undefined, "request/body must not outlive its own deadline");
      if (phase === "healthy") assert.deepEqual(result.value, [{ id: "main" }]);
      else assert.match(result.error?.name ?? "", /TimeoutError|AbortError/);
    } finally { clearTimeout(timer); }
  });
}

function cdpFixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  class Socket extends EventTarget {
    constructor() { super(); this.closeCalls = 0; this.sent = []; }
    close() { this.closeCalls++; this.dispatchEvent(new Event("close")); }
    send(text) { this.sent.push(JSON.parse(text)); }
  }
  const Connection = vm.runInNewContext(`${cdpSource}; CdpConnection`, { WebSocket: Socket, setTimeout, clearTimeout, console });
  const cdp = new Connection("ws://fixture.invalid");
  return { cdp, socket: cdp.socket };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test("CDP handshake timeout closes the socket and retires a late open", async (t) => {
  const { cdp, socket } = cdpFixture(t);
  let settled;
  const opened = cdp.open().then(() => { settled = "open"; }, error => { settled = error.message; });
  t.mock.timers.tick(15_000); await tick();
  assert.match(settled ?? "", /Timed out/);
  await opened;
  assert.equal(cdp.closed, true); assert.equal(socket.closeCalls, 1);
  socket.dispatchEvent(new Event("open")); await tick();
  assert.match(settled, /Timed out/);
});
for (const event of ["error", "close"]) {
  test(`CDP handshake ${event} rejects immediately and closes the failed connection`, async (t) => {
    const { cdp, socket } = cdpFixture(t);
    let settled;
    const opened = cdp.open().then(() => { settled = "open"; }, error => { settled = error.message; });
    socket.dispatchEvent(new Event(event)); await tick();
    assert.match(settled ?? "", /CDP WebSocket/); await opened;
    assert.equal(cdp.closed, true);
    const closes = socket.closeCalls;
    t.mock.timers.tick(30_000); assert.equal(socket.closeCalls, closes);
  });
}
test("healthy CDP handshake removes the connection timer and delivers response messages", async (t) => {
  const { cdp, socket } = cdpFixture(t);
  const opened = cdp.open(); socket.dispatchEvent(new Event("open")); await opened;
  t.mock.timers.tick(30_000); assert.equal(cdp.closed, false);
  const reply = cdp.send("Runtime.evaluate", { expression: "1" });
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: socket.sent[0].id, result: { value: 1 } }) }));
  assert.equal((await reply).value, 1);
  cdp.close(); assert.equal(cdp.closed, true);
});
