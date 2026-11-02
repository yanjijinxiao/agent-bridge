import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";

for (const operation of ["sessions", "projects", "models", "history"] as const) {
  for (const shape of ["missing", "not-array", "bad-cursor", "repeated", "empty"]) {
    test(`${operation} distinguishes a valid empty native page from ${shape} protocol data`, async t => {
      const fixture = fileURLToPath(new URL("./fixtures/catalog-shapes-app-server.mjs", import.meta.url));
      const runner = new AppServerCodexRunner({ catalogSource: "native", requestTimeoutMs: 1000,
        transport: { command: process.execPath, args: [fixture, shape], mode: "daemon-proxy" } });
      t.after(() => runner.close());
      const read = () => operation === "sessions" ? runner.listSessionCatalog() : operation === "projects" ? runner.listProjects()
        : operation === "models" ? runner.listModels() : runner.getHistoryPage("thread", { cursor: shape === "repeated" ? "again" : undefined });
      if (shape !== "empty") await assert.rejects(read(), "malformed/incomplete pages must not look like a complete empty catalog");
      else {
        const result = await read();
        assert.deepEqual(operation === "sessions" ? (result as any).threads : operation === "projects" ? (result as any).projects
          : operation === "models" ? result : (result as any).messages, []);
      }
    });
  }
}

for (const operation of ["snapshot", "inspection", "lookup"] as const) {
  for (const shape of ["missing", "not-array", "bad-cursor", ...(operation === "lookup" ? ["repeated"] : []), "empty"]) {
    test(`${operation} refuses incomplete native metadata from ${shape} data`, async t => {
      const fixture = fileURLToPath(new URL("./fixtures/catalog-shapes-app-server.mjs", import.meta.url));
      const runner = new AppServerCodexRunner({ catalogSource: "native", requestTimeoutMs: 1000,
        transport: { command: process.execPath, args: [fixture, shape, operation], mode: "daemon-proxy" } });
      t.after(() => runner.close());
      const read = () => operation === "snapshot" ? runner.readThreadSnapshot("thread") : runner.inspectThread("thread");
      if (shape !== "empty") await assert.rejects(read(), "an incomplete read cannot certify idle/missing or an empty turn history");
      else {
        const result = await read();
        if (operation === "snapshot") assert.deepEqual((result as any).turns, []);
        else assert.equal((result as any).persistence, operation === "lookup" ? "missing" : "active");
      }
    });
  }
}
