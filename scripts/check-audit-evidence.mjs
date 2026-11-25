import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Read-only progress/evidence report. It neither starts nor gates any service.
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const audit = path.resolve(root, process.argv[2] ?? "docs/audits/2026-11-01-four-layer-recheck");
const requirements = JSON.parse(fs.readFileSync(path.join(root, "docs/architecture/gateway-requirements.json"), "utf8"));
const jsonl = file => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const baselineInventory = jsonl(path.join(audit, "inventory.jsonl"));
const additionsPath = path.join(audit, "inventory-additions.jsonl");
const inventory = [...baselineInventory, ...(fs.existsSync(additionsPath) ? jsonl(additionsPath) : [])];
const removedPath = path.join(audit, "inventory-removed.jsonl");
const removedEntries = fs.existsSync(removedPath) ? jsonl(removedPath) : [];
const ledger = jsonl(path.join(audit, "read-ledger.jsonl"));
const runs = fs.existsSync(path.join(audit, "test-results.jsonl")) ? jsonl(path.join(audit, "test-results.jsonl")) : [];
const functionFile = path.join(root, "docs/architecture/function-contracts.jsonl");
const functions = fs.existsSync(functionFile) ? jsonl(functionFile) : [];
const errors = [], modules = new Set(requirements.modules.map(module => module.id)), ids = new Set();
const inventoryKinds = new Map();
for (const entry of inventory) {
  if (inventoryKinds.has(entry.path)) errors.push(`Duplicate inventory path: ${entry.path}`);
  inventoryKinds.set(entry.path, entry.kind);
}
const checkedPath = relative => {
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Outside repository: ${relative}`);
  return absolute;
};
const bytes = new Map();
const data = file => {
  if (!bytes.has(file)) {
    let content;
    try {
      content = fs.readFileSync(checkedPath(file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      bytes.set(file, null);
      return null;
    }
    bytes.set(file, { sha256: crypto.createHash("sha256").update(content).digest("hex"),
      lines: content.length ? content.toString("utf8").split(/\n/).length - (content.at(-1) === 10 ? 1 : 0) : 0 });
  }
  return bytes.get(file);
};
const retired = new Map();
for (const entry of removedEntries) {
  if (!inventoryKinds.has(entry.path) || retired.has(entry.path) || !/^[0-9a-f]{40}$/.test(entry.commit)
    || !entry.reason?.trim() || data(entry.path)) {
    errors.push(`Invalid inventory removal: ${entry.path}`);
  } else {
    retired.set(entry.path, entry);
  }
}
// Retiring a path preserves historical reviews. A live case or function referencing it is still an error.
const missing = new Set();
const requiredData = file => {
  const current = data(file);
  if (!current && !missing.has(file)) {
    missing.add(file);
    errors.push(`Missing required file: ${file}`);
  }
  return current;
};
for (const entry of ledger) {
  if (retired.has(entry.file)) continue;
  const current = requiredData(entry.file);
  if (!current) continue;
  if (entry.mode !== undefined) {
    const kind = inventoryKinds.get(entry.file);
    if (!(entry.mode === "visual" && kind === "binary"
      || entry.mode === "structure" && ["binary", "generated-structure"].includes(kind)))
      errors.push(`Invalid artifact inspection: ${entry.file}`);
  } else {
    if (!Array.isArray(entry.lines) || entry.lines.length !== 2 || entry.lines.some(n => !Number.isSafeInteger(n))
      || entry.lines[0] < 1 || entry.lines[1] < entry.lines[0]) errors.push(`Invalid read range: ${entry.file}`);
    if (Array.isArray(entry.lines) && entry.sha256 === current.sha256 && entry.lines[1] > current.lines) errors.push(`Read beyond EOF: ${entry.file}`);
  }
  if (!entry.review?.trim()) errors.push(`Missing review notes: ${entry.file}`);
}
const coverage = inventory.map(entry => {
  const file = { file: entry.path, module: entry.module, kind: entry.kind };
  const removal = retired.get(entry.path);
  if (removal) return { ...file, status: "retired", commit: removal.commit, reason: removal.reason };
  const current = requiredData(entry.path);
  if (!current) return { ...file, status: "missing" };
  const matching = ledger.filter(read => read.file === entry.path && read.sha256 === current.sha256);
  const inspection = matching.findLast(read => read.mode !== undefined);
  const ranges = matching.filter(read => read.mode === undefined).map(read => read.lines).sort((a, b) => a[0] - b[0]);
  let next = 1, readLines = 0;
  const unread = [];
  for (const [start, end] of ranges) {
    if (start > next) unread.push([next, start - 1]);
    if (end >= next) { readLines += end - Math.max(start, next) + 1; next = end + 1; }
  }
  if (next <= current.lines) unread.push([next, current.lines]);
  return { ...file, lines: current.lines, readLines,
    status: inspection ? "inspected" : !readLines ? "unread" : unread.length ? "partial" : "read",
    inspection: inspection?.mode, unread: inspection ? [] : unread,
    changedSinceBaseline: current.sha256 !== entry.sha256 };
});
const cases = [];
for (const requirement of requirements.requirements) {
  if (ids.has(requirement.id)) errors.push(`Duplicate ID: ${requirement.id}`); ids.add(requirement.id);
  if (!modules.has(requirement.module)) errors.push(`Unknown module: ${requirement.id}`);
  for (const item of requirement.cases) {
    if (ids.has(item.id)) errors.push(`Duplicate ID: ${item.id}`); ids.add(item.id);
    const implementation = (item.implementation ?? []).map(reference => {
      const current = requiredData(reference.file);
      return { ...reference, current: !!current && current.sha256 === reference.sha256 };
    });
    const implementationChanged = implementation.some(reference => !reference.current);
    const tests = item.tests.map(reference => {
      const current = requiredData(reference.file);
      const matching = runs.filter(result => result.file === reference.file && result.name === reference.name);
      const latest = matching.at(-1);
      return { ...reference, evidence: !current ? "missing-file" : !latest ? "not-run" : implementationChanged ? "stale-implementation"
        : latest.sha256 !== current.sha256 ? "stale-test" : latest.status };
    });
    // A passing mapped test is still not proof that a broad scenario is complete.
    if (!["partial", "verified"].includes(item.status)) errors.push(`Unknown case status: ${item.id}`);
    if (item.status === "partial" && !(typeof item.testGap === "string" && item.testGap.trim()))
      errors.push(`Partial case lacks test gap: ${item.id}`);
    if (item.status === "verified" && (!implementation.length || !tests.length || tests.some(result => result.evidence !== "passed")))
      errors.push(`Verified case lacks fresh passing evidence: ${item.id}`);
    cases.push({ id: item.id, status: item.status,
      ...(item.status === "partial" ? { testGap: item.testGap } : {}), implementation, tests });
  }
}
const functionIds = new Set();
for (const entry of functions) {
  const key = `${entry.file}:${entry.symbol}`, current = requiredData(entry.file);
  if (functionIds.has(key)) errors.push(`Duplicate function contract: ${key}`);
  functionIds.add(key);
  if (current && entry.sha256 !== current.sha256) errors.push(`Stale function contract: ${key}`);
  if (!entry.intent?.trim() || !entry.review?.trim() || !entry.cases?.length
    || entry.cases.some(id => !cases.some(item => item.id === id))) errors.push(`Missing function intent/evidence: ${key}`);
  if (!Array.isArray(entry.lines) || entry.lines.length !== 2 || entry.lines.some(n => !Number.isSafeInteger(n))
    || entry.lines[0] < 1 || entry.lines[1] < entry.lines[0] || (current && entry.lines[1] > current.lines))
    errors.push(`Invalid function read range: ${key}`);
}
console.log(JSON.stringify({ status: errors.length ? "invalid-evidence" : "in-progress",
  baseline: requirements.baseline, errors,
  summary: { baselineFiles: baselineInventory.length, addedFiles: inventory.length - baselineInventory.length,
    retiredFiles: retired.size, missingRequiredFiles: missing.size,
    fullyRead: coverage.filter(row => row.status === "read").length,
    artifactsInspected: coverage.filter(row => row.status === "inspected").length,
    partiallyRead: coverage.filter(row => row.status === "partial").length,
    unread: coverage.filter(row => row.status === "unread").length,
    cases: cases.length, casesWithTests: cases.filter(row => row.tests.length).length,
    verifiedCases: cases.filter(row => row.status === "verified").length },
  functionContracts: { recorded: functions.length, scope: "Selected manually reviewed functions only; not all-repository function coverage." },
  coverage, cases }, null, 2));
if (errors.length) process.exitCode = 1;
