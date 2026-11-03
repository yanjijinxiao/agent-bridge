import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedWorkspacePortal } from "../src/peer/workspace-portal.js";
import type { PeerRegistry } from "../src/peer/registry.js";
import type { SharedBrowserRef } from "../src/peer/sharing-gateway.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-portal-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "portal.json"), grants = new Map<string, any>();
  const registry = { grantsFor() { return [...grants.values()]; }, sharing: {} } as unknown as PeerRegistry;
  const options = { host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", stateFile: file };
  const portal = new SharedWorkspacePortal(registry, options);
  function ref(index: number): SharedBrowserRef {
    return { principal: { accountId: "account", conversationId: "chat", actorId: "actor" }, target: { hostId: "host", threadId: `thread-${index}` }, grantId: `grant-${index}`, resourceId: `resource-${index}` };
  }
  function grant(index: number) {
    const r = ref(index); grants.set(r.grantId, { id: r.grantId, hostId: "host", threadId: r.target.threadId, delegation: { resourceId: r.resourceId } }); return r;
  }
  return { file, portal, registry, options, grants, grant, ref };
}

test("failed portal persistence cannot consume the live entry limit", t => {
  const f = fixture(t); fs.mkdirSync(f.file);
  for (let i = 0; i < 200; i++) assert.throws(() => f.portal.entry(f.grant(i)));
  fs.rmdirSync(f.file);
  const url = f.portal.entry(f.grant(200)); assert.match(url, /\/shared\//);
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).entries.length, 1);
});
test("a full persisted portal prunes only explicitly absent grants and keeps stable live URLs", async t => {
  const f = fixture(t);
  const stable = f.portal.entry(f.grant(0));
  for (let i = 1; i < 200; i++) f.portal.entry(f.grant(i));
  await f.portal.close();
  const reopened = new SharedWorkspacePortal(f.registry, f.options);
  f.grants.delete("grant-1");
  const newUrl = reopened.entry(f.grant(200)); assert.notEqual(newUrl, stable);
  assert.equal(reopened.entry(f.ref(0)), stable);
  const rows = JSON.parse(fs.readFileSync(f.file, "utf8")).entries;
  assert.equal(rows.length, 200); assert.equal(rows.some(([, r]: any) => r.grantId === "grant-1"), false);
});
test("resource identity replacement retires only the old shared entry", t => {
  const f = fixture(t); const old = f.portal.entry(f.grant(0));
  f.grants.get("grant-0").delegation.resourceId = "replacement";
  const replacement = { ...f.ref(0), resourceId: "replacement" };
  assert.notEqual(f.portal.entry(replacement), old);
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).entries.length, 1);
});
test("live entries survive restart and the capacity limit never suggests that restart clears them", async t => {
  const f = fixture(t); const stable = f.portal.entry(f.grant(0));
  for (let i = 1; i < 200; i++) f.portal.entry(f.grant(i));
  await f.portal.close();
  const reopened = new SharedWorkspacePortal(f.registry, f.options);
  assert.equal(reopened.entry(f.ref(0)), stable);
  assert.throws(() => reopened.entry(f.grant(200)), error => {
    assert.match(String(error), /共享入口过多/); assert.doesNotMatch(String(error), /重启/); return true;
  });
});
