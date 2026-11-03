import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_SERVER_BACKEND_CAPABILITIES, type CodexBridgeBackend } from "../src/codex/backend.js";
import { withPeerBackend } from "../src/peer/backend.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { channelHelpText } from "../src/bridge/channel-commands.js";

for (const host of [undefined, "local", "ssh-contract"]) test(`Peer decoration preserves existing backend arguments and object identity: ${host ?? "default"}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-pass-through-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new PeerRegistry(path.join(root, "grants.json"));
  const guard = () => {}, input = { threadId: "thread", hostId: host, cwd: "/workspace", prompt: "source", assertCurrent: guard };
  const page = { limit: 10 }, observation = { timeoutMs: 1000 }, goal = { objective: "unchanged" }, observer = {};
  const cases: Record<string, unknown[]> = {
    backendInfo: [host], run: [input], steer: [input, host], submitThreadMessage: [input, host], stop: ["thread", host, guard],
    runEphemeral: [input], warmUp: ["/workspace", host], listProjects: [host, observation], listThreads: [page, host], listSessionCatalog: [page, host],
    getHistory: ["thread", host], getHistoryPage: ["thread", page, host], readThreadSnapshot: ["thread", host],
    inspectThread: ["thread", host, observation], getRuntimeInfo: ["/workspace", "thread", host, observation],
    listModels: [host], getAccountRateLimits: [host, "device-model"], listSkills: ["/workspace", host], listMcpServers: ["thread", host],
    serverIdentity: [host], readThreadProvenance: ["thread", host], getGoal: ["thread", host], setGoal: ["thread", goal, host, guard],
    clearGoal: ["thread", host, guard], createThread: [input, host], renameThread: ["thread", "title", host, guard],
    archiveThread: ["thread", host, guard], unarchiveThread: ["thread", host, guard], deleteThread: ["thread", host, guard],
    interruptTurn: ["thread", "turn", host, guard], readTurnLifecycle: ["thread", "turn", host], readTurnActivities: ["thread", "turn", host],
    addQueuedSubmission: [input, host], listQueuedSubmissions: ["thread", "cursor", host], deleteQueuedSubmission: ["thread", "q", host, guard],
    runQueuedSubmission: [input], resumeAfterCapacity: [input], recoverSystemError: [input, host],
    observeThreadInteractions: ["thread", host, observer, "consumer"], unobserveThreadInteractions: ["thread", host, "consumer"],
    interactionSubscriptionReady: ["thread", host, "consumer"], stageAttachments: [[{ path: "/input" }], { hostId: host }],
    fetchOutputFile: ["/output", { hostId: host }]
  };
  const native: any = {}; let actual: unknown[] = [], receiver: unknown;
  for (const name of Object.keys(cases)) native[name] = function (...args: unknown[]) { receiver = this; actual = args;
    return name === "backendInfo" ? { id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES } : name === "interactionSubscriptionReady" ? true : Promise.resolve(undefined); };
  const wrapped = withPeerBackend(native as CodexBridgeBackend, registry);
  for (const [method, args] of Object.entries(cases)) {
    await (wrapped as any)[method](...args);
    assert.equal(receiver, native, `${method} receiver`); assert.equal(actual.length, args.length, `${method} arity`);
    args.forEach((arg, i) => assert.equal(actual[i], arg, `${method} argument ${i} identity`));
  }
});

test("Connector patch does not introduce the extracted generic lifecycle commands", () => {
  const help = channelHelpText([], "session");
  assert.doesNotMatch(help, /\/sessions archived|\/session rename|\/session restore/);
  assert.match(help, /\/sessions/); assert.match(help, /\/leave/);
});
