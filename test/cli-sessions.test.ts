import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliSessionStore } from "../src/codex/cli-sessions.js";
import { CodexExecRunner } from "../src/codex/exec-runner.js";
import { CodexBackendRouter } from "../src/codex/runner.js";
import { CodexBackendCapabilityError } from "../src/codex/backend.js";
import { BridgeService } from "../src/bridge/service.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
test("CLI catalog and paged public history are independent of Desktop and reject internal identities", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir);
  const record = (id: string, source: unknown = "cli", session_id?: string) => JSON.stringify({ type: "session_meta", payload: { id, source, session_id, cwd: root } }) + "\n";
  const main = path.join(dir, "main.jsonl");
  fs.writeFileSync(main, record("main"));
  fs.writeFileSync(path.join(dir, "guardian.jsonl"), record("guardian", { subagent: { other: "guardian" } }, "main"));
  const append = (x: unknown) => fs.appendFileSync(main, JSON.stringify(x) + "\n");
  for(let i = 0; i < 3; i++) {
    append({ type: "event_msg", payload: { type: "task_started", turn_id: `t${i}` } });
    append({ type: "event_msg", payload: { type: "user_message", message: `question${i}` } });
    append({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `question${i}` }] } });
    append({ type: "response_item", payload: { type: "message", role: "assistant", phase: "analysis", content: [{ type: "output_text", text: "PRIVATE_REASONING" }] } });
    append({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `answer${i}` }] } });
    append({ type: "event_msg", payload: { type: "task_complete", turn_id: `t${i}`, last_agent_message: `answer${i}` } });
  }
  fs.writeFileSync(path.join(root, "session_index.jsonl"), JSON.stringify({ id: "main", thread_name: "Local task" }) + "\n");
  const store = new CliSessionStore(root);
  assert.deepEqual((await store.list()).map(x => x.threadId), ["main"]);
  assert.equal((await store.list())[0].title, "Local task");
  assert.equal((await store.inspect("main")).title, "Local task");
  assert.equal((await store.inspect("guardian")).persistence, "missing");
  const snapshot = await store.snapshot("main");
  assert.equal(snapshot.turns.length, 3);
  assert.equal(snapshot.turns.flatMap(t => t.messages).length, 6, "event and response duplicates are collapsed");
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_REASONING/);
  assert.equal(snapshot.state.runtimeStatus, "unknown", "disk history is not proof of a live writer");
  const page = await store.historyPage("main", { limit: 2 });
  assert.deepEqual(page.messages.map(x => x.text), ["question2", "answer2"]);
  assert.deepEqual((await store.historyPage("main", { limit: 2, cursor: page.nextCursor })).messages.map(x => x.text), ["question1", "answer1"]);
  await assert.rejects(store.historyPage("different", { cursor: page.nextCursor }), /Invalid CLI history cursor/);
  const archived = path.join(root, "archived_sessions");
  fs.mkdirSync(archived);
  fs.renameSync(main, path.join(archived, "main.jsonl"));
  assert.equal((await store.list({ persistence: "active" })).length, 0);
  assert.equal((await store.inspect("main")).persistence, "archived");
});
test("CLI-only installations use the same complete native controls", async t => {
  const {unifiedBackend}=await import('./fixtures/unified-backend.js');const f=unifiedBackend(t);
  await f.gateway.listModels();await f.gateway.getAccountRateLimits();await f.gateway.getGoal('thread');
  await f.gateway.setGoal('thread',{objective:'goal'});await f.gateway.clearGoal('thread');
  await f.gateway.archiveThread('thread');await f.gateway.unarchiveThread('thread');
  await f.gateway.run({cwd:'/tmp',prompt:'new',dynamicTools:[{name:'tool',description:'test',inputSchema:{type:'object'}}]});
  assert.equal(f.gateway.backendInfo().capabilities.dynamicTools,true);
  assert.equal(f.gateway.backendInfo().capabilities.liveFollow,true);
  assert.equal(f.calls.at(-1)!.args[0].dynamicTools[0].name,'tool');
});

test("CLI project discovery does not truncate its catalog to the last 2000 rollouts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-full-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "sessions"));
  const old = path.join(root, "old-workspace");
  fs.mkdirSync(old);
  for(let i = 0; i < 2001; i++)
    fs.writeFileSync(path.join(root, "sessions", `${i}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: `t${i}`, cwd: i === 0 ? old : root } }) + "\n");
  const runner = new CodexExecRunner({ codexHome: root });
  assert.equal((await runner.listProjects()).projects.length, 2);
  assert.equal((await runner.listThreads()).length, 2001);
  const project = (await runner.listProjects()).projects.find(p => p.roots[0] === fs.realpathSync(old))!;
  assert.equal((await runner.listThreads({ cwd: project.roots[0], projectId: project.id })).length, 1);
});
