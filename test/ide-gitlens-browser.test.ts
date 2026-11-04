import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { isolatedBrowser, eventually } from "./helpers/gap-browser.js";

// Explicit opt-in: a reviewed official VSIX and real code-server/Chrome are
// external fixtures. The normal suite does not download arbitrary extensions.
test("IDE-08.5: real GitLens displays line authorship and full commit hover", {
  skip: !process.env.CODEX_CHROME_TEST_BIN || !process.env.CODEX_REAL_IDE_TEST_BIN || !process.env.CODEX_GITLENS_TEST_VSIX,
  timeout: 120000
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-gitlens-")));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data"), extensions = path.join(root, "extensions");
  fs.mkdirSync(workspace); fs.mkdirSync(path.join(data, "User"), { recursive: true });
  const git = (args: string[], input?: string) => execFileSync("git", ["-C", workspace, ...args], {
    encoding: "utf8", input, env: { ...process.env, GIT_AUTHOR_NAME: "Gateway Test Author", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Gateway Test Author", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }
  }).trim();
  git(["init", "--quiet"]);
  fs.writeFileSync(path.join(workspace, "sample.ts"), "export function greeting(name: string) {\n  return `Hello, ${name}`;\n}\n");
  git(["add", "sample.ts"]);
  // Plumbing keeps fixture history independent of personal commit templates
  // and hooks, without changing any user repository or global Git settings.
  const commit = git(["-c", "commit.gpgsign=false", "commit-tree", git(["write-tree"])],
    "Verify GitLens commit hover\n\nExpected full commit details from an isolated verification repository.\n");
  git(["update-ref", git(["symbolic-ref", "HEAD"]), commit]);
  fs.writeFileSync(path.join(data, "User/settings.json"), JSON.stringify({
    "workbench.startupEditor": "none", "workbench.secondarySideBar.defaultVisibility": "hidden",
    "security.workspace.trust.enabled": false, // This fixture owns every file in the temporary workspace.
    "gitlens.currentLine.enabled": true, "gitlens.hovers.enabled": true, "gitlens.hovers.currentLine.over": "line",
    "gitlens.showWelcomeOnInstall": false, "gitlens.showWhatsNewAfterUpgrades": false, "telemetry.telemetryLevel": "off",
    "editor.fontSize": 16, "editor.lineHeight": 24
  }));
  const binary = process.env.CODEX_REAL_IDE_TEST_BIN!;
  const args = ["--user-data-dir", data, "--extensions-dir", extensions];
  const installed = execFileSync(binary, [...args, "--install-extension", path.resolve(process.env.CODEX_GITLENS_TEST_VSIX!)], { encoding: "utf8", timeout: 45000 });
  assert.match(installed, /successfully installed/);
  assert.match(execFileSync(binary, [...args, "--list-extensions", "--show-versions"], { encoding: "utf8", timeout: 15000 }), /eamodio\.gitlens@/);
  const reserve = net.createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as net.AddressInfo).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const log = fs.openSync(path.join(root, "server.log"), "a", 0o600);
  const server = spawn(binary, [...args, "--config", path.join(root, "config.yaml"), "--auth", "none", "--disable-telemetry",
    "--bind-addr", `127.0.0.1:${port}`, workspace], { stdio: ["ignore", log, log] }); fs.closeSync(log);
  let closeBrowser: (() => Promise<void>) | undefined;
  let capture: (() => Promise<void>) | undefined;
  t.after(async () => {
    await capture?.();
    await closeBrowser?.();
    if (server.exitCode === null && server.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => server.kill("SIGKILL"), 3000);
      server.once("exit", () => { clearTimeout(timer); resolve(); }); server.kill("SIGTERM");
    });
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await eventually(async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, "code-server did not start", 30000);
  const browser = await isolatedBrowser(t, root, { commandTimeoutMs: 30000 }); closeBrowser = browser.close;
  const { call, evaluate } = browser;
  capture = async () => {
    const shot = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(path.join(os.tmpdir(), "gitlens-regression.png"), Buffer.from(shot.data, "base64"));
    fs.writeFileSync(path.join(os.tmpdir(), "gitlens-regression-visible.txt"), await evaluate("document.body.innerText"));
  };
  await call("Page.navigate", { url: `http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}` });
  await eventually(() => evaluate("Boolean(document.querySelector('.monaco-workbench'))"), "workbench did not load", 30000);
  const filePosition = await eventually(() => evaluate("(()=>{const e=[...document.querySelectorAll('[role=treeitem]')].find(e=>e.textContent.includes('sample.ts'));if(!e)return;const r=e.getBoundingClientRect();return {x:r.left+60,y:r.top+r.height/2}})()"), "fixture file missing", 30000);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 2, ...filePosition });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 2, ...filePosition });
  await eventually(() => evaluate("document.body.innerText.includes('Gateway Test Author')"), "GitLens authorship did not activate", 30000);
  const position = await evaluate("(()=>{const r=document.querySelector('.view-line').getBoundingClientRect();return {x:r.left+120,y:r.top+r.height/2}})()");
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...position });
  const hover = await eventually(() => evaluate("[...document.querySelectorAll('.monaco-hover')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.textContent).find(t=>t.includes('Expected full commit details'))"), "GitLens commit hover missing", 20000);
  assert.match(hover, /Gateway Test Author/); assert.match(hover, /Verify GitLens commit hover/); assert.ok(hover.includes(commit.slice(0, 7)));
  t.diagnostic("Official extension installed and listed; actual browser rendered author, subject, full body and matching commit hash.");
});
