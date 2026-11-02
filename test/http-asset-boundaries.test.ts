import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { resolveStatePaths } from "../src/state/paths.js";

test("static asset routing accepts only explicitly listed own keys", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-static-map-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = await startLocalHttpServer({ paths: resolveStatePaths(root), port: 0, accountManager: {} as never });
  t.after(() => server.close());
  for (const resource of ["/__proto__", "/constructor", "/toString"]) {
    const response = await fetch(server.url + resource);
    assert.equal(response.status, 404, resource);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
  assert.equal((await fetch(server.url + "/styles.css")).status, 200);
});

test("an attachment reader failing before headers does not retain file length or range headers on its JSON error", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-asset-read-error-")), file = path.join(root, "fixture.txt");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, "x".repeat(4096));
  const server = await startLocalHttpServer({ paths: resolveStatePaths(root), port: 0, accountManager: {
    async getSessionAttachment() { return { path: file, name: "fixture.txt" }; }
  } as never });
  t.after(() => server.close());
  t.mock.method(fs, "createReadStream", () => {
    const stream = new PassThrough();
    process.nextTick(() => stream.destroy(Error("fixture reader unavailable")));
    return stream;
  });
  const response = await fetch(`${server.url}/api/sessions/account/session/messages/message/attachments/0`, {
    headers: { Range: "bytes=0-2047" }, signal: AbortSignal.timeout(2000)
  });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("content-range"), null);
  assert.equal(response.headers.get("content-disposition"), null);
  assert.deepEqual(await response.json(), { error: "fixture reader unavailable" });
});
