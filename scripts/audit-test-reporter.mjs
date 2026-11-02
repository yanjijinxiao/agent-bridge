import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Optional offline audit output. This reporter never participates in Gateway.
export default async function* report(source) {
  for await (const { type, data } of source) {
    if (!["test:pass", "test:fail"].includes(type) || data.details?.type === "suite") continue;
    const file = data.file && path.relative(root, data.file);
    const sha256 = data.file && fs.existsSync(data.file)
      ? crypto.createHash("sha256").update(fs.readFileSync(data.file)).digest("hex") : undefined;
    const error = data.details?.error;
    const failure = type === "test:fail" ? { code: error?.code,
      message: String(error?.cause?.message ?? error?.message ?? "Test failed").slice(0, 1000),
      stack: String(error?.cause?.stack ?? error?.stack ?? "").split("\n")
        .filter(line => line.trimStart().startsWith("at ")).slice(0, 8) } : undefined;
    yield `${JSON.stringify({ kind: "test", file, name: data.name, sha256,
      status: data.skip ? "skipped" : data.todo ? "todo" : type === "test:pass" ? "passed" : "failed", ...(failure ? { failure } : {}) })}\n`;
  }
}
