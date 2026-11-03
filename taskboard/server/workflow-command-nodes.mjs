import { ApiError } from "./database.mjs";

const required = (value, field) => {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new ApiError(400, "WORKFLOW_NODE_CONFIG", `${field} is required`);
  return value;
};
const argument = (value, field) => {
  const text = required(value, field);
  if (text.startsWith("-")) throw new ApiError(400, "WORKFLOW_NODE_CONFIG", `${field} must not be an option`);
  return text;
};
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = argv => argv.map(quote).join(" ");

/** Build exact argv before the native turn. User code is a single interpreter
 * argument, never interpolated as a fragment of a surrounding shell command. */
export function workflowCommands(data, context = {}) {
  if (["claude-code-planning", "claude-code-review", "claude-design"].includes(data.kind)) {
    const purpose = data.kind === "claude-code-planning" ? "仅制定执行计划，不修改文件。"
      : data.kind === "claude-code-review" ? "仅审查代码，报告有证据的缺陷，不修改文件。" : "按需求完成设计并报告实际产物。";
    return [command(["claude", "-p", JSON.stringify({ purpose, requirements: data.planningRequirements || data.additionalInstructions || "", upstream: context }),
      "--output-format", "json", ...(data.kind === "claude-design" ? [] : ["--permission-mode", "plan"]),
      ...(data.claudeModel ? ["--model", argument(data.claudeModel, "Claude model")] : [])])];
  }
  if (data.kind === "opencli" || data.kind === "custom-integration") {
    let argv;
    try { argv = JSON.parse(required(data.integrationArguments, "Command arguments (JSON array)")); }
    catch { throw new ApiError(400, "WORKFLOW_NODE_CONFIG", "Command arguments must be a JSON string array"); }
    if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== "string" || arg.includes("\0")))
      throw new ApiError(400, "WORKFLOW_NODE_CONFIG", "Command arguments must be a nonempty JSON string array");
    return [command(data.kind === "opencli" ? ["opencli", ...argv] : argv)];
  }
  if (data.kind === "cloudflare-deploy") return [command(["wrangler", "deploy", "--config", required(data.deploymentConfig, "Wrangler configuration path")])];
  if (data.kind === "vercel-deploy") {
    // Reuse an explicitly linked project. Do not let noninteractive deployment
    // create a new account/project when the user intended an existing target.
    return [command(["node", "-e", "const p=JSON.parse(require('fs').readFileSync('.vercel/project.json','utf8'));if(!p.projectId||!p.orgId)process.exit(1)"]),
      command(["vercel", "deploy", "--yes", ...(data.deploymentProduction ? ["--prod"] : [])])];
  }
  if (data.kind === "git") {
    const remote = () => argument(data.gitRemote || "origin", "Git remote");
    const branch = () => argument(data.gitBranchName, "Git branch");
    switch (data.gitOperation || "commit") {
      case "status": return [command(["git", "status", "--porcelain=v1"])];
      case "commit": return [...(data.gitStageAll !== false ? [command(["git", "add", "--all"])] : []), command(["git", "commit", "-m", required(data.gitCommitMessage, "Commit message")])];
      case "pull": return [command(["git", "pull", "--ff-only", remote(), ...(data.gitBranchName ? [branch()] : [])])];
      case "push": return [command(["git", "push", remote(), ...(data.gitBranchName ? [branch()] : [])])];
      case "create-branch": return [command(["git", "branch", branch(), ...(data.gitBaseBranch ? [argument(data.gitBaseBranch, "Base branch")] : [])])];
      case "switch-branch": return [command(["git", "switch", branch()])];
      case "merge-branch": return [command(["git", "merge", "--no-edit", branch()])];
      case "create-worktree": return [command(["git", "worktree", "add", ...(data.gitBranchName ? ["-b", branch()] : []),
        argument(data.gitWorktreePath, "Worktree path"), ...(data.gitBaseBranch ? [argument(data.gitBaseBranch, "Base branch")] : [])])];
      default: throw new ApiError(400, "WORKFLOW_NODE_CONFIG", "Unknown Git operation");
    }
  }
  if (data.kind === "custom-code") {
    const code = required(data.codeContent, "Code");
    const runtime = data.codeRuntime ?? "shell";
    const argv = { shell: ["sh", "-c", code], javascript: ["node", "-e", code], python: ["python3", "-c", code] }[runtime];
    if (!argv) throw new ApiError(400, "WORKFLOW_NODE_CONFIG", "Unknown code runtime");
    return [command(argv)];
  }
  if (data.kind === "run-tests" && data.testScope === "custom") return [command(["sh", "-c", required(data.testCommand, "Test command")])];
  return null;
}

export function commandNodeInstruction(data, context) {
  const commands = workflowCommands(data, context);
  if (!commands) return null;
  return ["这是一个命令执行节点。请实际调用执行工具，在当前项目根按给定顺序运行以下命令，保留原始参数。遇到非零退出码立即结束本节点，不运行余下命令，不自行修改命令或重试有副作用的命令。",
    JSON.stringify({ commands }), "完成后只输出JSON对象：{\"ok\":true或false,\"text\":\"结果与错误摘要\",\"exitCodes\":[按顺序的实际退出码]}。无法执行时ok为false。不要把命令说明当作执行成功。"].join("\n\n");
}

export function readCommandNodeResult(text, commands, events) {
  let value;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?|\n?```$/g, "")); } catch { throw new Error("命令节点没有返回可核验的执行结果"); }
  if (!value || value.ok !== true || typeof value.text !== "string" || !Array.isArray(value.exitCodes)
    || value.exitCodes.length !== commands.length || value.exitCodes.some(code => code !== 0))
    throw new Error(typeof value?.text === "string" ? value.text : "命令节点执行失败或退出码未确认");
  // A model's JSON is a summary, not an execution receipt. Require the exact
  // saved commands in the core's public command items, in order and successful.
  const actual = events.filter(event => event.type === "command_execution");
  let cursor = 0;
  for (const expected of commands) {
    const index = actual.findIndex((event, i) => i >= cursor && matchesNativeCommand(event.data?.command, expected));
    if (index < 0 || actual[index].data?.exitCode !== 0)
      throw new Error("缺少原生服务的命令成功回执，未将模型摘要记为执行成功");
    cursor = index + 1;
  }
  return { text: value.text, exitCodes: value.exitCodes };
}

/** App Server renders exec_command as `/bin/zsh -lc <quoted original>`. Parse
 * only its literal argv representation; never eval a shell string or accept a
 * substring match that would also accept appended commands. */
export function matchesNativeCommand(actual, expected) {
  if (actual === expected) return true;
  if (typeof actual !== "string") return false;
  const words = []; let word = "", mode = "", started = false;
  for (let i = 0; i < actual.length; i++) {
    const ch = actual[i];
    if (mode === "'") { if (ch === "'") mode = ""; else word += ch; continue; }
    if (mode === '"') {
      if (ch === '"') { mode = ""; continue; }
      if (ch === "\\" && i + 1 < actual.length && ['"', "\\", "$", "`", "\n"].includes(actual[i + 1])) {
        const next = actual[++i]; if (next !== "\n") word += next;
      } else word += ch;
      continue;
    }
    if (/\s/.test(ch)) { if (started) { words.push(word); word = ""; started = false; } continue; }
    started = true;
    if (ch === "'" || ch === '"') { mode = ch; continue; }
    if (ch === "\\") { if (++i >= actual.length) return false; word += actual[i]; continue; }
    if (/[;&|<>()$`*?{}]/.test(ch)) return false;
    word += ch;
  }
  if (mode) return false;
  if (started) words.push(word);
  return words.length === 3 && /^(?:(?:\/usr)?\/bin\/)?(?:zsh|bash|sh)$/.test(words[0])
    && ["-lc", "-c"].includes(words[1]) && words[2] === expected;
}
