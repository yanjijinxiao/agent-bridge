import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
// @ts-ignore Packaging is an independent JavaScript build entry point.
import { packageTaskboardRuntime } from "../scripts/package-taskboard-runtime.mjs";
// @ts-ignore Taskboard shares one JavaScript adapter across development and packaged layout.
import { gatewayAdapterUrl } from "../taskboard/server/native-backend.mjs";

test("compiled Gateway resolves its pinned Taskboard server, skill CLI and web from one artifact", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), web = path.join(root, "web"), destination = path.join(root, "dist/vendor/codex-taskboard");
  for (const name of ["server", "shared", "skills", "cli", "scripts"]) {
    fs.mkdirSync(path.join(source, name), { recursive: true }); fs.writeFileSync(path.join(source, name, "proof.mjs"), name);
  }
  fs.mkdirSync(web); fs.writeFileSync(path.join(web, "index.html"), "version one");
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "codex-taskboard", exports: { "./server": "./server/proof.mjs" } }));
  packageTaskboardRuntime({ source, web, destination });
  assert.ok(fs.existsSync(path.join(destination, "server/proof.mjs")));
  assert.equal(gatewayAdapterUrl(pathToFileURL(path.join(destination, "server/native-backend.mjs"))).href,
    pathToFileURL(path.join(root, "dist/codex/app-server-gateway.js")).href);
  assert.equal(gatewayAdapterUrl(pathToFileURL(path.join(root, "taskboard/server/native-backend.mjs"))).href,
    pathToFileURL(path.join(root, "dist/codex/app-server-gateway.js")).href);
  assert.equal(fs.readFileSync(path.join(destination, "cli/proof.mjs"), "utf8"), "cli");
  fs.writeFileSync(path.join(web, "index.html"), "version two");
  assert.equal(fs.readFileSync(path.join(destination, "dist/web/index.html"), "utf8"), "version one");
  fs.writeFileSync(path.join(destination, "obsolete"), "old");
  packageTaskboardRuntime({ source, web, destination });
  assert.equal(fs.readFileSync(path.join(destination, "dist/web/index.html"), "utf8"), "version two");
  assert.equal(fs.existsSync(path.join(destination, "obsolete")), false);
  for (const target of [source, root, web]) assert.throws(() => packageTaskboardRuntime({ source, web, destination: target }), /overlap/);
});

test("the actual packaged Taskboard imports all runtime dependencies without the workspace source", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "actual-taskboard-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const web = path.join(root, "web"), destination = path.join(root, "dist/vendor/codex-taskboard");
  fs.mkdirSync(web); fs.writeFileSync(path.join(web, "index.html"), "<div id=\"root\"></div>");
  packageTaskboardRuntime({ source: path.resolve("taskboard"), web, destination });
  const packaged = await import(pathToFileURL(path.join(destination, "server/index.mjs")).href);
  assert.equal(typeof packaged.createTaskboardServer, "function");
  assert.equal(packaged.resolveServerOptions({ dataDirectory: path.join(root, "data") }).staticDirectory,
    path.join(fs.realpathSync(destination), "dist/web"));
});
