import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { TaskboardClient } from "../src/taskboard/client.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";

for (const operation of ["create", "project-create", "comment", "comment-ack", "attachment"] as const) {
  for (const change of ["none", "role", "detach", "rebind"] as const) {
    test(`Taskboard ${operation} checks its original authority after preparation: ${change}`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-taskboard-source-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
      const project = store.createProject("Original", root);
      const session = store.createSession("room", root, "Original", project.id);
      store.setSessionThread(session.id, "native");
      const item = { id: "issue", identifier: "P-1", projectId: project.id, title: "Issue", description: "",
        status: "in_progress", priority: "none", labels: [], threadId: "native", version: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const writes: string[] = [];
      let lookups = 0;
      const wait = async () => { entered.resolve(); await release.promise; };
      const client = new TaskboardClient({ baseUrl: "http://127.0.0.1:47823", fetch: async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === "POST") {
          writes.push(url.pathname);
          if (url.pathname === "/api/projects") return Response.json({ project: { id: project.id, name: project.name,
            workspacePath: root, issueCount: 0, createdAt: item.createdAt, updatedAt: item.updatedAt } });
          if (url.pathname === "/api/tasks") return Response.json({ task: item });
          if (url.pathname.endsWith("/comments")) {
            if (operation === "comment-ack") await wait();
            return Response.json({ comment: { id: "c", taskId: item.id, body: "progress", threadId: "native",
              createdAt: item.createdAt, updatedAt: item.updatedAt } });
          }
          if (url.pathname.endsWith("/attachments")) return Response.json({ attachment: { id: "f", taskId: item.id,
            filename: "source.txt", contentType: "text/plain", size: 4, createdAt: item.createdAt } });
        }
        if (url.pathname === "/api/projects") {
          if (operation === "create" || operation === "project-create") await wait();
          if (operation === "project-create") return Response.json({ projects: [] });
          return Response.json({ projects: [{ id: project.id, name: project.name, workspacePath: root, issueCount: 1,
            createdAt: item.createdAt, updatedAt: item.updatedAt }] });
        }
        if (url.pathname === "/api/tasks/P-1") {
          if (operation === "comment" && ++lookups === 2) await wait();
          return Response.json({ task: item });
        }
        if (url.pathname.endsWith("/comments")) return Response.json({ comments: [] });
        throw Error(`Unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
      } });
      const file = path.join(root, "source.txt"); fs.writeFileSync(file, "data");
      const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["room"] }, stateStore: store,
        taskboard: client, inboundDir: root, channel: createChannelClient("generic", { ...TEXT_CAPABILITIES, tasks: "available",
          inbound: { ...TEXT_CAPABILITIES.inbound, file: "available" } }, { async sendText() { return { messageId: "text" }; },
          async sendTaskCard() { return { messageId: "card" }; },
          async resolveAttachments(message) { await wait(); return message.attachments.map(a => ({ ...a, path: file })); } }) });
      const query = new URLSearchParams(operation === "create" || operation === "project-create" ? { operation: "create_todo", title: "New" }
        : { operation: "comment", identifier: "P-1", version: "1", body: "progress" });
      query.set("request_id", "00000000-0000-4000-8000-000000000021");
      const result = service.handleMessage({ id: "source", senderId: "alice", replyTargetId: "room",
        text: operation === "attachment" ? "/task attach P-1" : `/task submit ${query}`,
        attachments: operation === "attachment" ? [{ kind: "file", label: "source.txt", item: {} }] : [], raw: {} })
        .then(() => ({ error: undefined }), error => ({ error }));
      await entered.promise;
      const beforeChange = store.getActiveSession("room")?.id;
      if (change === "role") store.setRole("room", "alice", "viewer");
      if (change === "detach" || change === "rebind") store.detachSessionSelection("room");
      if (change === "rebind") store.activateSession(session.id);
      release.resolve(); const outcome = await result;
      if (change === "none") assert.equal(outcome.error, undefined);
      assert.equal(writes.length, operation === "comment-ack" ? 1 : change === "none" ? operation === "project-create" ? 2 : 1 : 0,
        "a preparation wait cannot authorize a later foreign write");
      if (change === "detach") assert.equal(store.getActiveSession("room"), undefined);
      if (change === "role") assert.equal(store.getActiveSession("room")?.id, beforeChange);
      if (operation === "comment-ack") {
        store.setRole("room", "alice", "participant"); store.activateSession(session.id);
        await service.handleMessage({ id: "same-form-again", senderId: "alice", replyTargetId: "room",
          text: `/task submit ${query}`, attachments: [], raw: {} });
        assert.equal(writes.length, 1, "a known successful write cannot be replayed after its stale binding update is refused");
      }
    });
  }
}

test("Taskboard checks upload authority after its asynchronous file read", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-taskboard-file-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "source.txt"); fs.writeFileSync(file, "data");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const readFile = fsPromises.readFile; let allowed = true, writes = 0;
  t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof readFile>) => {
    const data = await Reflect.apply(readFile, fsPromises, args);
    if (args[0] === file) { entered.resolve(); await release.promise; }
    return data;
  });
  const client = new TaskboardClient({ baseUrl: "http://127.0.0.1:47823", fetch: async () => {
    writes++; throw Error("a revoked upload must never reach transport");
  } }).withWriteGuard(() => { if (!allowed) throw Error("source revoked"); });
  const failed = assert.rejects(client.uploadAttachment("issue", file), /source revoked/);
  await entered.promise; allowed = false; release.resolve(); await failed;
  assert.equal(writes, 0);
});
