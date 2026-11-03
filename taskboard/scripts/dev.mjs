import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Own the actual Vite process, rather than an npm wrapper that can exit while
// leaving its frontend child alive. Resolve from this package's installation.
const require = createRequire(import.meta.url);
const vite = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");

const children = [
  spawn(process.execPath, ["--watch", "server/index.mjs", "--dev"], {
    stdio: "inherit",
  }),
  spawn(process.execPath, [vite, "--config", "web/vite.config.ts"], {
    stdio: "inherit",
  }),
];

let shuttingDown = false;

function stop(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("Taskboard development process failed:", error.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    // Even a clean exit removes half of the dev stack. An unsolicited signal
    // is a failure; the parent's explicit shutdown already set its exit code.
    if (!shuttingDown) stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
