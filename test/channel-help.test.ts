import assert from "node:assert/strict";
import test from "node:test";
import { CHANNEL_COMMAND_REGISTRY, channelHelpText, isReservedChannelCommandToken, parseCommand } from "../src/bridge/channel-commands.js";
import { APP_SERVER_BACKEND_CAPABILITIES, EXEC_BACKEND_CAPABILITIES } from "../src/codex/backend.js";
import { chunkText } from "../src/bridge/format.js";
import { normalizeDingTalkCardContent } from "../src/channels/dingtalk.js";
import { createMainMenuCard } from "../src/bridge/interaction-cards.js";
import { commandHelpChoices } from "../src/bridge/command-help.js";
import { runtimeHelp } from "../src/bridge/runtime-help.js";
import { terminalOperations } from "../src/agents/contracts.js";

const codex = { backendCapabilities: APP_SERVER_BACKEND_CAPABILITIES, taskboardAvailable: true };
const heads = (text: string) => [...text.matchAll(/^\/([a-z]+)(?:\s|（|【|$)/gm)].map(match => match[1]);

test("HELP-01: default help is one concise common page without aliases, recovery or authorization recipes", () => {
  const text = channelHelpText([], "", codex);
  const rendered = chunkText(text).map(normalizeDingTalkCardContent);
  assert.equal(rendered.length, 1);
  assert.ok(text.length < 1600, `home length ${text.length}`);
  for (const name of ["connect", "project", "sessions", "session", "new", "status", "history", "ide", "model", "effort", "stop", "unbind"])
    assert.ok(heads(text).includes(name), name);
  for (const name of ["leave", "follow", "share", "join", "policy", "intervene", "task", "qa", "mode", "approve", "answer"])
    assert.ok(!heads(text).includes(name), name);
  assert.doesNotMatch(text, /\/session new|\/project add|\/ide (status|identity|auth)|retry-delivery|别名|```/);
  assert.match(text, /\/help all/);
  const card = createMainMenuCard(text, commandHelpChoices("", codex));
  assert.equal(card.body, text);
  for (const action of card.actionGroups.flat())
    assert.ok(["connect", "project", "sessions", "status", "ide", "help"].includes(action.value.command));
  assert.ok(card.actionGroups.flat().some(action => action.value.command === "help" && action.value.arg === "all"));
});

test("HELP-02: complete reference retains every registered command, alias and capability condition", () => {
  const help = channelHelpText([], "all", { backendCapabilities: EXEC_BACKEND_CAPABILITIES, taskboardAvailable: false });
  for (const command of CHANNEL_COMMAND_REGISTRY) {
    assert.ok(heads(help).includes(command.name), command.name);
    assert.ok(isReservedChannelCommandToken(command.name));
    for (const alias of command.aliases) {
      assert.ok(help.includes(`/${alias}`), alias);
      assert.ok(isReservedChannelCommandToken(alias));
      assert.equal(parseCommand(`/${alias}`)?.name, command.name);
    }
  }
  assert.match(help, /\/steer[^\n]+【当前后端不支持】/);
  assert.match(help, /\/answer[^\n]+【当前后端不支持】/);
  assert.match(help, /\/task[^\n]+【需启用 Taskboard/);
  assert.match(help, /\/leave[^\n]*\n\/unbind 的兼容命令/);
  assert.match(help, /\/session new/); assert.match(help, /\/project add/); assert.match(help, /\/ide status/);
  assert.notEqual(help, channelHelpText([]));
});

test("HELP-03: topic selection is consistent, with an explicit escape for command/family name collisions", () => {
  const session = channelHelpText([], "session", codex);
  assert.match(session, /保留空项目，默认每页 50 项/);
  assert.match(session, /\/sessions size 50/); assert.match(session, /\/follow \[on\|off\|sync\]/);
  assert.doesNotMatch(session, /^\/leave\b|^\/model\b|^\/task\b|^\/policy\b/m);
  assert.match(channelHelpText([], "input", codex), /\/policy[\s\S]*steer 插入当前轮次（默认）/);
  assert.match(channelHelpText([], "access", codex), /viewer 只读[\s\S]*controller/);
  assert.match(channelHelpText([], "ide"), /个人准入[\s\S]*兼容核对流程/);
  for (const topic of ["/session", "s", "command session", " /S "]) {
    const help = channelHelpText([], topic);
    assert.deepEqual(heads(help), ["session"], topic);
  }
  assert.deepEqual(heads(channelHelpText([], "/access")), ["access"]);
  assert.deepEqual(heads(channelHelpText([], "m")), ["model"]);
  assert.match(channelHelpText([], "typo"), /未找到.*帮助主题/);
});

test("HELP-04: configuration narrows topic visibility without losing explicit disabled-feature documentation", () => {
  const context = { ...codex, enabledModes: ["session"] as const, taskboardAvailable: false, qaAvailable: false };
  assert.doesNotMatch(channelHelpText([], "workflow", context), /^\/(task|qa)\b/m);
  assert.match(channelHelpText([], "task", context), /当前渠道未启用 task 模式/);
  assert.match(channelHelpText([], "qa", { ...codex, qaAvailable: false }), /未绑定可用知识库/);
  assert.match(channelHelpText([], "all", context), /^\/task\b/m);
  assert.match(channelHelpText([], "all", context), /^\/qa\b/m);
  assert.doesNotMatch(channelHelpText([], "", { backendCapabilities: EXEC_BACKEND_CAPABILITIES }), /^\/model\b/m);
  const noObservation = { backendCapabilities: { ...APP_SERVER_BACKEND_CAPABILITIES, progress: false, liveFollow: false } };
  assert.match(channelHelpText([], "input", noObservation), /^\/stream[^\n]*状态查看、关闭等本地操作仍可用/m);
  assert.match(channelHelpText([], "session", noObservation), /^\/follow[^\n]*状态查看、关闭等本地操作仍可用/m);
});

for (const kind of ["herdr-app", "herdr-tui"] as const) {
  test(`HELP-05: ${kind} shares topics while retaining honest terminal, capability and record semantics`, () => {
    const runtime = { kind, endpointId: "fixture", version: "test", protocol: { name: "test" },
      operations: terminalOperations({ create: { supported: true, semantics: "terminal-create" } }) };
    const context = { runtime, taskboardAvailable: false };
    const home = runtimeHelp(runtime);
    assert.doesNotMatch(home, /^\/(model|effort|queue|steer|qa|plan)\b/m);
    assert.match(home, /查看当前终端画面/);
    const all = runtimeHelp(runtime, "all");
    for (const command of CHANNEL_COMMAND_REGISTRY) assert.ok(heads(all).includes(command.name), command.name);
    assert.match(all, /滚动覆盖旧内容/); assert.doesNotMatch(all, /阶段成果保留|短期工具动态/);
    const input = runtimeHelp(runtime, "input");
    assert.match(input, /^\/queue\b/m); assert.match(input, /list\/cancel/);
    const access = runtimeHelp(runtime, "access");
    for (const name of ["approve", "reject", "answer", "skip"]) assert.ok(heads(access).includes(name));
    assert.match(access, /已有审批或问题仍按原请求处理/);
    assert.match(runtimeHelp(runtime, "m"), /没有提供等价/);
    assert.doesNotMatch(runtimeHelp(runtime, "new"), /--standalone|--project/);
    assert.match(runtimeHelp(runtime, "new"), /实际启动程序/);
    assert.deepEqual([...new Set(heads(runtimeHelp(runtime, "/session")))], ["session"]);
    runtime.operations.interrupt = { supported: false, availability: "configuration-required", reason: "请配置中断键" };
    assert.doesNotMatch(runtimeHelp(runtime), /^\/stop\b/m);
    assert.match(runtimeHelp(runtime, "stop"), /尚未配置.*请配置中断键/);
    assert.ok(!commandHelpChoices("", context).some(choice => choice.command === "stop"));
  });
}

test("HELP-06: installed extensions are discoverable and exact aliases do not override builtin help", () => {
  const extension = { id: "x", commandName: "custom", aliases: { extra: "custom", m: "custom" }, helpLine: "/custom 参数 — 扩展说明", aiActions: [], resolve: () => ({ kind: "reply" as const, text: "ok" }) };
  assert.match(channelHelpText([extension]), /1 项已安装扩展/);
  assert.doesNotMatch(channelHelpText([extension]), /扩展说明/);
  assert.match(channelHelpText([extension], "all"), /扩展说明/);
  assert.match(channelHelpText([extension], "extra"), /扩展说明/);
  assert.doesNotMatch(channelHelpText([extension], "m"), /扩展说明/);
});

test("HELP-07: compatibility classification and independent controls survive presentation cleanup", () => {
  for (const [text, expected] of [["/leave", "leave"], ["/session new --standalone", "new"], ["/p add C1", "project"], ["/ide status", "ide"]])
    assert.equal(parseCommand(text)?.name, expected);
  assert.match(channelHelpText([], "follow"), /不重发输入或停止原任务/);
  assert.match(channelHelpText([], "stream"), /与 \/follow.*独立/);
  assert.match(channelHelpText([], "share"), /各自连接自己的 Connector 不需要/);
  assert.match(channelHelpText([], "plan"), /无参数也会切换/);
  assert.match(channelHelpText([], "model"), /default 只刷新原生设置/);
});
