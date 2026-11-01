import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopCodexRunner } from "../src/codex/desktop-runner.js";
import { IpcFrameDecoder } from "../src/codex/ipc-frames.js";

async function fixture(t: test.TestContext, options: { wrongHostOnly?: boolean; active?: boolean; hang?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-remote-owner-"));
  const socketPath = path.join(root, "ipc.sock"), sockets = new Set<net.Socket>();
  const requests: Array<{ method: string; params: Record<string, unknown>; hostId?: string; version: number }> = [];
  let started = false;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => undefined); socket.on("close", () => sockets.delete(socket));
    const decoder = new IpcFrameDecoder(1024 * 1024);
    socket.on("data", bytes => decoder.push(bytes, bytes => {
      const m = JSON.parse(bytes.toString()); requests.push(m);
      const send = (value: unknown) => { const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
        header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body])); };
      const reply = (result: unknown) => send({ type: "response", requestId: m.requestId, resultType: "success", result });
      if (m.method === "initialize") reply({ clientId: "gateway" });
      if (m.method === "thread-owner-discovery") reply({});
      if (m.method === "thread-stream-following-changed") {
        const snapshot = (hostId: string, status: string, text: string) => send({ type: "broadcast", method: "thread-stream-state-changed",
          params: { hostId, conversationId: "thread", change: { type: "snapshot", conversationState: {
            cwd: "/remote/project", threadRuntimeStatus: { type: status === "inProgress" ? "active" : "idle" },
            turns: status === "idle" ? [] : [{ turnId: "remote-turn", status,
              items: [{ type: "agentMessage", id: "answer", text, phase: "final_answer" }] }]
          } } } });
        // The foreign local thread has the same id. It cannot authorize this
        // host's input or supply this host's result.
        snapshot("local", "completed", "WRONG LOCAL ANSWER");
        if (!options.wrongHostOnly) snapshot("remote:server", options.active || started && options.hang ? "inProgress"
          : started ? "completed" : "idle", "remote final answer");
      }
      if (m.method === "thread-follower-start-turn") { started = true; reply({ turnId: "remote-turn" }); }
      if (m.method === "thread-follower-steer-turn") reply({ turnId: "remote-turn" });
      if (m.method === "thread-follower-interrupt-turn") reply({ ok: true });
    }));
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  const runner = new DesktopCodexRunner({ socketPath, codexHome: root, hostId: "remote:server", timeoutMs: 1000,
    observationTimeoutMs: 60, completionPollIntervalMs: 5, onObservationDiagnostic() {} });
  t.after(async () => { runner.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  return { runner, requests };
}

test("remote Desktop uses the native host envelope/version for one input and one guarded stop", async t => {
  const f = await fixture(t, { active: true });
  const receipt = await f.runner.submitThreadMessage({ threadId: "thread", cwd: "/remote/project", prompt: "more", clientUserMessageId: "stable-input" });
  assert.equal(receipt.turnId, "remote-turn");
  await f.runner.stop("thread", "remote-turn");
  const writes = f.requests.filter(m => m.method.startsWith("thread-follower-"));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].hostId, "remote:server"); assert.equal(writes[0].version, 2);
  assert.equal(writes[0].params.clientUserMessageId, "stable-input");
  assert.equal(writes[1].hostId, "remote:server"); assert.equal(writes[1].version, 5);
  assert.equal(writes[1].params.expectedTurnId, "remote-turn");
  assert.equal(f.requests.find(m => m.method === "thread-owner-discovery")?.params.hostId, "remote:server");
});

test("remote start observes the same Desktop turn without a local rollout or private native connection", async t => {
  const f = await fixture(t); const accepted: string[] = [];
  const result = await f.runner.run({ threadId: "thread", cwd: "/remote/project", prompt: "work", clientUserMessageId: "stable-input",
    onTurnStarted: event => { accepted.push(event.turnId); } });
  assert.equal(result.text, "remote final answer"); assert.deepEqual(accepted, ["remote-turn"]);
  const writes = f.requests.filter(m => m.method === "thread-follower-start-turn");
  assert.equal(writes.length, 1); assert.equal(writes[0].version, 3); assert.equal(writes[0].hostId, "remote:server");
  assert.equal((writes[0].params.turnStart as { request: { clientUserMessageId: string } }).request.clientUserMessageId, "stable-input");
});

test("a same-id local snapshot never authorizes a remote Desktop write", async t => {
  const f = await fixture(t, { wrongHostOnly: true });
  await assert.rejects(f.runner.submitThreadMessage({ threadId: "thread", cwd: "/remote/project", prompt: "more" }), { submission: "not-submitted" });
  assert.equal(f.requests.filter(m => m.method.startsWith("thread-follower-")).length, 0);
});

test("detaching remote observation for a Gateway restart cannot interrupt or replay the accepted task", async t => {
  const f = await fixture(t, { hang: true });
  const run = f.runner.run({ threadId: "thread", cwd: "/remote/project", prompt: "work",
    onTurnStarted: () => f.runner.detachIndependentObservations() });
  await assert.rejects(run, { submission: "accepted", turnId: "remote-turn" });
  assert.equal(f.requests.filter(m => m.method === "thread-follower-start-turn").length, 1);
  assert.equal(f.requests.filter(m => m.method === "thread-follower-interrupt-turn").length, 0);
});

test("remote compatibility stop uses its host protocol version even without the optional turn guard", async t => {
  const f = await fixture(t, { hang: true }); const accepted = Promise.withResolvers<void>();
  const run = f.runner.run({ threadId: "thread", cwd: "/remote/project", prompt: "work",
    onTurnStarted: () => { accepted.resolve(); } });
  const ended = assert.rejects(run, { submission: "accepted" });
  await accepted.promise; await f.runner.stop("thread"); f.runner.detachIndependentObservations(); await ended;
  const stop = f.requests.find(m => m.method === "thread-follower-interrupt-turn");
  assert.equal(stop?.version, 5); assert.equal(stop?.hostId, "remote:server");
});
