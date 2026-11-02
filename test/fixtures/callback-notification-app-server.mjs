import readline from "node:readline";

const kind = process.argv[2];
let emitted = false, answered = false;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params = {} } = JSON.parse(line);
  if (!method) { answered = true; continue; }
  if (id === undefined) continue;
  let result;
  if (method === "initialize") result = {};
  else if (["thread/resume", "thread/read"].includes(method)) result = { thread: { id: params.threadId, status: { type: "idle" } } };
  else if (method === "thread/turns/list") result = { data: [], nextCursor: null };
  else if (method === "config/read") {
    if (answered) { send({ id, error: { code: -32602, message: "unexpected synthetic answer" } }); continue; }
    result = { config: { model: "fixture" } };
    if (!emitted) {
      emitted = true;
      setImmediate(() => {
        send({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
        if (kind === "progress" || kind === "command-preview") send({ method: "item/started", params: { threadId: "thread", turnId: "turn",
          item: { id: "command", type: "commandExecution", command: kind === "command-preview" ? JSON.parse(process.argv[3]) : "node --version" } } });
        else send({ id: "notice", method: kind === "approval" ? "item/commandExecution/requestApproval"
          : kind === "mcp" ? "mcpServer/elicitation/request" : "item/tool/requestUserInput",
          params: { threadId: "thread", turnId: "turn" } });
      });
    }
  } else if (method === "thread/unsubscribe") result = { status: "unsubscribed" };
  else throw new Error(`Unexpected fixture method ${method}`);
  send({ id, result });
}
