import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createHerdrRuntime, type HerdrRuntimeConfig } from "../src/agents/config.js";
import type { ResourceRef } from "../src/agents/contracts.js";
import { HerdrAppViewClient } from "../src/agents/herdr/app-view.js";
import { GatewayPeerServer } from "../src/peer/transport.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { connectorOnlyBackend } from "../src/peer/backend.js";
import { peerPrincipal } from "../src/peer/context.js";
import { BridgeService } from "../src/bridge/service.js";
import { InboundReceiptJournal } from "../src/bridge/inbound-receipts.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { resourceBindingId } from "../src/agents/resource-catalog.js";

// Opt-in: creates and deletes only its own terminal. No production Gateway or
// Connector config is modified. The channel is a capture sink, not DingTalk.
// TUI uses a real Codex CLI; App uses an OSC-reporting Python PTY fixture.
for (const kind of ["herdr-tui", "herdr-app"] as const) {
  const available = kind === "herdr-tui" ? process.env.HERDR_LIVE_TUI_SOCKET && process.env.HERDR_LIVE_TUI_CWD
    : process.env.HERDR_LIVE_APP_SOCKET && process.env.HERDR_LIVE_CORE_SOCKET && process.env.HERDR_LIVE_CORE_ID;
  test(`${kind}: live production Connector handoff and SIGKILL recovery preserve the original terminal`,
    { skip: !available, timeout: 100000 }, async t => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "herdr-live-connector-")));
      const runtime: HerdrRuntimeConfig = kind === "herdr-tui"
        ? { version: 1, id: "live-test", kind, socketPath: process.env.HERDR_LIVE_TUI_SOCKET!, interruptKeys: { codex: "esc" } }
        : { version: 1, id: "live-test", kind, coreSocketPath: process.env.HERDR_LIVE_CORE_SOCKET!,
          windowSocketPath: process.env.HERDR_LIVE_APP_SOCKET!, expectedCoreId: process.env.HERDR_LIVE_CORE_ID! };
      const adapter = createHerdrRuntime(runtime), principal = { actorId: "live-test-person", conversationId: "live-test-room", accountId: "live-test-bot" };
      let created: ResourceRef | undefined, projectId: string | undefined, child: ChildProcess | undefined, bridge: BridgeService | undefined;
      const managed = { hostId: "herdr-live-test", nodeId: "herdr-live-test", profileId: "work", grantId: crypto.randomUUID() };
      const registry = new PeerRegistry(path.join(root, "grants.json"), [managed]);
      const token = crypto.randomBytes(32).toString("hex");
      const gateway = await GatewayPeerServer.listen({ host: "127.0.0.1", port: 0, credentials: { [managed.nodeId]: token },
        accept: (id, connection) => registry.accept(id, connection) });
      const stop = async () => {
        if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; }
        child = undefined;
        for (let i = 0; registry.isOnline(managed.hostId) && i < 100; i++) await new Promise(r => setTimeout(r, 10));
      };
      t.after(async () => {
        bridge?.suspendUserInputs(); await stop(); registry.close(); await gateway.close();
        try {
          if (created) {
            const current = await adapter.inspect(created);
            if (current.state !== "exited") await adapter.closeResource!({ target: current, assertCurrent() {} });
            if (kind === "herdr-app" && projectId) {
              const catalog = await adapter.catalog(), project = catalog.projects.find(p => p.id === projectId);
              // App may already remove an empty space after terminal.kill.
              if (!project) return;
              assert.ok(project.roots.includes(root), "cleanup requires the exact created directory");
              assert.ok(catalog.resources.filter(r => r.projectId === projectId).every(r => r.ref.id === created!.id));
              const view = new HerdrAppViewClient(process.env.HERDR_LIVE_APP_SOCKET!);
              try { await (view as any).request({ do: "space.close", args: { id: projectId, confirmed: true } }, { write: true }); }
              finally { view.close(); }
            }
          }
        } finally { adapter.close(); fs.rmSync(root, { recursive: true, force: true }); }
      });
      const before = await adapter.catalog(), name = "bridge-live-" + Date.now();
      const appProgram = "import sys,time,os\ndef state(s):\n print(chr(27)+']7501;state='+s+':app=bridge-probe'+chr(7),flush=True)\nstate('idle')\nfor line in sys.stdin:\n with open('received.txt','a') as f: f.write(line)\n state('working')\n print('HERDR_LIVE_CONNECTOR_OK',flush=True)\n time.sleep(5)\n state('idle')\n";
      const target = await adapter.create!({ cwd: kind === "herdr-tui" ? process.env.HERDR_LIVE_TUI_CWD! : root,
        title: name, program: kind === "herdr-tui" ? "codex" : "python3",
        args: kind === "herdr-tui" ? ["-c", "check_for_update_on_startup=false"] : ["-u", "-c", appProgram],
        assertCurrent() {}, onCreated(ref) { created = ref; } });
      projectId = target.projectId;
      for (let i = 0; i < 40; i++) {
        if ((await adapter.inspect(target.ref)).state === "idle") break;
        await new Promise(r => setTimeout(r, 500));
      }
      assert.equal((await adapter.inspect(target.ref)).state, "idle");
      const config = path.join(root, "connector.json"); fs.writeFileSync(path.join(root, "token"), token, { mode: 0o600 });
      fs.writeFileSync(config, JSON.stringify({ url: gateway.url, nodeId: managed.nodeId, tokenFile: "token", stateDir: "connector-state",
        profileId: managed.profileId, backend: kind, runtime, managedRoute: { hostId: managed.hostId, grantId: managed.grantId } }));
      const start = async () => {
        let output = "";
        child = spawn(process.execPath, ["--import", "tsx", "src/peer/index.ts", "--config", config], { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout!.on("data", b => { output += b; }); child.stderr!.on("data", b => { output += b; });
        const deadline = Date.now() + 10000;
        while (!registry.isOnline(managed.hostId)) {
          if (child.exitCode !== null || child.signalCode || Date.now() > deadline) throw Error("Test Connector unavailable: " + output);
          await new Promise(r => setTimeout(r, 20));
        }
      };
      await start(); const facade = connectorOnlyBackend(registry), id = resourceBindingId(target.ref);
      const as = <T>(fn: () => T) => peerPrincipal.run(principal, fn);
      assert.ok((await as(() => facade.listSessionCatalog({}, managed.hostId))).threads.some(t => t.threadId === id));
      const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "gateway-state")));
      const session = store.createSession(principal.conversationId, target.cwd!, name, undefined, undefined, undefined, { hostId: managed.hostId });
      store.setSessionThread(session.id, id);
      const receipts = new InboundReceiptJournal(path.join(root, "inbound.jsonl"));
      const cards: Array<{ text: string; finalize?: boolean }> = []; let mentions = 0, n = 0;
      const channel = createChannelClient("dingtalk", { ...TEXT_CAPABILITIES, progress: "available", mentions: "available" }, {
        async sendText(input) { cards.push(input); return { messageId: String(++n) }; },
        async startTextStream(input) { cards.push(input); return { messageId: String(++n) }; },
        async updateTextStream(input) { cards.push(input); }, async sendMentionNotification() { mentions++; return { messageId: String(++n) }; }
      });
      const makeBridge = () => new BridgeService({ accountId: principal.accountId, stateStore: store, runner: facade, channel, inputReceipts: receipts,
        config: { ...defaultConfig(root), streamReplies: true, allowedSenderIds: [principal.actorId] },
        ideProgressEntry: () => "https://example.test/workspace/live-herdr", peer: { hosts: p => registry.hosts(p),
          label: h => registry.label(h), isOnline: h => registry.isOnline(h), connect: (code, p, guard) => registry.connect(code, p, guard) } });
      bridge = makeBridge();
      const message = { id: "live-one-input", text: "只回复 HERDR_LIVE_CONNECTOR_OK，不要使用工具、不要读写文件。", senderId: principal.actorId,
        replyTargetId: principal.conversationId, conversationKind: "group" as const, mention: { userId: principal.actorId }, attachments: [], raw: {} };
      await receipts.handle(message, () => bridge!.handleMessage(message));
      assert.equal(receipts.receipt(message.id)?.phase, "handled", JSON.stringify(cards));
      assert.equal(receipts.receipt(message.id)?.runtimeInput, true);
      assert.equal(bridge.hasRestartBlockingWork(), false);
      bridge.suspendUserInputs(); await stop(); await start(); bridge = makeBridge();
      for (let i = 0; i < 90 && !cards.some(c => c.finalize && c.text.includes("终端当前空闲")); i++) {
        await (bridge as any).runtimeObserver.tick(); await new Promise(r => setTimeout(r, 500));
      }
      assert.ok(cards.some(c => c.text.includes("HERDR\\_LIVE\\_CONNECTOR\\_OK")), "screen is escaped display data");
      assert.ok(cards.some(c => c.finalize && c.text.includes("不代表任务成功")));
      assert.ok(cards.some(c => c.text.includes("https://example.test/workspace/live-herdr")));
      assert.equal(mentions, 1);
      assert.equal(receipts.receipt(message.id)?.turnId, undefined);
      if (kind === "herdr-app") assert.equal(fs.readFileSync(path.join(root, "received.txt"), "utf8").trim(), message.text);
      const after = await adapter.catalog();
      for (const resource of before.resources) assert.ok(after.resources.some(r => r.ref.id === resource.ref.id), "pre-existing terminal preserved");
    });
}
