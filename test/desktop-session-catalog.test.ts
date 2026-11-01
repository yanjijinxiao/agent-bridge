import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readDesktopSessionCatalog, isDesktopCatalogThread } from "../src/codex/desktop-session-catalog.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";

function fixture(t: { after(fn: () => void): void }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-desktop-catalog-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "sqlite"));
  const file = path.join(home, "sqlite", "codex-dev.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE local_thread_catalog_hosts(host_id TEXT,host_kind TEXT);
    CREATE TABLE local_thread_catalog_sync_state(host_id TEXT,initial_build_complete INTEGER);
    CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,display_title TEXT,cwd TEXT,source_kind TEXT,
      thread_source TEXT,source_updated_at REAL,source_recency_at REAL,source_created_at REAL,missing_candidate INTEGER);
    INSERT INTO local_thread_catalog_hosts VALUES('local','local'),('remote','ssh'),('chatgpt-account','chatgpt');
    INSERT INTO local_thread_catalog_sync_state VALUES('local',1),('remote',1);`);
  const add = (id: string, host = "local", source = "vscode", missing = 0, title = id, cwd = "/repo") => db.prepare(
    "INSERT INTO local_thread_catalog(host_id,thread_id,display_title,cwd,source_kind,thread_source,source_updated_at,source_recency_at,source_created_at,missing_candidate) VALUES(?,?,?,?,?,NULL,100,100,100,?)"
  ).run(host, id, title, cwd, source, missing);
  t.after(() => db.close());
  return { home, file, db, add };
}

test("Desktop catalog is authoritative, host scoped, complete beyond 100 rows and read-only", t => {
  const { home, file, add } = fixture(t);
  for (let i = 0; i < 135; i++) add(`task-${i}`);
  add("same-id"); add("same-id", "remote");
  add("READY-task", "local", "vscode", 0, "Reply exactly READY.");
  add("exec-only", "local", "exec"); add("deleted-or-archived", "local", "vscode", 1);
  add("chat", "chatgpt-account", "chatgpt");
  const before = fs.readFileSync(file);
  const catalog = readDesktopSessionCatalog(home)!;
  assert.equal(catalog.source, "desktop-catalog");
  assert.equal(catalog.complete, true);
  assert.equal(catalog.threads.length, 137);
  assert.deepEqual(catalog.hostIds, ["local", "remote"]);
  assert.equal(catalog.threads.filter(t => t.threadId === "same-id").length, 1);
  assert.ok(catalog.threads.some(t => t.title === "Reply exactly READY."));
  assert.ok(catalog.threads.every(t => t.runtimeStatus === "unknown"));
  assert.match(catalog.warnings.join("\n"), /1 个 ChatGPT/);
  assert.equal(readDesktopSessionCatalog(home, "remote")!.threads.length, 1);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("Desktop membership uses legacy roots without absorbing explicit independent tasks", t => {
  const { home, add } = fixture(t);
  add("old-project-task"); add("independent"); add("moved"); add("nested", "local", "vscode", 0, "nested", "/repo/subdir");
  add("boundary", "local", "vscode", 0, "boundary", "/repo-other");
  add("remote-task", "remote", "vscode", 0, "remote", "/repo");
  fs.writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { p: { rootPaths: ["/repo"] }, p2: { rootPaths: ["/other"] } },
    "remote-projects": [{ id: "rp", hostId: "remote", remotePath: "/repo" }],
    "projectless-thread-ids": ["independent", "moved"],
    "sidebar-project-thread-orders": { p: { threadIds: ["independent", "moved"] } },
    "thread-project-assignments": { moved: { projectId: "p2" } }
  }));
  const rows = readDesktopSessionCatalog(home)!.threads;
  assert.equal(rows.find(r => r.threadId === "old-project-task")?.projectId, "p");
  assert.equal(rows.find(r => r.threadId === "nested")?.projectId, "p");
  assert.equal(rows.find(r => r.threadId === "independent")?.projectId, undefined);
  assert.equal(rows.find(r => r.threadId === "boundary")?.projectId, undefined);
  assert.equal(rows.find(r => r.threadId === "moved")?.projectId, "p2");
  assert.equal(readDesktopSessionCatalog(home, "remote")!.threads[0].projectId, "rp");
  assert.equal(readDesktopSessionCatalog(home, "local", { projectId: "p", limit: 1 })!.threads.length, 1);
  assert.deepEqual(readDesktopSessionCatalog(home, "local", { unassigned: true })!.threads.map(r => r.threadId), ["boundary", "independent"]);
});

test("local lifecycle tombstones override stale Desktop catalog entries without reviving them", t => {
  const { home, add } = fixture(t);
  add("active"); add("archived"); add("deleted");
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT, archived INTEGER); INSERT INTO threads VALUES('active',0),('archived',1)"); db.close();
  assert.deepEqual(readDesktopSessionCatalog(home)!.threads.map(r => r.threadId), ["active"]);
});

test("incomplete, missing, incompatible and ambiguous Desktop catalogs are not reported as full App lists", t => {
  const { home, file, db, add } = fixture(t); add("a");
  db.exec("UPDATE local_thread_catalog_sync_state SET initial_build_complete=0 WHERE host_id='local'");
  assert.equal(readDesktopSessionCatalog(home)!.complete, false);
  assert.match(readDesktopSessionCatalog(home)!.warnings.join("\n"), /不是完整列表/);
  assert.throws(() => readDesktopSessionCatalog(home, "unknown"), /尚未收录/);
  fs.copyFileSync(file, path.join(home, "sqlite", "codex.db"));
  assert.throws(() => readDesktopSessionCatalog(home), /多个/);
  fs.unlinkSync(path.join(home, "sqlite", "codex.db"));
  db.exec("DROP TABLE local_thread_catalog_sync_state");
  assert.throws(() => readDesktopSessionCatalog(home), /no such table/);
  assert.equal(readDesktopSessionCatalog(path.join(home, "absent")), undefined);
});

test("App catalog visibility rules are structural, never task-title heuristics", () => {
  assert.equal(isDesktopCatalogThread({ source: "vscode", name: "Reply exactly READY." }), true);
  assert.equal(isDesktopCatalogThread({ source: "exec", name: "Real CLI work" }), false);
  assert.equal(isDesktopCatalogThread({ source: { custom: "client" } }), true);
  for (const thread of [{ ephemeral: true }, { parentThreadId: "p" }, { threadSource: "ambient_suggestions" }, { threadSource: "pull_request_fix_automation" }, { source: { subAgentReview: {} } }])
    assert.equal(isDesktopCatalogThread(thread), false);
});

test("unified catalog reads native authority rather than choosing Desktop or CLI storage",async t=>{
 const {home,add}=fixture(t);add('stale-desktop');
 const {unifiedBackend}=await import('./fixtures/unified-backend.js');const f=unifiedBackend(t);
 assert.deepEqual((await f.gateway.listSessionCatalog()).threads.map(s=>s.threadId),['thread']);
 assert.deepEqual(f.calls.map(c=>c.method),['listSessionCatalog']);
});

test("older App fallback traverses native pages and labels storage/status provenance", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-old-app-catalog-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const runner = new AppServerCodexRunner({ codexHome: home, transport: { command: process.execPath, args: [path.resolve("test/fixtures/fake-codex-catalog.mjs")] } });
  t.after(() => runner.close());
  const catalog = await runner.listSessionCatalog();
  assert.equal(catalog.source, "app-server-storage");
  assert.deepEqual(catalog.threads.map(t => t.threadId), ["first", "second", "third"]);
  assert.ok(catalog.threads.every(t => t.runtimeStatus === "unknown"));
  assert.match(catalog.warnings.join("\n"), /不保证与 App 侧栏完全一致/);
});

test("headless App Server ignores stale Desktop catalogs and project assignments", async t => {
  const { home, add } = fixture(t); add("desktop-only");
  fs.writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { legacy: { id: "legacy", rootPaths: ["/tmp/shared"] } },
    "thread-project-assignments": { first: { projectId: "legacy" } }
  }));
  const runner = new AppServerCodexRunner({ codexHome: home, catalogSource: "native", transport: {
    command: process.execPath, args: [path.resolve("test/fixtures/fake-codex-catalog.mjs"), "--separate-archived"] } });
  t.after(() => runner.close());
  const catalog = await runner.listSessionCatalog();
  assert.equal(catalog.source, "app-server-storage"); assert.deepEqual(catalog.warnings, []);
  assert.ok(catalog.threads.some(thread => thread.threadId === "first"));
  assert.equal(catalog.threads.some(thread => thread.threadId === "desktop-only"), false);
  assert.equal(catalog.threads.some(thread => thread.threadId === "archived-native"), false, "unqualified native discovery defaults to active sessions");
  assert.notEqual((await runner.inspectThread("first")).projectId, "legacy");
});

test("auto session discovery pins App even when concurrent project enrichment fails", async t => {
  let rejectProjects!: (error: Error) => void;
  let cliCalls = 0;
  const router = new CodexBackendRouter({ backend: "auto",
    appServerBackend: { id: "app-server", capabilities: {}, close() {},
      listProjects: () => new Promise((_resolve, reject) => { rejectProjects = reject; }),
      async listSessionCatalog() { return { backend: "app-server", source: "desktop-catalog", threads: [], hostIds: ["local"], complete: true, warnings: [] }; }
    } as never,
    execBackend: { id: "exec", close() {}, async listProjects() { cliCalls++; return { backend: "exec", projects: [] }; } } as never
  });
  t.after(() => router.close());
  const projects = router.listProjects();
  assert.equal((await router.listSessionCatalog()).source, "desktop-catalog");
  rejectProjects(new Error("App project names unavailable"));
  await assert.rejects(projects, /App project names unavailable/);
  assert.equal(router.backendInfo().id, "app-server");
  assert.equal(cliCalls, 0);
});

test("sessions uses backend catalog, discovers hosts without projects, and deduplicates warnings", async t => {
  const { home } = fixture(t);
  const texts: string[] = [], calls: string[] = [];
  const service = new BridgeService({
    stateStore: new RuntimeStateStore(resolveStatePaths(path.join(home, "gateway"))),
    config: { ...defaultConfig(home), codexBackend: "app-server", allowedSenderIds: ["alice"] },
    listCodexProjects: () => [],
    weixin: { async sendText(x) { texts.push(x.text); return { messageId: "m" }; } },
    runner: {
      async listThreads() { throw new Error("Must not merge physical storage"); },
      async listSessionCatalog(_input: unknown, hostId: string) {
        calls.push(hostId); return { backend: "app-server", source: "desktop-catalog", hostIds: ["local", "remote"], complete: true,
          warnings: ["来源：App目录"], threads: [{ threadId: "same-id", title: `${hostId} task`, cwd: "/repo", persistence: "active", runtimeStatus: "unknown", activeFlags: [] }] };
      }
    } as never
  });
  await service.handleMessage({ senderId: "alice", id: "m", text: "/sessions", raw: {} });
  assert.deepEqual(calls, ["local", "remote"]);
  assert.match(texts.at(-1)!, /2 个/);
  assert.match(texts.at(-1)!, /local task/); assert.match(texts.at(-1)!, /remote task/);
  assert.equal(texts.at(-1)!.match(/来源：App目录/g)?.length, 1);
});

test("native project membership overrides a stale legacy assignment and resolves exact host/home migration aliases", t => {
  const { home, db, add } = fixture(t);
  db.exec("ALTER TABLE local_thread_catalog ADD COLUMN project_id TEXT");
  add("moved-native"); add("legacy-assigned"); add("independent"); add("remote-task", "remote");
  db.exec("UPDATE local_thread_catalog SET project_id='native-p' WHERE thread_id='moved-native'");
  fs.writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { p: { rootPaths: ["/repo"] }, p2: { rootPaths: ["/other"] } },
    "remote-projects": [{id: "rp", hostId: "remote", remotePath: "/remote"}],
    "app-server-project-id-by-legacy-project-id-by-host": { [`local:${home}`]: {p: "native-p"}, [`local:/other-home`]: {p2: "native-p"} },
    "thread-project-assignments": { "moved-native": { projectId: "p2" }, "legacy-assigned": { projectId: "native-p" },
      "remote-task": { projectId: "native-p" } },
    "projectless-thread-ids": ["independent"]
  }));
  const rows = readDesktopSessionCatalog(home)!.threads;
  assert.equal(rows.find(r => r.threadId === "moved-native")?.projectId, "p");
  assert.equal(rows.find(r => r.threadId === "moved-native")?.projectMembership, "assigned");
  assert.equal(rows.find(r => r.threadId === "legacy-assigned")?.projectId, "p");
  assert.equal(rows.find(r => r.threadId === "independent")?.projectMembership, "none");
  assert.equal(readDesktopSessionCatalog(home, "remote")!.threads[0].projectId, undefined, "local migration aliases cannot assign a remote thread");
  assert.equal(readDesktopSessionCatalog(home, "local", {projectId: "p"})!.threads.length, 2);
});

test("native pin order supersedes stale legacy pins, remains host scoped, and retains native recency", t => {
  const { home, add, db } = fixture(t);
  for (const id of ["first", "second", "unpinned", "shared", "one", "two"]) add(id);
  add("shared", "remote");
  db.exec("UPDATE local_thread_catalog SET source_recency_at=800,source_updated_at=900 WHERE thread_id='one'");
  fs.writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { p: {rootPaths: ["/repo"]} }, "remote-projects": [{id: "rp", hostId: "remote", remotePath: "/repo"}],
    "sidebar-project-thread-orders": {p: {threadIds: ["two", "one"]}},
    "pinned-thread-ids": ["unpinned", "second", "first"],
    "thread-project-membership-host-ids": {shared: "remote"},
    "electron-persisted-atom-state": {"app-server-pinned-thread-order-v1": ["first", "second", "shared"],
      "flat-project-sidebar-preferences-v1": {chatSortMode: "manual"}}
  }));
  const rows = readDesktopSessionCatalog(home)!.threads;
  assert.equal(rows.find(r => r.threadId === "first")!.catalogOrder!.pinnedIndex, 0);
  assert.equal(rows.find(r => r.threadId === "second")!.catalogOrder!.pinnedIndex, 1);
  assert.equal(rows.find(r => r.threadId === "unpinned")!.catalogOrder!.pinnedIndex, undefined);
  assert.equal(rows.find(r => r.threadId === "shared")!.catalogOrder!.pinnedIndex, undefined);
  assert.equal(readDesktopSessionCatalog(home, "remote")!.threads[0].catalogOrder!.pinnedIndex, 2);
  assert.equal(rows.find(r => r.threadId === "one")!.catalogOrder!.recency, 800);
  assert.equal(rows.find(r => r.threadId === "two")!.catalogOrder!.manualIndex, 0);
  assert.equal(rows.find(r => r.threadId === "one")!.catalogOrder!.manualIndex, 1);
});

test('native presentation retains pins and exact migration aliases without reviving stale project membership',async t=>{
 const {nativeSessionPresentation}=await import('../src/codex/desktop-session-membership.js');const {home}=fixture(t);
 fs.writeFileSync(path.join(home,'.codex-global-state.json'),JSON.stringify({
  'local-projects':{legacy:{id:'legacy',rootPaths:['/repo']}},
  'app-server-project-id-by-legacy-project-id-by-host':{[`local:${home}`]:{legacy:'native-project'}},
  'thread-project-assignments':{thread:{projectId:'legacy'}},'pinned-thread-ids':['thread']
 }));
 const native={threadId:'thread',persistence:'active' as const,runtimeStatus:'active' as const,activeTurnId:'turn',activeFlags:[],projectMembership:'none' as const};
 const projectless=nativeSessionPresentation(home)(native);
 assert.equal(projectless.projectId,undefined);assert.equal(projectless.projectMembership,'none');assert.equal(projectless.activeTurnId,'turn');assert.equal(projectless.catalogOrder?.pinnedIndex,0);
 const assigned=nativeSessionPresentation(home)({...native,projectId:'native-project',projectMembership:'assigned'});
 assert.equal(assigned.projectId,'legacy');assert.equal(assigned.projectMembership,'assigned');
 assert.equal(nativeSessionPresentation(home,'remote')({...native,projectId:'native-project',projectMembership:'assigned'}).projectId,'native-project');
});
