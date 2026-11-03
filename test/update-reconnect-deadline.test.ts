import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
const body = source.slice(source.indexOf("async function waitForUpdatedService("), source.indexOf("function resetUpdateDialog("));
function fixture(fetchImpl: typeof fetch, timeout = 80) {
  const state = { requestToken: "previous", version: "old" };
  const run = vm.runInNewContext(`${body}; waitForUpdatedService`, { fetch: fetchImpl, AbortSignal, Date, state,
    UPDATE_RECONNECT_TIMEOUT_MS: timeout, delay: () => new Promise(resolve => setTimeout(resolve, 1)) });
  return { state, run: () => run("new", "previous") };
}
for (const phase of ["headers", "body"] as const) test(`update reconnect ${phase} stall cannot exceed the recovery deadline`, async t => {
  const server = http.createServer((_request, response) => {
    if (phase === "body") { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"version":'); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const f = fixture((input, init) => fetch(new URL(String(input), origin), init));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([f.run().then(() => "resolved", (error: Error) => error.message),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("still waiting"), 700); })]);
    assert.match(result, /尚未确认新版服务恢复/);
    assert.deepEqual(f.state, { requestToken: "previous", version: "old" });
  } finally { clearTimeout(timer); }
});
test("update reconnect requires both exact installed version and a new runtime token", async () => {
  let requests = 0;
  const rows = [{ version: "old", requestToken: "fresh" }, { version: "new", requestToken: "previous" },
    { version: "new", requestToken: "fresh" }, { version: "new", requestToken: "fresh" }];
  const f = fixture(async () => new Response(JSON.stringify(rows[requests++]), { status: requests === 3 ? 503 : 200 }), 1000);
  await f.run(); assert.equal(requests, 4); assert.deepEqual(f.state, { version: "new", requestToken: "fresh" });
});
test("update reconnect retries a failed probe and retains its no-store request", async () => {
  let requests = 0;
  const f = fixture(async (_input, options) => {
    assert.equal(options?.cache, "no-store");
    if (!requests++) throw Error("restarting");
    return new Response(JSON.stringify({ version: "new", requestToken: "fresh" }));
  }, 1000);
  await f.run(); assert.equal(requests, 2); assert.equal(f.state.version, "new");
});
