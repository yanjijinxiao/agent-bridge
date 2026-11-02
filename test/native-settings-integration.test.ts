import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sharedNativeCore } from "./fixtures/shared-native-core.mjs";

test("installed native protocol accepts explicit owning UI settings, images and same-core catalogs", {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30_000
}, async t => {
  const f = await sharedNativeCore(t), runner = f.runner(), peer = await f.rpc("settings");
  const image = path.join(f.root, "selected.png");
  fs.writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFElEQVR4nGP4TyJgGNUwqmH4agAAr639H708R/EAAAAASUVORK5CYII=", "base64"));
  const settings = { sandbox: "workspace-write" as const, approvalPolicy: "on-request" as const,
    approvalsReviewer: "user" as const, runtimeWorkspaceRoots: [fs.realpathSync(f.root)] };
  const items: string[] = [];
  const first = await runner.run({ cwd: fs.realpathSync(f.root), prompt: "read selected image", imagePaths: [image], nativeSettings: settings,
    clientUserMessageId: "owning-ui-1", onItem: item => { items.push(item.type); } });
  assert.equal(first.text, "DONE_1"); assert.ok(items.includes("agent_message"));
  const history = await peer.request("thread/read", { threadId: first.threadId, includeTurns: true });
  assert.ok(history.thread.turns[0].items.some((item: any) => item.type === "userMessage" && item.clientId === "owning-ui-1"));
  assert.ok(JSON.stringify(f.calls[0].input).includes("input_image"), "local image reaches the fake model");
  await runner.run({ threadId: first.threadId, cwd: fs.realpathSync(f.root), prompt: "continue once", nativeSettings: settings });
  assert.equal(f.calls.length, 2);
  assert.ok(Array.isArray(await runner.listSkills(fs.realpathSync(f.root))));
  assert.ok(Array.isArray(await runner.listMcpServers()));
  assert.equal((await runner.serverIdentity()).processId, (await peer.request("server/diagnostics")).process.id);
});
