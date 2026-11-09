import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { ThreadEventHub, type ThreadSubscription } from "../src/server/thread-event-hub.js";
import { TEXT_CAPABILITIES } from "../src/channels/client.js";
import { dingTalkProgressContent } from "../src/channels/dingtalk-markdown.js";
import { CodexCommunicationError } from "../src/codex/communication-error.js";

for (const restart of [false, true]) test(`native follow retains full commentary across summary snapshots and compaction (restart=${restart})`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-phase-"));
  const stateFile = path.join(root, "state.json"), traceFile = path.join(root, "trace.jsonl");
  const phases = ["先核对评审意见，再补充复现。", "已复现一条真实问题，修复并保留回归。", "修复后全部用例通过，正在核对提交。"];
  const write = (count: number) => fs.writeFileSync(stateFile, JSON.stringify({ phases: phases.slice(0, count) }));
  write(1);
  const runner = new AppServerCodexRunner({ historyOnly: true, requestTimeoutMs: 2000, transport: {
    command: process.execPath, args: [path.resolve("test/fixtures/phase-snapshot.mjs"), stateFile, traceFile], mode: "remote-daemon"
  } });
  const frames: any[] = [], starts: any[] = [];
  const sub: ThreadSubscription = { key: "binding", hostId: "local", threadId: "thread", recipientId: "chat", managed: false,
    client: { resumableTextStream: true, capabilities: { ...TEXT_CAPABILITIES, progress: "available", progressFooter: "available", turnStatusHeader: "available" },
      async sendText() { throw Error("unexpected text fallback"); },
      async startTextStream(input) { starts.push(input); return { messageId: input.streamId! }; },
      async updateTextStream(input) { frames.push(input); } } };
  const options = { filePath: path.join(root, "follow.json"), subscriptions: () => [sub], backend: () => runner };
  let hub = new ThreadEventHub(options);
  t.after(async () => { await hub.stop(); runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await hub.refresh();
  if (restart) { await hub.stop(); hub = new ThreadEventHub(options); }
  for (const count of [2, 3]) {
    write(count); await hub.synchronize("binding");
    const saved = JSON.parse(fs.readFileSync(options.filePath, "utf8")).binding.checkpoint;
    assert.deepEqual(saved.phaseProgress.phases.map((p: { text: string }) => p.text), phases.slice(0, count));
  }
  const latest = frames.at(-1) ?? starts.at(-1);
  const rendered = dingTalkProgressContent(latest.progressLayout.body);
  for (const phase of phases) assert.ok(rendered.includes(phase));
  assert.doesNotMatch(rendered, /PRIVATE_TOOL_OUTPUT/);
  assert.equal(starts.length, 1, "polling/recovery must keep the same card");
  fs.writeFileSync(stateFile, JSON.stringify({ phases, readFailure: true }));
  await hub.synchronize("binding");
  assert.deepEqual(JSON.parse(fs.readFileSync(options.filePath, "utf8")).binding.checkpoint.phaseProgress.phases.map((p: {text: string}) => p.text), phases,
    "a failed full read must not erase retained stages");
  const requests = fs.readFileSync(traceFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const full = requests.filter(r => r.method === "thread/turns/list" && r.params.itemsView === "full");
  assert.ok(full.length); assert.ok(full.every(r => r.params.limit === 1 && r.params.sortDirection === "desc"));
  assert.ok(!requests.some(r => ["thread/resume", "turn/start", "turn/interrupt"].includes(r.method)));
});

for (const fault of ["mismatch", "badView"]) test(`native commentary hydration refuses ${fault} instead of publishing incomplete or foreign text`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-phase-race-"));
  const stateFile = path.join(root, "state.json"), traceFile = path.join(root, "trace.jsonl");
  fs.writeFileSync(stateFile, JSON.stringify({ phases: ["foreign output"], [fault]: true }));
  const runner = new AppServerCodexRunner({ historyOnly: true, requestTimeoutMs: 2000, transport: {
    command: process.execPath, args: [path.resolve("test/fixtures/phase-snapshot.mjs"), stateFile, traceFile], mode: "remote-daemon"
  } });
  t.after(() => { runner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(runner.readThreadSnapshot("thread"), error => error instanceof CodexCommunicationError && error.operation === "thread/snapshot");
});
