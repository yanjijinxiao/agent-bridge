import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { readDesktopCatalogGroups, desktopCatalogGroupId } from "../src/codex/desktop-catalog-groups.js";
import { orderSessionCatalog } from "../src/bridge/session-catalog-order.js";
import { sessionCatalogItems } from "../src/bridge/session-catalog-view.js";
import type { CodexThreadState, CodexProject } from "../src/codex/backend.js";

const host = "remote-ssh-discovered:test", root = "/remote/worktree";
const project: CodexProject = { id: "native-project", name: "Project", roots: [root] };
const state = (id = "old", projectId?: string): CodexThreadState => ({ threadId: id, cwd: root, title: id,
  persistence: "active", runtimeStatus: "idle", activeFlags: [], projectMembership: projectId ? "assigned" : "none", ...(projectId ? { projectId } : {}) });
function fixture(t: any, modify: (value: any) => void = () => {}, catalogHost = host) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-legacy-groups-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = {
    ...(catalogHost === "local" ? { "local-projects": { legacy: { id: "legacy", rootPaths: [root] } } }
      : { "remote-projects": [{ id: "legacy", hostId: catalogHost, remotePath: root }] }),
    "thread-project-assignments": { old: { projectId: "legacy", hostId: catalogHost } },
    "thread-project-membership-host-ids": { assigned: catalogHost }
  } as any;
  modify(data);
  const filename = path.join(home, ".codex-global-state.json"); fs.writeFileSync(filename, JSON.stringify(data));
  fs.mkdirSync(path.join(home, "sqlite"));
  const db = new DatabaseSync(path.join(home, "sqlite/codex.db"));
  db.exec(`CREATE TABLE local_thread_catalog_hosts(host_id TEXT, host_kind TEXT);
    CREATE TABLE local_thread_catalog_sync_state(host_id TEXT, initial_build_complete INTEGER);
    CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,display_title TEXT,cwd TEXT,project_id TEXT,
      source_updated_at REAL,source_recency_at REAL,source_created_at REAL,source_kind TEXT,thread_source TEXT,missing_candidate INTEGER)`);
  db.prepare("INSERT INTO local_thread_catalog_hosts VALUES(?,?)").run(catalogHost, "remote");
  db.prepare("INSERT INTO local_thread_catalog_sync_state VALUES(?,1)").run(catalogHost);
  db.prepare("INSERT INTO local_thread_catalog VALUES(?,?,?,?,NULL,100,100,90,'vscode','user',0)").run(catalogHost, "old", "Old App conversation", root);
  db.close();
  return { home, data, filename };
}

test("CAT-02.6: current legacy App assignment supplies a display group without changing native membership", t => {
  const { home } = fixture(t), snapshot = readDesktopCatalogGroups(home, host), input = state();
  const before = structuredClone(input);
  assert.equal(desktopCatalogGroupId(input, snapshot.groups, [project]), project.id);
  assert.deepEqual(input, before);
  assert.equal(input.projectId, undefined); assert.equal(input.projectMembership, "none");
  assert.equal(desktopCatalogGroupId(state("old", "moved-native"), snapshot.groups, [project]), undefined);
});

for (const boundary of ["native-synced", "other-synced-host", "projectless", "explicit-none", "other-assignment-host", "other-project-host", "sidebar-only", "cwd-only", "backup-only", "relative-roots"]) {
  test(`CAT-02.6: ${boundary} does not revive a legacy App group`, t => {
    const { home, filename } = fixture(t, value => {
      if (boundary === "native-synced") value["thread-project-membership-host-ids"].old = host;
      if (boundary === "other-synced-host") value["thread-project-membership-host-ids"].old = "another-host";
      if (boundary === "projectless") value["projectless-thread-ids"] = ["old"];
      if (boundary === "explicit-none") value["thread-project-assignments"].old.projectId = null;
      if (boundary === "other-assignment-host") value["thread-project-assignments"].old.hostId = "another-host";
      if (boundary === "other-project-host") value["remote-projects"][0].hostId = "another-host";
      if (boundary === "relative-roots") value["remote-projects"][0].remotePath = "relative";
      if (boundary === "sidebar-only" || boundary === "cwd-only") {
        delete value["thread-project-assignments"].old;
        if (boundary === "sidebar-only") value["sidebar-project-thread-orders"] = { legacy: { threadIds: ["old"] } };
      }
    });
    if (boundary === "backup-only") fs.renameSync(filename, filename + ".bak");
    const snapshot = readDesktopCatalogGroups(home, host);
    assert.equal(desktopCatalogGroupId(state(), snapshot.groups, [project]), undefined);
  });
}

test("CAT-02.6: explicit alias beats root ambiguity and a deleted alias cannot change to a same-root project", t => {
  const { home } = fixture(t);
  // The namespace is the exact device host/home pair, never another account's home.
  const file = path.join(home, ".codex-global-state.json"), value = JSON.parse(fs.readFileSync(file, "utf8"));
  value["app-server-project-id-by-legacy-project-id-by-host"] = { [`${host}:${home}`]: { legacy: project.id } };
  fs.writeFileSync(file, JSON.stringify(value));
  const { groups } = readDesktopCatalogGroups(home, host), other = { ...project, id: "other-project" };
  assert.equal(desktopCatalogGroupId(state(), groups, [project, other]), project.id);
  assert.equal(desktopCatalogGroupId(state(), groups, [other]), undefined);
});

test("CAT-02.6: ambiguous or partial root sets stay ungrouped; complete root sets preserve independent projects", t => {
  const { home } = fixture(t), { groups } = readDesktopCatalogGroups(home, host);
  assert.equal(desktopCatalogGroupId(state(), groups, [project, { ...project, id: "same-roots" }]), undefined);
  assert.equal(desktopCatalogGroupId(state(), groups, [{ ...project, roots: [root, "/sibling"] }]), undefined);
  assert.equal(desktopCatalogGroupId(state(), groups, [{ ...project, roots: ["/different"] }]), undefined);
});

test("CAT-02.6: local multi-root legacy groups match the whole registered root set independently of thread cwd", t => {
  const { home } = fixture(t, v => { v["local-projects"].legacy.rootPaths = [root, "/sibling"]; }, "local");
  const { groups } = readDesktopCatalogGroups(home, "local");
  assert.equal(desktopCatalogGroupId({ ...state(), cwd: "/another/worktree" }, groups, [{ ...project, roots: ["/sibling/", root] }]), project.id);
  assert.equal(desktopCatalogGroupId(state(), groups, [project]), undefined);
});

for (const published of ["absent", "missing", "other-host", "exec"]) test(`CAT-02.6: ${published} App catalog evidence cannot revive a global-state-only assignment`, t => {
  const { home } = fixture(t), file = path.join(home, "sqlite/codex.db");
  if (published === "absent") fs.unlinkSync(file);
  else {
    const db = new DatabaseSync(file);
    if (published === "missing") db.exec("UPDATE local_thread_catalog SET missing_candidate=1");
    if (published === "other-host") db.exec("UPDATE local_thread_catalog SET host_id='other-host'");
    if (published === "exec") db.exec("UPDATE local_thread_catalog SET source_kind='exec'");
    db.close();
  }
  assert.equal(readDesktopCatalogGroups(home, host).groups.size, 0);
});

test("CAT-02.6: stable and dev App catalogs must agree; no account or database is guessed", t => {
  const { home } = fixture(t), first = path.join(home, "sqlite/codex.db"), second = path.join(home, "sqlite/codex-dev.db");
  fs.copyFileSync(first, second);
  assert.equal(readDesktopCatalogGroups(home, host).groups.size, 1);
  const db = new DatabaseSync(second); db.exec("UPDATE local_thread_catalog SET missing_candidate=1"); db.close();
  assert.equal(readDesktopCatalogGroups(home, host).groups.size, 0);
});

function runner(t: any, modify?: (v: any) => void, failProjects = false) {
  const f = fixture(t, modify), wire = new AppServerCodexRunner({ codexHome: f.home, hostId: host, catalogSource: "native" }) as any;
  const calls: string[] = [];
  wire.ensureConnected = async () => {}; wire.recyclePrivateTransportIfIdle = async () => {};
  wire.request = async (method: string, params: any) => {
    calls.push(method);
    if (method === "thread/list") return { data: [
      { id: "old", name: "Old App conversation", projectId: null, cwd: root, status: { type: "idle" }, updatedAt: 100 },
      { id: "assigned", name: "New native conversation", projectId: project.id, cwd: root, status: { type: "idle" }, updatedAt: 90 }
    ], nextCursor: null };
    if (method === "project/list") {
      if (failProjects) throw Error("offline project metadata");
      return { data: [{ id: project.id, name: project.name, roots: project.roots.map(path => ({ path })) }], nextCursor: null };
    }
    if (method === "thread/read") return { thread: { id: params.threadId, projectId: null, cwd: root, status: { type: "idle" }, turns: [] } };
    throw Error("Unexpected mutation " + method);
  };
  return { ...f, wire, calls };
}

test("CAT-02.6: old remote conversation remains beside its native project peer in the rendered tree", async t => {
  const f = runner(t), catalog = await f.wire.listSessionCatalog();
  assert.equal(catalog.threads[0].workspaceProjectId, project.id);
  assert.equal(catalog.threads[0].projectId, undefined);
  assert.equal(catalog.threads[0].projectMembership, "none");
  const candidates = [{ projectId: project.id, name: project.name, workspace: root, hostId: host, lastUsedAt: "", sessionCount: 1 }];
  const rows = orderSessionCatalog(catalog.threads.map((s: any) => ({ state: s, hostId: host })), candidates, []);
  const items = sessionCatalogItems(rows, candidates, { includeEmpty: true, incompleteHosts: new Map() });
  assert.deepEqual(rows.map(r => r.group?.name), ["Project", "Project"]);
  assert.deepEqual(items.map(i => i.kind === "session" ? [i.number, i.section] : i.kind), [[1, "project"], [2, "project"]]);
  assert.deepEqual(f.calls, ["thread/list", "project/list"]);
  assert.equal((f.wire.threadStates.get("old") as CodexThreadState).workspaceProjectId, undefined, "the execution-state cache is not the display projection");
  const inspected = await f.wire.inspectThread("old");
  assert.equal(inspected.projectId, undefined); assert.equal(inspected.workspaceProjectId, undefined); assert.equal(inspected.projectMembership, "none");
});

test("CAT-02.6: project catalog filters and limits run after display grouping while native lists keep their scope", async t => {
  const f = runner(t);
  const catalog = await f.wire.listSessionCatalog({ projectId: project.id, limit: 1 });
  assert.deepEqual(catalog.threads.map((s: any) => s.threadId), ["old"]);
  const native = await f.wire.listThreads({ projectId: project.id });
  assert.deepEqual(native.map((s: any) => s.threadId), ["assigned"]);
  const unassigned = await f.wire.listSessionCatalog({ unassigned: true });
  assert.deepEqual(unassigned.threads.map((s: any) => s.threadId), ["old"], "unassigned still means native membership, independently of display grouping");
});

test("CAT-02.6: project lookup failure retains native rows with a precise display warning", async t => {
  const f = runner(t, undefined, true), result = await f.wire.listSessionCatalog();
  assert.equal(result.threads.length, 2); assert.equal(result.complete, true);
  assert.equal(result.threads[0].workspaceProjectId, undefined);
  assert.match(result.warnings.join("\n"), /旧分组未补齐/);
});

test("CAT-02.6: a CLI without an App registry needs no additional project request", async t => {
  const f = runner(t); fs.unlinkSync(f.filename);
  const result = await f.wire.listSessionCatalog();
  assert.equal(result.threads[0].workspaceProjectId, undefined); assert.deepEqual(result.warnings, []);
  assert.deepEqual(f.calls, ["thread/list"]);
});

test("CAT-02.6: a later native membership synchronization retires the old display group on refresh", async t => {
  const f = runner(t);
  assert.equal((await f.wire.listSessionCatalog()).threads[0].workspaceProjectId, project.id);
  f.data["thread-project-membership-host-ids"].old = host; fs.writeFileSync(f.filename, JSON.stringify(f.data));
  const result = await f.wire.listSessionCatalog();
  assert.equal(result.threads[0].workspaceProjectId, undefined); assert.equal(result.threads[0].projectMembership, "none");
});

test("CAT-02.6: malformed current App data never falls back to a stale assignment backup", t => {
  const { home, filename } = fixture(t); fs.copyFileSync(filename, filename + ".bak"); fs.writeFileSync(filename, "{torn");
  const snapshot = readDesktopCatalogGroups(home, host);
  assert.equal(snapshot.groups.size, 0); assert.match(snapshot.warning!, /暂不可读/);
});
