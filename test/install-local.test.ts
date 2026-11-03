import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repositoryRoot, "scripts", "install-local.mjs");

for (const version of ["21.7.3", "22.0.0", "22.12.0", "23.3.0"]) {
  test(`local installer rejects Node ${version} before building or writing links`, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-version-check-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    // Exercise the real CLI entry and its ordering; substitute only the version
    // fact, rather than installing an old runtime or building in the live tree.
    const code = `Object.defineProperty(process.versions, 'node', {value:${JSON.stringify(version)}});
      process.argv = [process.execPath, ${JSON.stringify(installer)}, '--skip-dependencies', '--skip-build'];
      await import(${JSON.stringify(new URL("../scripts/install-local.mjs", import.meta.url).href)});`;
    await assert.rejects(execFileAsync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: repositoryRoot, env: { ...process.env, HOME: home }
    }), (error: unknown) => {
      const result = error as { code: number; stderr: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Node\.js.*22\.13.*23\.4/);
      assert.match(result.stderr, new RegExp(`current version is ${version.replaceAll('.', '\\.')}`));
      return true;
    });
    assert.deepEqual(fs.readdirSync(home), [], "unsupported Node must not install any links");
  });
}

test("local installer links every bundled Skill without named business dependencies", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-gateway-installer-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const environment = { ...process.env, HOME: home };

  const installed = await execFileAsync(process.execPath, [
    installer,
    "--skip-dependencies",
    "--skip-build"
  ], { cwd: repositoryRoot, env: environment });
  const result: unknown = JSON.parse(installed.stdout);
  assert.deepEqual(result, {
    ok: true,
    mode: "install",
    projectRoot: repositoryRoot,
    taskboardRoot: path.join(repositoryRoot, "taskboard"),
    stateDirectory: path.join(home, ".codex-im-gateway", "taskboard"),
    links: {
      taskctl: "created",
      skills: {
        "manage-taskboard": "created",
        "manage-weekly-report": "created"
      }
    },
    urls: { admin: "http://127.0.0.1:8787", taskboard: "http://127.0.0.1:47823" }
  });
  assert.equal(
    fs.realpathSync(path.join(home, ".codex", "skills", "manage-taskboard")),
    fs.realpathSync(path.join(repositoryRoot, "taskboard", "skills", "manage-taskboard"))
  );
  assert.equal(
    fs.realpathSync(path.join(home, ".codex", "skills", "manage-weekly-report")),
    fs.realpathSync(path.join(repositoryRoot, "taskboard", "skills", "manage-weekly-report"))
  );

  const checked = await execFileAsync(process.execPath, [installer, "--check"], {
    cwd: repositoryRoot,
    env: environment
  });
  const checkResult: unknown = JSON.parse(checked.stdout);
  assert.match(JSON.stringify(checkResult), /"manage-taskboard":"current"/);
  assert.match(JSON.stringify(checkResult), /"manage-weekly-report":"current"/);
});
