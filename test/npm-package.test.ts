import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// @ts-ignore Release tooling is a standalone JavaScript entry.
import { publicationManifest } from "../scripts/package-npm.mjs";
import { NPM_PACKAGE_NAME } from "../src/runtime/product.js";
import { productVersion } from "../src/runtime/versions.js";
import { resolveNpmInstallTarget } from "../src/server/update-manager.js";
import { createNpmReleaseDirectory, npmCandidateRoot, sealNpmRelease, activateNpmRelease, rollbackNpmRelease, readNpmRelease } from "../src/server/npm-release.js";
import { parseServerCommand } from "../src/server/arguments.js";

test("npm publication keeps one product version and drops source-only workspace/install hooks", () => {
  const source = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const locked = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  const artifact = publicationManifest({ ...source, scripts: { postinstall: "must not run" } });
  assert.equal(artifact.name, NPM_PACKAGE_NAME);
  assert.equal(artifact.version, productVersion());
  assert.equal(artifact.version, locked.version);
  assert.equal(artifact.version, locked.packages[""].version);
  for (const field of ["scripts", "workspaces", "devDependencies", "private"]) assert.equal(artifact[field], undefined);
  assert.deepEqual(artifact.bin, { "agent-bridge": "dist/server/index.js", "agent-bridge-connector": "dist/peer/index.js" });
  assert.equal(artifact.publishConfig.access, "public");
  assert.equal(parseServerCommand(["--version"]), "version");
});

test("scoped npm installations resolve on macOS, Windows and local prefixes without treating source as npm", () => {
  for (const [root, platform, prefix, global] of [
    ["/opt/homebrew/lib/node_modules/@yanjijinxiao/agent-bridge", "darwin", "/opt/homebrew", true],
    ["/tmp/app/node_modules/@yanjijinxiao/agent-bridge", "linux", "/tmp/app", false],
    ["C:\\Users\\a\\npm\\node_modules\\@yanjijinxiao\\agent-bridge", "win32", "C:\\Users\\a\\npm", true]
  ] as const) assert.deepEqual(resolveNpmInstallTarget(root, platform), { installPrefix: prefix, packageRoot: root, global });
  assert.equal(resolveNpmInstallTarget("/workspace/agent-bridge"), undefined);
  assert.equal(resolveNpmInstallTarget("/tmp/node_modules/@somebody/agent-bridge"), undefined);
});

test("scoped package update activates and rolls back inside its scope without touching a sibling package", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-scoped-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "node_modules", "@yanjijinxiao", "agent-bridge");
  const write = (dir: string, version: string) => {
    fs.mkdirSync(path.join(dir, "dist/server"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
    fs.writeFileSync(path.join(dir, "dist/server/index.js"), version);
  };
  write(target, "1.0.0");
  const sibling = path.join(path.dirname(target), "other"); fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, "keep"), "unchanged");
  const dir = createNpmReleaseDirectory(target); write(npmCandidateRoot(dir), "1.1.0");
  const file = sealNpmRelease(dir, target, "1.1.0");
  activateNpmRelease(file); rollbackNpmRelease(file);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).version, "1.0.0");
  assert.equal(fs.readFileSync(path.join(sibling, "keep"), "utf8"), "unchanged");
  const plan = JSON.parse(fs.readFileSync(file, "utf8")); plan.target = sibling;
  fs.writeFileSync(file, JSON.stringify(plan)); assert.throws(() => readNpmRelease(file), /Invalid npm release plan/);
});
