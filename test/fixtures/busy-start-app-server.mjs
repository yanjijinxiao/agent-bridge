import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const reply = result => process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  if (request.method === "initialize") reply({ userAgent: "isolated-busy-start" });
  else if (request.method === "thread/read" || request.method === "thread/resume")
    reply({ thread: { id: request.params.threadId, cwd: "/tmp", status: { type: "idle" }, turns: [] } });
  else if (request.method === "thread/turns/list") reply({ data: [], nextCursor: null });
  else if (request.method === "turn/start") {
    if (process.argv.includes("--lost-receipt")) continue;
    process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32600, message: "thread already has an active turn" } }) + "\n");
  } else reply({});
}
