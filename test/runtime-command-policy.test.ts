import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_COMMAND_REGISTRY, parseCommand } from "../src/bridge/channel-commands.js";
import { RUNTIME_COMMAND_TARGETS, runtimeCommandTarget, runtimeCommandRestriction } from "../src/bridge/runtime-command-policy.js";
import { runtimeHelp } from "../src/bridge/runtime-help.js";
import { terminalOperations } from "../src/agents/contracts.js";
import { parseRuntimeCreateCommand } from "../src/bridge/runtime-lifecycle-command.js";

test("all canonical commands and aliases retain one authority and no undocumented command branch", () => {
  assert.deepEqual(Object.keys(RUNTIME_COMMAND_TARGETS).sort(), CHANNEL_COMMAND_REGISTRY.map(c => c.name).sort());
  for (const command of CHANNEL_COMMAND_REGISTRY) for (const alias of [command.name, ...command.aliases]) {
    const parsed = parseCommand(`/${alias}`)!;
    assert.equal(parsed.name, command.name);
    assert.equal(runtimeCommandTarget(parsed), RUNTIME_COMMAND_TARGETS[command.name]);
  }
});
test("record controls retain their authority while new resources use the directory selection", () => {
  for (const text of ["/approve A1", "/reject A1", "/answer Q1 yes", "/skip Q1", "/inbox", "/queue list", "/queue cancel q1", "/intervene i1 cancel"])
    assert.equal(runtimeCommandTarget(parseCommand(text)!), "record", text);
  for (const text of ["/new", "/n", "/s new --agent codex"]) assert.equal(runtimeCommandTarget(parseCommand(text)!), "catalog", text);
  for (const text of ["/model", "/stop", "/session rename title", "/queue work"])
    assert.equal(runtimeCommandTarget(parseCommand(text)!), "binding", text);
});
test("creation aliases preserve exact quoted literal argv through the actual command parser", () => {
  const args = '--agent codex --name review --cwd "/tmp/two  spaces" -- --message "$(whoami)  literal"';
  for (const prefix of ["/new ", "/n ", "/session new ", "/s new "]) {
    assert.deepEqual(parseRuntimeCreateCommand(parseCommand(prefix + args)!.arg), {
      program: "codex", title: "review", cwd: "/tmp/two  spaces", args: ["--message", "$(whoami)  literal"]
    });
  }
});
test("help covers command families and capability rejection never captures original approval records", () => {
  const descriptor = { kind: "herdr-app" as const, endpointId: "e", version: "v", protocol: { name: "test" }, operations: terminalOperations() };
  for (const name of ["approve", "reject", "answer", "skip"]) assert.equal(runtimeCommandRestriction(descriptor, { name, arg: "old" }), undefined);
  for (const name of ["model", "effort", "plan", "goal", "balance", "steer"]) assert.match(runtimeCommandRestriction(descriptor, { name, arg: "" })!, /没有提供等价/);
  const help = runtimeHelp(descriptor, "all");
  for (const name of CHANNEL_COMMAND_REGISTRY.map(c => c.name)) assert.ok(help.includes(`/${name}`), name);
});

test("runtime help topics, aliases, extension usage and configured capabilities match dispatch", () => {
  const descriptor = { kind: "herdr-tui" as const, endpointId: "e", version: "v", protocol: { name: "test" }, operations: terminalOperations({ create: { supported: true, semantics: "terminal-create" } }) };
  const all = runtimeHelp(descriptor, "all", { taskboardAvailable: false });
  for (const command of CHANNEL_COMMAND_REGISTRY) for (const alias of command.aliases) assert.ok(all.includes(`/${alias}`), alias);
  assert.match(all, /需启用 Taskboard/); assert.match(all, /未注册.*文字提示/);
  const session = runtimeHelp(descriptor, "session");
  assert.match(session, /--agent 程序名 --name 名称/); assert.match(session, /\/history.*\n查看当前终端画面/);
  assert.doesNotMatch(session, /\/model/);
  const input = runtimeHelp(descriptor, "input"); assert.match(input, /\/prompt/); assert.match(input, /\/queue cancel/); assert.doesNotMatch(input, /\/new/);
  const model = runtimeHelp(descriptor, "m"); assert.match(model, /\/model/); assert.match(model, /没有提供等价/); assert.doesNotMatch(model, /\/new/);
  assert.match(runtimeHelp(descriptor, "unknown"), /帮助主题/);
  const extension = { id: "x", commandName: "custom", aliases: { extra: "custom" }, helpLine: "/custom 参数 - 扩展用法", aiActions: [], resolve: () => ({ kind: "reply" as const, text: "ok" }) };
  assert.match(runtimeHelp(descriptor, "extra", { capabilities: [extension] }), /\/custom 参数/);
  descriptor.operations.interrupt = { supported: false, availability: "configuration-required", reason: "请配置中断键" };
  assert.match(runtimeHelp(descriptor, "stop"), /尚未配置.*请配置中断键/);
  descriptor.operations.interrupt = { supported: true, availability: "supported", reason: "configured" };
  assert.doesNotMatch(runtimeHelp(descriptor, "stop"), /尚未配置|没有提供等价/);
});
