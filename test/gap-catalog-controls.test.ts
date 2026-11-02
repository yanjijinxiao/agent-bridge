import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliSessionStore } from "../src/codex/cli-sessions.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { listCodexSessionCandidates } from "../src/server/codex-projects.js";
import { BridgeService } from "../src/bridge/service.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";

const home = (t: test.TestContext) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-gap-catalog-"));
  fs.mkdirSync(path.join(root, "sessions")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
};
const record = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + "\n";
const meta = (id: string, cwd: string, source: unknown = "cli", session_id?: string) => record("session_meta", { id, cwd, source, session_id });
const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

for (const format of ["event", "response", "mixed"] as const) test(`CAT-04.1: ${format} rollout history preserves UTF-8 across stream chunks and de-duplicates public messages`, async t => {
  const root = home(t), question = "跨块中文🙂".repeat(16000), answer = "公开答案";
  let data = meta("main", root) + record("event_msg", { type: "task_started", turn_id: "turn" });
  if (format !== "response") data += record("event_msg", { type: "user_message", message: question });
  if (format !== "event") data += record("response_item", user(question));
  if (format !== "response") data += record("event_msg", { type: "agent_message", phase: "final_answer", message: answer });
  if (format !== "event") data += record("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: answer }] });
  data += record("event_msg", { type: "task_complete", turn_id: "turn", last_agent_message: answer });
  fs.writeFileSync(path.join(root, "sessions/main.jsonl"), data);
  const store = new CliSessionStore(root), snapshot = await store.snapshot("main");
  assert.deepEqual(snapshot.turns.flatMap(turn => turn.messages).map(message => message.text), [question, answer]);
  assert.deepEqual((await store.historyPage("main", { limit: 2 })).messages.map(message => message.text), [question, answer]);
});

test("CAT-04.2: rollout preview and public history exclude internal threads, environment and developer/guardian prompts while retaining quoted user examples", async t => {
  const root = home(t), quoted = '请解释这个示例： <environment_context>example</environment_context>';
  const internal = ['<environment_context>PRIVATE_ENV</environment_context>',
    'The following is the Codex agent history whose request action you are assessing. >>> TRANSCRIPT START PRIVATE_GUARDIAN >>> APPROVAL REQUEST START'];
  const data = meta("main", root) + record("event_msg", { type: "task_started", turn_id: "turn" })
    + record("response_item", user(quoted)) + internal.map(text => record("response_item", user(text))).join("")
    + record("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "PRIVATE_DEVELOPER" }] })
    + record("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "public answer" }] });
  fs.writeFileSync(path.join(root, "sessions/main.jsonl"), data);
  for (const source of ["guardian", { subagent: { other: "guardian" } }]) {
    const id = typeof source === "string" ? "guardian" : "child";
    fs.writeFileSync(path.join(root, `sessions/${id}.jsonl`), meta(id, root, source, "main") + record("response_item", user("PRIVATE_CHILD")));
  }
  assert.deepEqual(listCodexSessionCandidates(root, root).map(item => item.threadId), ["main"]);
  assert.equal(listCodexSessionCandidates(root, root)[0].lastUserMessage, quoted);
  const store = new CliSessionStore(root);
  assert.deepEqual((await store.list()).map(row => row.threadId), ["main"]);
  assert.deepEqual((await store.historyPage("main")).messages.map(message => message.text), [quoted, "public answer"]);
});

test("CAT-04.2: standard native history and IM catalog do not expose internal source or synthetic user instructions", async t => {
  const root = home(t), file = path.join(root, "wire.mjs"), log = path.join(root, "calls.jsonl");
  fs.writeFileSync(file, `import readline from 'node:readline';import fs from 'node:fs';
const env='<environment_context>PRIVATE_ENV</environment_context>';
const turns=[{id:'turn',status:'completed',items:[{type:'userMessage',id:'q',content:[{type:'text',text:'public question'}]},
{type:'userMessage',id:'env',content:[{type:'text',text:env}]},{type:'developerMessage',id:'dev',text:'PRIVATE_DEVELOPER'},
{type:'guardianReview',id:'guard',text:'PRIVATE_GUARDIAN'},{type:'agentMessage',id:'a',text:'public answer'}]}];
const main={id:'main',cwd:${JSON.stringify(root)},name:'Main',preview:env,status:{type:'idle'},turns};
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method})+'\\n');let result;
if(m.method==='initialize'||m.method==='thread/unsubscribe')result={};
else if(m.method==='thread/list')result={data:[main,{...main,id:'guardian',name:'PRIVATE_GUARDIAN_THREAD',source:'guardian'},{...main,id:'child',name:'PRIVATE_CHILD',source:{subagent:{other:'guardian'}}}],nextCursor:null};
else if(m.method==='thread/read')result={thread:main};else if(m.method==='thread/turns/list')result={data:turns,nextCursor:null};
else {process.stdout.write(JSON.stringify({id:m.id,error:{code:-1,message:'unexpected mutation'}})+'\\n');continue;}
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}`);
  const runner = new AppServerCodexRunner({ codexHome: root, catalogSource: "native", transport: { command: process.execPath, args: [file], mode: "daemon-proxy" }, requestTimeoutMs: 1000 });
  t.after(() => runner.close());
  const messages = await runner.getHistory("main");
  assert.deepEqual(messages.map(message => message.text), ["public question", "public answer"]);
  const listed = await runner.listThreads({ persistence: "active" });
  assert.equal(listed.find(row => row.threadId === "main")?.preview, "public question");
  const texts: string[] = [];
  const service = new BridgeService({ runner: runner as never, stateStore: new RuntimeStateStore(resolveStatePaths(path.join(root, "state"))),
    listCodexProjects: () => [], config: { ...defaultConfig(root), allowedSenderIds: ["actor"] },
    channel: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText(input) { texts.push(input.text); return { messageId: "m" }; } }) });
  await service.handleMessage({ id: "list", senderId: "actor", text: "/sessions", raw: {} });
  assert.match(texts.join("\n"), /Main/); assert.doesNotMatch(texts.join("\n"), /PRIVATE_/);
  const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).method);
  assert.ok(!calls.some(method => /turn\/start|thread\/resume|thread\/start/.test(method)));
});

for (const objective of ["pause", "clear"]) test(`CTRL-04.2: IM goal set sends the literal objective ${objective} to the original host instead of executing a control`, async t => {
  const root = home(t), state = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = state.createProject("Remote", "/remote", { hostId: "remote-original", projectKind: "remote" });
  const session = state.createSession("room", "/remote", "Task", project.id); state.setSessionThread(session.id, "original");
  const calls: unknown[] = [];
  const service = new BridgeService({ stateStore: state, config: { ...defaultConfig(root), allowedSenderIds: ["actor"] },
    channel: createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "m" }; } }),
    runner: { backendInfo: () => ({ id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
      async clearGoal() { assert.fail("a literal goal is not a clear command"); }, async getGoal() { assert.fail("must set the objective"); },
      async setGoal(threadId, input, hostId, guard) { guard?.(); calls.push({ threadId, input, hostId });
        return { threadId, objective: input.objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 }; }
    } as never });
  await service.handleMessage({ id: "set", senderId: "actor", replyTargetId: "room", text: `/goal set ${objective}`, raw: {} });
  assert.deepEqual(calls, [{ threadId: "original", hostId: "remote-original", input: { objective, status: "active" } }]);
});
