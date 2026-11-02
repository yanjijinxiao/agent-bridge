import readline from "node:readline";
import fs from "node:fs";

const shape = process.argv[2];
let writes = 0;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) continue;
  fs.appendFileSync(process.argv[3], `${method}\n`);
  let result;
  if (method === "initialize") result = {};
  else if (method === "thread/resume") result = { thread: shape === "missing" ? {} : { id: shape === "empty" ? "" : "foreign-thread" } };
  else if (method === "thread/read") result = { thread: { id: shape === "inspect-foreign" ? "foreign-thread" : params.threadId,
    status: { type: "idle" }, projectId: null } };
  else if (method === "thread/turns/list" || method === "thread/list") result = { data: [], nextCursor: null };
  else if (method === "thread/unsubscribe") result = { status: "unsubscribed" };
  else if (method === "config/read") result = { config: { model: "fixture" }, writes };
  else {
    writes++;
    send({ id, error: { code: -32602, message: "fixture refused an unexpected write" } });
    continue;
  }
  send({ id, result });
}
