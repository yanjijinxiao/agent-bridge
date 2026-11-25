import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { BridgeService } from "../src/bridge/service.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { APP_SERVER_BACKEND_CAPABILITIES } from "../src/codex/backend.js";
import { INBOUND_FILE_RECEIVER, stageFilesUsingCommand, type StageInboundFiles } from "../src/codex/inbound-files.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { eventually } from "./helpers/gap-browser.js";

const targets: Array<{ name: string; args: string[] }> = JSON.parse(process.env.CODEX_SSH_FILE_TEST_TARGETS ?? "[]");
const exec = promisify(execFile);
for (const target of targets) for (const change of ["rebind", "revoke"] as const) {
  test(`SSH attachment transfer cannot enqueue after ${change} during receipt of bytes (${target.name})`, { timeout: 65000 }, async t => {
    const remote = async (script: string) => (await exec("ssh", [...target.args, script], { timeout: 10000 })).stdout.trim();
    const home = await remote('mktemp -d "$HOME/ab-stage-XXXXXXXX"');
    assert.match(home, /^\/[a-zA-Z0-9/_.-]+\/ab-stage-[A-Za-z0-9]{8}$/);
    t.after(async () => { await remote(`rm -rf -- '${home}'`); });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-stage-owner-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "payload.bin");
    const body = crypto.randomBytes(2 * 1024 * 1024);
    fs.writeFileSync(file, body);
    const state = new RuntimeStateStore(resolveStatePaths(root));
    const project = state.createProject("Remote", root, { sourceProjectId: "p", hostId: "remote", projectKind: "remote" });
    const original = state.createSession("actor", root, "Remote", project.id);
    state.setSessionThread(original.id, "original");
    const receiptsPath = path.join(root, "receipts.jsonl");
    const receipts = new InboundReceiptJournal(receiptsPath);
    // The normal receiver already consumes stdin. Pause its stream once after
    // the first real chunk, then release it from a second SSH connection.
    const barrier = `process.stdin.once('data', chunk => {
      process.stdin.pause();
      require('node:fs').writeFileSync('entered', String(chunk.length));
      const retry = setInterval(() => {
        if (require('node:fs').existsSync('release')) { clearInterval(retry); process.stdin.resume(); }
      }, 25);
    });`;
    let staged: string | undefined;
    const stage: StageInboundFiles = async (files, options) => {
      const script = Buffer.from(barrier + INBOUND_FILE_RECEIVER).toString("base64");
      const result = await stageFilesUsingCommand(files, options.scope, options.maxBytes, async () => ({
        command: "ssh", args: [...target.args, `cd '${home}' && exec node -e "eval(Buffer.from('${script}','base64').toString())" -- '${home}'`],
      }));
      staged = result[0].path;
      return result;
    };
    let enqueues = 0;
    const service = new BridgeService({ stateStore: state, inboundDir: root, inputReceipts: receipts,
      config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: false },
      channel: { ...createChannelClient("generic", TEXT_CAPABILITIES, { async sendText() { return { messageId: "sent" }; } }),
        async resolveAttachments() { return [{ kind: "file", label: "payload.bin", path: file }]; } },
      runner: {
        backendInfo() { return { id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }; },
        async inspectThread() { return { threadId: "original", persistence: "active", runtimeStatus: "idle", activeFlags: [] }; },
        stageAttachments: stage,
        async addQueuedSubmission() { enqueues++; throw Error("retired source reached queue"); },
      } as never,
    });
    const message = { id: "source", senderId: "actor", text: "/queue inspect attachment",
      attachments: [{ kind: "file" as const, label: "payload.bin", path: file, item: {} }], raw: {} };
    const pending = receipts.handle(message, () => service.handleMessage(message)).catch(() => {});
    try {
      const first = await eventually(async () => Number(await remote(`if test -f '${home}/entered'; then cat '${home}/entered'; fi`)),
        "SSH receiver did not get bytes", 13000);
      assert.ok(first > 0 && first < body.length);
      if (change === "rebind") {
        const next = state.createSession("actor", root, "Replacement", project.id);
        state.setSessionThread(next.id, "replacement");
      } else state.setRole("actor", "actor", "viewer");
    } finally { await remote(`touch '${home}/release'`); await pending; }
    assert.equal(enqueues, 0);
    assert.equal(new InboundReceiptJournal(receiptsPath).receipt("source")?.phase, "received");
    assert.ok(staged?.startsWith(home + "/.codex-im-gateway/inbound/"));
    assert.match(staged!, /\/[a-f0-9]{64}\/[a-f0-9]{64}-payload\.bin$/);
    const receipt = await remote(`stat -c '%a %s' '${staged}'; sha256sum '${staged}'; find '${home}/.codex-im-gateway' -type f | wc -l`);
    const [stat, digest, count] = receipt.split("\n");
    assert.equal(stat, `600 ${body.length}`);
    assert.equal(digest.split(/\s/)[0], crypto.createHash("sha256").update(body).digest("hex"));
    assert.equal(Number(count), 1);
  });
}
