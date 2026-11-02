import readline from "node:readline";
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = {};
  else if (request.method === "thread/read") result = { thread: { id: request.params.threadId, status: { type: process.argv[2] }, projectId: null } };
  else if (request.method === "thread/turns/list") result = { data: [{ id: "previous-turn", status: process.argv[3], items: [] }], nextCursor: null };
  else throw new Error(`Unexpected runtime fixture method ${request.method}`);
  send({ id: request.id, result });
}
