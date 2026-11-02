#!/usr/bin/env node
import readline from "node:readline";
import { closeSync } from "node:fs";

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "config/read" ? { config: { model: "fixture" } } : {};
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  if (request.method === "config/read") {
    lines.close(); process.stdin.on("error", () => {}); process.stdin.destroy();
    try { closeSync(0); } catch {}
    // The relay can lose its input pipe before its process exits. Bounded even
    // if the parent under test crashes, so this fixture cannot leave an orphan.
    setTimeout(() => process.exit(0), 1500);
  }
});
