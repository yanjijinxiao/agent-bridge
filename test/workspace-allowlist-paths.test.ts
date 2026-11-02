import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isWorkspaceAllowed } from "../src/state/config.js";

test("workspace allowlists compare real directory scope while preserving explicitly configured aliases", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-workspace-allowlist-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowed = path.join(root, "allowed"), outside = path.join(root, "outside"), alias = path.join(root, "alias");
  fs.mkdirSync(allowed); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(allowed, "escape")); fs.symlinkSync(allowed, alias);
  assert.equal(isWorkspaceAllowed(path.join(allowed, "escape"), [allowed]), false, "an existing link cannot widen the allowed root");
  assert.equal(isWorkspaceAllowed(path.join(allowed, "escape", "future"), [allowed]), false, "a missing child must use its real existing parent");
  assert.equal(isWorkspaceAllowed(allowed, [alias]), true, "a configured alias explicitly grants that real directory");
  assert.equal(isWorkspaceAllowed(path.join(allowed, "new", "child"), [allowed]), true, "ordinary future subdirectories remain supported");
  assert.equal(isWorkspaceAllowed(path.join(root, "allowed-sibling"), [allowed]), false);
  fs.symlinkSync(path.join(outside, "not-created"), path.join(allowed, "dangling"));
  assert.equal(isWorkspaceAllowed(path.join(allowed, "dangling", "child"), [allowed]), false, "unknown dangling targets cannot grant access");
});
