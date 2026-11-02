import path from "node:path";
import { realpath, writeFile } from "node:fs/promises";
import { TaskboardDatabase } from "../../server/database.mjs";
import { AiChatService } from "../../server/ai-chat.mjs";
import { fakeNativeCore } from "./native-backend.mjs";

export async function automationNativeFixture(root, options = {}) {
  const cwd = await realpath(root);
  const database = new TaskboardDatabase(path.join(root, "automation.sqlite"));
  database.createProject({ id: "project", name: "Project", workspacePath: cwd });
  const codexStatePath = path.join(root, "device.json");
  await writeFile(codexStatePath, "{}");
  const core = fakeNativeCore({ model: "gpt-5.5", ...options }), backend = core.client();
  const aiChat = new AiChatService({ database, nativeBackend: backend, codexStatePath, manageTaskboardSkillPath: path.join(root, "skill.md") });
  return { core, backend, aiChat, database, options: { aiChat, database, nativeBackend: backend },
    async close() { await aiChat.close(); await backend.close(); database.close(); } };
}
