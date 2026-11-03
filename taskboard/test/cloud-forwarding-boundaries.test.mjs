import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskboardServer } from "../server/app.mjs";

async function server(t, remoteFetch) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloud-forwarding-audit-"));
  const app = createTaskboardServer({ dataDirectory: directory,
    cloudConfigStore: { async read() { return { remoteUrl: "https://tasks.example.test", actorName: "Audit", sharedKey: "synthetic-only", projectMappings: {} }; } },
    remoteFetch });
  const address = await app.listen({ port: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return address.port;
}

for (const route of ["/api/tasks", "//other.example.test/api/tasks"]) {
  test(`cloud forwarding keeps credentials on the configured origin: ${route}`, async t => {
    const calls = [];
    const port = await server(t, async (url, init) => {
      calls.push({ url: new URL(url), authorization: init.headers.get("authorization") });
      return Response.json({ tasks: [] });
    });
    const status = await new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: route }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      }).on("error", reject);
    });
    assert.equal(status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.origin, "https://tasks.example.test");
    assert.equal(calls[0].url.pathname, route);
    assert.match(calls[0].authorization, /^Basic /);
  });
}

test("disconnecting an attachment download cancels its upstream stream", async t => {
  let cancelled = false;
  let controller;
  const port = await server(t, async () => new Response(new ReadableStream({
    start(c) { controller = c; c.enqueue(new Uint8Array([1, 2, 3])); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/octet-stream" } }));
  t.after(() => { if (!cancelled) controller.close(); });
  await new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: "/api/attachments/example/content" }, response => {
      response.once("data", () => { response.destroy(); resolve(); });
    }).on("error", reject);
  });
  for (let i = 0; i < 50 && !cancelled; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, true, "a disconnected client must not retain the upstream download");
});
