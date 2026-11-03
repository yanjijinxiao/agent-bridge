import fs from "node:fs";
import path from "node:path";
import { TaskboardDatabase } from "../../taskboard/server/database.mjs";
import { AiChatService } from "../../taskboard/server/ai-chat.mjs";
import { CodexAppServerGateway } from "../../src/codex/app-server-gateway.ts";
import { AppServerCodexRunner } from "../../src/codex/app-server-runner.ts";
import { APP_SERVER_SOCKET_RELAY } from "../../src/codex/app-server-socket-relay.ts";

// Fault injection is confined to this disposable child. The shared native core
// belongs to the parent test and is never signalled by this fixture.
const [file, mode] = process.argv.slice(2), c = JSON.parse(fs.readFileSync(file, "utf8"));
const database = new TaskboardDatabase(c.databasePath);
if (mode !== "recover") {
  const save = database.saveAiChatNativeReceipt.bind(database);
  database.saveAiChatNativeReceipt = (runId, receipt) => {
    if (receipt.phase !== "accepted") return save(runId, receipt);
    if (mode === "after") save(runId, receipt);
    fs.writeFileSync(c.marker, JSON.stringify({ runId, receipt }));
    process.kill(process.pid, "SIGKILL");
  };
}
const backend = new CodexAppServerGateway({ appServerBackend: new AppServerCodexRunner({
  codexHome: c.root, catalogSource: "native", requestTimeoutMs: 5000,
  transport: { command: process.execPath, args: ["-e", APP_SERVER_SOCKET_RELAY, c.endpoint], mode: "daemon-proxy" },
}) });
const service = new AiChatService({ database, nativeBackend: backend, codexStatePath: c.codexStatePath,
  manageTaskboardSkillPath: path.join(c.root, "fixture-skill.md") });
process.on("message", async m => {
  try {
    if (m.command === "snapshot") {
      const { runId } = JSON.parse(fs.readFileSync(c.marker, "utf8")), run = database.getAiChatRun(runId);
      process.send({ id: m.id, run, receipt: database.getAiChatNativeReceipt(runId),
        snapshot: service.getThreadSnapshot(run.threadId), submission: service.getSubmission(c.clientId) });
    } else if (m.command === "stop") {
      await service.close(); await backend.close(); database.close(); process.send({ id: m.id }); process.exit(0);
    }
  } catch (error) { process.send({ id: m.id, error: String(error) }); }
});
if (mode !== "recover") {
  const thread = await service.createThread({ projectId: "selected" });
  await service.startTurn(thread.id, { message: "TASKBOARD_CRASH_INPUT", clientRequestId: c.clientId });
}
process.send({ ready: true });
