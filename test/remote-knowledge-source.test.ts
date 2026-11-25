import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";
import { LlmWikiMcpClientPool } from "../src/knowledge/llm-wiki-mcp-client.js";
import { resolveChannelModeSettings } from "../src/server/channel-mode-settings.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { message, tool, sharedNativeCore } from "./fixtures/shared-native-core.mjs";

const remote = process.env.CODEX_SSH_CATALOG_TEST_TARGET;
const run = promisify(execFile);

test("a remote QA turn uses only the explicitly registered Gateway wiki with the same absolute path", {
  skip: !remote || !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 90000,
}, async t => {
  const spec = JSON.parse(remote!) as {target:string; args:string[]; binary:string};
  assert.match(spec.binary, /^\/[\w.@/-]+$/);
  const ssh = (...args: string[]) => run("ssh", [...spec.args, ...args]);
  const folder = (await ssh(spec.target, "mktemp -d /tmp/ab-wiki-XXXXXXXX")).stdout.trim();
  assert.match(folder, /^\/tmp\/ab-wiki-[A-Za-z0-9]{8}$/);
  t.after(async () => { await ssh(spec.target, "rm -rf -- " + folder); });
  // Require a fresh local directory as well: never adopt another user's path.
  fs.mkdirSync(folder, {mode: 0o700});
  t.after(() => fs.rmSync(folder, {recursive:true, force:true}));
  const file = path.join(folder, "document.txt");
  fs.writeFileSync(file, "ONLY_ON_GATEWAY");
  await ssh(spec.target, "printf ONLY_ON_EXECUTOR > " + file);
  assert.equal((await ssh(spec.target, "cat " + file)).stdout, "ONLY_ON_EXECUTOR");
  const core = await sharedNativeCore(t, (_body: unknown, n: number) => n === 1
    ? { ...tool("get_document", {document_id:"fixture"}, n), namespace:"knowledge" } : message("QA_COMPLETE", n));
  const config = path.join(core.root, "config.toml");
  const port = /127\.0\.0\.1:(\d+)/.exec(fs.readFileSync(config, "utf8"))![1];
  assert.ok(port);
  const copiedConfig = await run("scp", [...spec.args.map(option => option === "-p" ? "-P" : option), config, spec.target + ":" + folder + "/config.toml"]);
  assert.equal(copiedConfig.stdout.trim(), "");
  const mux = path.join(folder, "qa-ssh");
  await ssh("-S", mux, "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${port}:127.0.0.1:${port}`, "-fMN", spec.target);
  const runner = new CodexAppServerGateway({appServerBackend:core.runner(), remoteTransportResolver(hostId) {
    assert.equal(hostId, "qa-ssh");
    return {command:"ssh", args:[...spec.args, "-S", mux, spec.target,
      `exec env NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 CODEX_HOME=${folder} ${spec.binary} app-server`]};
  }});
  try {
    const state = new RuntimeStateStore(resolveStatePaths(path.join(folder, "gateway-state")));
    const project = state.createProject("Remote QA", folder, {hostId:"qa-ssh"});
    const pool = new LlmWikiMcpClientPool();
    t.after(() => pool.close());
    await assert.rejects(resolveChannelModeSettings({store:state, llmWiki:pool,settings:{
      defaultMode:"qa", enabledModes:["qa"], qaKnowledgeBase:{kind:"project", projectId:project.id}
    }}), /远程|remote/);
    assert.equal(state.listKnowledgeBases().length, 0);
    const command = path.join(folder, "skills/knowledge-base/.venv/bin/llm-wiki");
    fs.mkdirSync(path.dirname(command), {recursive:true});
    fs.writeFileSync(command, `#!/usr/bin/env node
const fs=require('node:fs');
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line', line=>{
  const m=JSON.parse(line); if(!('id' in m)) return;
  let result;
  if(m.method==='initialize') result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'wiki',version:'1'}};
  if(m.method==='tools/list') result={tools:[{name:'get_document'},{name:'search'}]};
  if(m.method==='tools/call') {
    fs.appendFileSync(${JSON.stringify(path.join(folder,"calls"))},m.params.name+'\\n');
    result={isError:false,content:[{type:'text',text:fs.readFileSync(${JSON.stringify(file)},'utf8')}]};
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`, {mode:0o700});
    const kb = state.createKnowledgeBase("Registered local wiki", folder);
    const session = state.createSession("actor", folder, "QA", project.id, "qa", kb.id);
    state.setInteractionMode("actor", "qa");
    const replies: string[] = [];
    const service = new BridgeService({stateStore:state, runner, llmWiki:pool,
      config:{...defaultConfig(folder), allowedSenderIds:["actor"], streamReplies:false},
      modeSettings:{defaultMode:"qa", enabledModes:["qa"], qaKnowledgeBaseId:kb.id},
      channel:createChannelClient("generic", TEXT_CAPABILITIES, {async sendText({text}) { replies.push(text); return {messageId:"ok"}; }})
    });
    await service.handleMessage({id:"qa-source", senderId:"actor", text:"look up the fixture document", raw:{}});
    assert.ok(replies.some(text => text.includes("QA_COMPLETE")), JSON.stringify(replies));
    assert.equal(fs.readFileSync(path.join(folder,"calls"),"utf8"), "get_document\n");
    assert.equal(core.calls.length,2);
    const returned = JSON.stringify(core.calls[1].input);
    assert.ok(returned.includes("ONLY_ON_GATEWAY") && !returned.includes("ONLY_ON_EXECUTOR"));
    const nativeThread = state.getSession(session.id)?.threadId;
    assert.ok(nativeThread);
    assert.match((await ssh(spec.target, "find " + folder + "/sessions -type f")).stdout, new RegExp(nativeThread));
  } finally {
    try { await runner.close(); } finally { await ssh("-S",mux,"-O","exit",spec.target); }
  }
});
