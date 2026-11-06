import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJsonFile } from "../state/json-store.js";
import { NPM_PACKAGE_NAME, LEGACY_NPM_PACKAGE_NAME } from "../runtime/product.js";

export type NpmReleasePlan = {
  format: 1; version: string; target: string; candidate: string; backup: string;
  previousVersion: string; previousEntryHash: string; candidateHash: string;
  phase: "prepared" | "backing-up" | "activating" | "active" | "verified" | "rolling-back" | "rolled-back";
};
const entry = (root: string) => path.join(root, "dist", "server", "index.js");
const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export const npmCandidateRoot = (directory: string, platform: NodeJS.Platform = process.platform) =>
  path.join(directory, ...(platform === "win32" ? [] : ["lib"]), "node_modules", ...NPM_PACKAGE_NAME.split("/"));

/** npm installs into a fresh prefix, with global layout to keep dependencies
 * inside the package. The existing prefix and bin links are never npm's target. */
export function createNpmReleaseDirectory(packageRoot: string): string {
  const parent = fs.realpathSync(path.dirname(packageRoot));
  if (fs.lstatSync(packageRoot).isSymbolicLink()) throw new Error("npm update requires a concrete runtime directory");
  return fs.mkdtempSync(path.join(parent, ".codex-im-gateway-update-"));
}

export function runtimeVersion(root: string): string {
  const value = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version) || !fs.statSync(entry(root)).isFile())
    throw new Error("Prepared npm runtime has no valid version or server entry");
  return value.version;
}

/** Seal all candidate bytes, modes and symlink targets, not only package.json.
 * Relative internal links from npm are allowed; links escaping the package are
 * not a self-contained release and cannot be safely activated independently. */
export function npmRuntimeDigest(root: string): string {
  const digest = crypto.createHash("sha256");
  const walk = (relative: string) => {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    digest.update(JSON.stringify([relative, stat.mode & 0o777, stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file"]));
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(file), resolved = path.resolve(path.dirname(file), link), inside = path.relative(root, resolved);
      if (path.isAbsolute(link) || inside === ".." || inside.startsWith(`..${path.sep}`)) throw new Error("Prepared npm runtime contains an external symlink");
      digest.update(link);
    } else if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    else if (stat.isFile()) digest.update(fs.readFileSync(file));
    else throw new Error("Prepared npm runtime contains a non-file");
  };
  walk(""); return digest.digest("hex");
}

export function sealNpmRelease(directory: string, target: string, version: string, platform: NodeJS.Platform = process.platform): string {
  const candidate = npmCandidateRoot(directory, platform);
  if (runtimeVersion(candidate) !== version) throw new Error("Prepared npm runtime version mismatch");
  const plan: NpmReleasePlan = { format: 1, version, target: fs.realpathSync(target), candidate,
    backup: path.join(directory, "previous-package"), previousVersion: runtimeVersion(target), previousEntryHash: hash(entry(target)),
    candidateHash: npmRuntimeDigest(candidate), phase: "prepared" };
  const file = path.join(directory, "release.json"); writeJsonFile(file, plan, { durable: true }); return file;
}

export function readNpmRelease(file: string): NpmReleasePlan {
  if (!path.isAbsolute(file) || path.basename(file) !== "release.json") throw new Error("Invalid npm release plan");
  const directory = path.dirname(file), parent = path.dirname(directory), plan = JSON.parse(fs.readFileSync(file, "utf8")) as NpmReleasePlan;
  const [scope, name] = NPM_PACKAGE_NAME.split("/");
  const expectedTarget = path.basename(parent) === scope ? path.join(parent, name) : path.join(parent, LEGACY_NPM_PACKAGE_NAME);
  // Accept already prepared legacy plans while newly prepared releases use
  // the scoped npm package. Neither format may point outside its own prefix.
  const candidates = [npmCandidateRoot(directory, "win32"), npmCandidateRoot(directory, "linux"),
    path.join(directory, "node_modules", LEGACY_NPM_PACKAGE_NAME), path.join(directory, "lib", "node_modules", LEGACY_NPM_PACKAGE_NAME)];
  if (fs.lstatSync(directory).isSymbolicLink() || !path.basename(directory).startsWith(".codex-im-gateway-update-")
    || plan.format !== 1 || plan.target !== expectedTarget
    || !candidates.includes(plan.candidate)
    || plan.backup !== path.join(directory, "previous-package") || !/^[a-f0-9]{64}$/.test(plan.candidateHash)
    || !/^[a-f0-9]{64}$/.test(plan.previousEntryHash)
    || !["prepared", "backing-up", "activating", "active", "verified", "rolling-back", "rolled-back"].includes(plan.phase))
    throw new Error("Invalid npm release plan");
  return plan;
}

/** Call only after the owning Gateway has exited. Persist intent before each
 * rename, so retry can distinguish an absent target from a lost old runtime. */
export function activateNpmRelease(file: string): NpmReleasePlan {
  const plan = readNpmRelease(file);
  if (["rolling-back", "rolled-back"].includes(plan.phase)) throw new Error("Npm release has been rolled back");
  if (plan.phase === "active" || plan.phase === "verified") return plan;
  if (fs.existsSync(plan.candidate)) {
    if (runtimeVersion(plan.candidate) !== plan.version || npmRuntimeDigest(plan.candidate) !== plan.candidateHash)
      throw new Error("Prepared npm runtime changed after verification");
  }
  if (plan.phase === "prepared" || plan.phase === "backing-up") {
    if (!fs.existsSync(plan.backup)) {
      if (runtimeVersion(plan.target) !== plan.previousVersion || hash(entry(plan.target)) !== plan.previousEntryHash)
        throw new Error("Current npm runtime changed after preparation");
      plan.phase = "backing-up"; writeJsonFile(file, plan, { durable: true });
      fs.renameSync(plan.target, plan.backup);
    } else if (fs.existsSync(plan.target)) throw new Error("Ambiguous npm runtime backup; original files preserved");
    plan.phase = "activating"; writeJsonFile(file, plan, { durable: true });
  }
  if (plan.phase === "activating") {
    if (!fs.existsSync(plan.target)) fs.renameSync(plan.candidate, plan.target);
    if (runtimeVersion(plan.target) !== plan.version || npmRuntimeDigest(plan.target) !== plan.candidateHash)
      throw new Error("Activated npm runtime does not match the prepared release");
    plan.phase = "active"; writeJsonFile(file, plan, { durable: true });
  }
  return plan;
}

export function confirmNpmRelease(file: string): void {
  const plan = readNpmRelease(file);
  if (plan.phase !== "active") throw new Error("Npm release is not active");
  plan.phase = "verified"; writeJsonFile(file, plan, { durable: true });
}

/** Roll back program bytes only. Never restore Gateway state, permissions,
 * native inputs or channel receipts, which may have advanced independently. */
export function rollbackNpmRelease(file: string): void {
  const plan = readNpmRelease(file);
  if (plan.phase === "rolled-back") return;
  if (!fs.existsSync(plan.backup)) {
    if (runtimeVersion(plan.target) !== plan.previousVersion || hash(entry(plan.target)) !== plan.previousEntryHash)
      throw new Error("Original npm runtime unavailable; no files were removed");
  } else {
    plan.phase = "rolling-back"; writeJsonFile(file, plan, { durable: true });
    if (fs.existsSync(plan.target)) {
      const failed = path.join(path.dirname(file), "failed-package");
      if (fs.existsSync(failed)) throw new Error("Failed npm runtime already retained; inspect release plan");
      fs.renameSync(plan.target, failed);
    }
    fs.renameSync(plan.backup, plan.target);
  }
  plan.phase = "rolled-back"; writeJsonFile(file, plan, { durable: true });
}
