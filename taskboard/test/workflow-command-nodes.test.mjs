import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { workflowCommands, readCommandNodeResult, matchesNativeCommand } from "../server/workflow-command-nodes.mjs";

test("command parameters preserve quotes, substitution characters and newlines as literal argv", () => {
  const value = "a' b\n$(echo must-not-execute) `id`";
  const commands = workflowCommands({ kind: "custom-code", codeRuntime: "javascript", codeContent: `process.stdout.write(${JSON.stringify(value)})` });
  assert.equal(execFileSync("sh", ["-c", commands[0]], { encoding: "utf8" }), value);
  assert.throws(() => workflowCommands({ kind: "git", gitOperation: "push", gitRemote: "--force" }), /not be an option/);
});

test("a plausible model answer cannot replace exact ordered native command receipts", () => {
  const commands = workflowCommands({ kind: "git", gitOperation: "status" });
  const answer = JSON.stringify({ ok: true, text: "done", exitCodes: [0] });
  assert.throws(() => readCommandNodeResult(answer, commands, []), /回执/);
  assert.throws(() => readCommandNodeResult(answer, commands, [{ type: "command_execution", data: { command: commands[0], exitCode: 1 } }]), /回执/);
  assert.deepEqual(readCommandNodeResult(answer, commands, [{ type: "command_execution", data: { command: commands[0], exitCode: 0 } }]), { text: "done", exitCodes: [0] });
  assert.equal(matchesNativeCommand(`/bin/zsh -lc "${commands[0]}"`, commands[0]), true);
  assert.equal(matchesNativeCommand(`/bin/zsh -lc "${commands[0]}; echo unrelated"`, commands[0]), false);
  assert.equal(matchesNativeCommand(`/bin/zsh -lc "${commands[0]}" && echo unrelated`, commands[0]), false);
  assert.equal(matchesNativeCommand(`/bin/zsh -lc "${commands[0]}" extra`, commands[0]), false);
});

test("CLI integration plans keep supplied targets and do not disable provider permissions", () => {
  const review = workflowCommands({ kind: "claude-code-review", claudeModel: "sonnet" }, { text: "review input" })[0];
  assert.match(review, /'claude' '-p'/); assert.match(review, /'--permission-mode' 'plan'/); assert.doesNotMatch(review, /skip-permissions|bypass/);
  assert.throws(() => workflowCommands({ kind: "cloudflare-deploy" }), /configuration path/);
  assert.equal(workflowCommands({ kind: "cloudflare-deploy", deploymentConfig: "wrangler.jsonc" })[0], "'wrangler' 'deploy' '--config' 'wrangler.jsonc'");
  assert.equal(workflowCommands({ kind: "opencli", integrationArguments: '["--help"]' })[0], "'opencli' '--help'");
  assert.throws(() => workflowCommands({ kind: "custom-integration", integrationArguments: '[1]' }), /string array/);
  assert.equal(workflowCommands({ kind: "vercel-deploy" }).length, 2);
});

test("all eight Git operations perform their specified effects in isolated repositories", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-git-")), repo = path.join(root, "repo"), remote = path.join(root, "remote.git");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "empty-config"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Workflow test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Workflow test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "--bare", remote); git(root, "init", "-b", "main", repo); git(repo, "remote", "add", "origin", remote);
  const execute = (gitOperation, data = {}) => workflowCommands({ kind: "git", gitOperation, ...data }).map(command => execFileSync("sh", ["-c", command], { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  writeFileSync(path.join(repo, "a.txt"), "first");
  assert.match(execute("status")[0], /\?\? a.txt/);
  const message = "literal ' commit $(not-a-command)";
  execute("commit", { gitCommitMessage: message }); assert.equal(git(repo, "log", "-1", "--format=%s"), message);
  execute("push", { gitBranchName: "main" }); assert.equal(git(root, "--git-dir", remote, "rev-parse", "main"), git(repo, "rev-parse", "HEAD"));
  execute("create-branch", { gitBranchName: "feature" }); execute("switch-branch", { gitBranchName: "feature" });
  assert.equal(git(repo, "branch", "--show-current"), "feature");
  writeFileSync(path.join(repo, "a.txt"), "feature"); execute("commit", { gitCommitMessage: "feature" });
  execute("switch-branch", { gitBranchName: "main" }); execute("merge-branch", { gitBranchName: "feature" });
  assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "feature");
  execute("push", { gitBranchName: "main" }); execute("pull", { gitBranchName: "main" });
  const worktree = path.join(root, "work tree"); execute("create-worktree", { gitBranchName: "worktree", gitWorktreePath: worktree, gitBaseBranch: "main" });
  assert.equal(git(worktree, "branch", "--show-current"), "worktree");
  assert.equal(readFileSync(path.join(worktree, "a.txt"), "utf8"), "feature");
});
