import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
// @ts-ignore The release CLI is independent JavaScript tooling.
import { readReleaseJson } from "../scripts/release-local.mjs";

async function server(t: test.TestContext, handler: http.RequestListener) {
  const s = http.createServer(handler);
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return new URL("http://127.0.0.1:" + (s.address() as { port: number }).port);
}

test("REL-02.10: a healthy cold readiness response slower than five seconds succeeds", { timeout: 12_000 }, async t => {
  const url = await server(t, (_request, response) => {
    const timer = setTimeout(() => { response.setHeader("Content-Type", "application/json"); response.end('{"ready":true}'); }, 5500);
    response.on("close", () => clearTimeout(timer));
  });
  assert.deepEqual(await readReleaseJson(url), { ready: true });
});

for (const stall of ["headers", "body"]) test("REL-02.10: readiness " + stall + " stall obeys the remaining total budget", async t => {
  const url = await server(t, (_request, response) => {
    if (stall === "body") { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"ready":'); }
  });
  const start = Date.now();
  await assert.rejects(readReleaseJson(url, 120), /abort|timeout/i);
  assert.ok(Date.now() - start < 1500, "the remaining total budget is not reset to fifteen seconds");
});

test("REL-02.10: expired readiness never sends a probe", async () => {
  let calls = 0;
  await assert.rejects(readReleaseJson(new URL("http://127.0.0.1:1"), 0, () => { calls++; }), /deadline/);
  assert.equal(calls, 0);
});
