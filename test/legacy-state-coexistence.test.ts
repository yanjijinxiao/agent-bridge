import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { IDEAuthorization } from "../src/ide/authorization.js";
import { loadConfig, saveConfig } from "../src/state/config.js";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import {
  LEGACY_HERMES_DINGTALK_CARD_TEMPLATE_ID, STREAMING_DINGTALK_CARD_TEMPLATE_ID,
  loadAccount, migrateLegacyDingTalkCardProfiles, saveAccount
} from "../src/weixin/accounts.js";

test("joint legacy IDE, account, runtime and receipt migration preserves exactly the original authority on two cold starts", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-joint-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const app = "test-bot";
  saveAccount(paths, { channel: "dingtalk", accountId: app, clientId: "provider", clientSecret: "fixture",
    enabled: false, savedAt: new Date().toISOString(), cardTemplateId: LEGACY_HERMES_DINGTALK_CARD_TEMPLATE_ID });
  const local = accountStatePaths(paths, app);
  const initial = new RuntimeStateStore(local);
  const project = initial.createProject("fixture", root);
  const session = initial.createSession("chat", root, "legacy project thread", project.id);
  initial.setSessionThread(session.id, "original-thread");
  initial.setPairedSenderIds(["owner"]);
  initial.setRole("chat", "owner", "controller");
  initial.setRole("chat", "reader", "viewer");
  const old = JSON.parse(fs.readFileSync(local.statePath, "utf8"));
  delete old.firstContacts;
  old.processedMessageIds = ["old-input"];
  fs.writeFileSync(local.statePath, JSON.stringify(old));
  fs.writeFileSync(paths.configPath, JSON.stringify({ codexBackend: "exec", codexExecutionOwner: "desktop",
    allowedSenderIds: ["owner"], codexExecSandbox: "workspace-write" }));
  const authFile = path.join(root, "ide", "authorization.json");
  fs.mkdirSync(path.dirname(authFile));
  const grant = new IDEAuthorization(() => 1000, authFile, "original-origin");
  const browser = grant.consume(grant.grant("project", "old-scope"), "project", "old-scope")!;
  assert.equal(JSON.parse(fs.readFileSync(authFile, "utf8")).version, 1);
  const current = "v2:" + createHash("sha256").update("current-scope").digest("hex");
  const undo = (origin: string) => new IDEAuthorization(() => 2000, authFile, origin, undefined,
    () => ({ current, legacy: "old-scope" }));
  let submitted = 0;
  for (const pass of [1, 2]) {
    assert.equal(migrateLegacyDingTalkCardProfiles(paths).length, pass === 1 ? 1 : 0);
    const account = loadAccount(paths, app);
    assert.ok(account.channel === "dingtalk");
    assert.equal(account.cardTemplateId, STREAMING_DINGTALK_CARD_TEMPLATE_ID);
    assert.equal(account.enabled, false);
    assert.equal(account.clientId, "provider");
    const config = loadConfig(paths);
    assert.deepEqual(config.allowedSenderIds, ["owner"]);
    assert.equal(config.codexExecSandbox, "workspace-write");
    saveConfig(paths, config);
    const runtime = new RuntimeStateStore(local);
    assert.equal(runtime.getBoundSession("chat")?.threadId, "original-thread");
    assert.equal(runtime.getActiveProject("chat")?.id, project.id);
    assert.deepEqual(runtime.snapshot.pairedSenderIds, ["owner"]);
    assert.equal(runtime.roleFor("chat", "owner"), "controller");
    assert.equal(runtime.roleFor("chat", "reader"), "viewer");
    assert.equal(runtime.roleFor("chat", "stranger"), undefined);
    const receipts = new InboundReceiptJournal(path.join(path.dirname(local.statePath), "inbound-receipts.jsonl"), runtime.snapshot.processedMessageIds);
    await receipts.handle({ id: "old-input", senderId: "owner", replyTargetId: "chat" }, async () => { submitted++; });
    const auth = undo("original-origin");
    const retained = auth.authenticate(browser.token, "project", current);
    assert.equal(retained?.expiresAt, browser.session.expiresAt);
    assert.equal(auth.rememberBrowser(retained!), undefined);
    assert.equal(auth.authenticate(browser.token, "other", current), undefined);
    assert.equal(auth.authenticate(browser.token, "project", "other-scope"), undefined);
    assert.equal(undo("another-origin").authenticate(browser.token, "project", current), undefined);
  }
  assert.equal(submitted, 0);
});
