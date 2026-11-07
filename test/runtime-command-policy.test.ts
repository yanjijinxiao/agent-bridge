import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_COMMAND_REGISTRY, parseCommand } from "../src/bridge/channel-commands.js";
import { RUNTIME_COMMAND_TARGETS, runtimeCommandTarget, runtimeCommandRestriction, runtimeHelp } from "../src/bridge/runtime-command-policy.js";
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
  const help = runtimeHelp(descriptor);
  for (const name of CHANNEL_COMMAND_REGISTRY.map(c => c.name)) assert.ok(help.includes(`/${name}`), name);
});
