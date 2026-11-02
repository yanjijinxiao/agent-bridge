import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { normalizeAccountId, saveAccount, listAccounts } from "../src/weixin/accounts.js";

for (const id of [".", "..", ""]) test(`an account id cannot alias the shared runtime or its parent (${JSON.stringify(id)})`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-account-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  assert.throws(() => accountStatePaths(paths, id), /account|账号/i);
  assert.throws(() => saveAccount(paths, { accountId: id, token: "synthetic", baseUrl: "https://isolated.invalid",
    cdnBaseUrl: "https://isolated.invalid", enabled: true, savedAt: "" }));
  assert.deepEqual(listAccounts(paths), []);
});

test("valid normalized account identities remain stable for existing installations", () => {
  assert.equal(normalizeAccountId("hermes-dingtalk"), "hermes-dingtalk");
  assert.equal(normalizeAccountId("actor@wechat"), "actor-wechat");
});
