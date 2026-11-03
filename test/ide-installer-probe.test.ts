import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CODE_SERVER_VERSION } from "../src/ide/installer.js";

// Exercise the public process IO and its actual child, rather than replacing
// probe() with an already-compatible result. No installed IDE is touched.
for (const mode of ["compatible", "different-version", "failed"] as const) {
  test("IDE-03.5: version probe isolates configuration and cleans its own files (" + mode + ")",
    { skip: process.platform === "win32" }, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-probe-contract-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const userConfig = path.join(root, "user.yaml"), receipt = path.join(root, "receipt.json");
      const binary = path.join(root, "code-server"), caller = path.join(root, "probe.mjs");
      fs.writeFileSync(userConfig, "invalid-user-config: [\n", { mode: 0o400 });
      fs.writeFileSync(binary, [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        "const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];",
        "const config = option('--config');",
        "if (!args.includes('--config') || config === process.env.CODE_SERVER_CONFIG) process.exit(21);",
        "const content = fs.readFileSync(config, 'utf8');",
        "fs.writeFileSync(" + JSON.stringify(receipt) + ", JSON.stringify({ args, config, content, permissions: fs.statSync(config).mode & 0o777 }));",
        mode === "failed" ? "process.exit(7);" : "process.stdout.write(" +
          JSON.stringify(mode === "compatible" ? CODE_SERVER_VERSION : CODE_SERVER_VERSION + "0") +
          " + ' fixture-commit with Code 1.141.0\\n');"
      ].join("\n"), { mode: 0o700 });
      fs.writeFileSync(caller, [
        "import { ProcessIDEInstallerIO } from " + JSON.stringify(new URL("../src/ide/installer.ts", import.meta.url).href) + ";",
        "const result = await new ProcessIDEInstallerIO(" + JSON.stringify(root) + ").probe('local', " +
          JSON.stringify(binary) + ", new AbortController().signal);",
        "process.stdout.write(JSON.stringify(result));"
      ].join("\n"));
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", caller], {
        env: { ...process.env, CODE_SERVER_CONFIG: userConfig }, timeout: 30_000
      });
      const result = JSON.parse(stdout), proof = JSON.parse(fs.readFileSync(receipt, "utf8"));
      assert.equal(result.binary, mode === "compatible" ? binary : undefined);
      assert.equal(proof.content, "{}\n"); assert.equal(proof.permissions, 0o600);
      assert.equal(fs.existsSync(path.dirname(proof.config)), false, "temporary config is removed even after failure");
      for (const flag of ["--user-data-dir", "--extensions-dir"]) {
        assert.equal(path.dirname(proof.args[proof.args.indexOf(flag) + 1]), path.dirname(proof.config));
      }
      assert.equal(fs.readFileSync(userConfig, "utf8"), "invalid-user-config: [\n");
      assert.equal(fs.statSync(userConfig).mode & 0o777, 0o400);
      assert.deepEqual(fs.readdirSync(root).sort(), ["code-server", "probe.mjs", "receipt.json", "user.yaml"]);
    });
}
