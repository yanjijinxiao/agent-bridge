import readline from "node:readline";
const thread = id => ({ id, name: id, cwd: "/work", source: "cli", status: { type: "notLoaded" }, projectId: null });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = {};
  else if (request.method === "thread/list") {
    if (process.argv.includes("--reject")) {
      process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32602, message: "private provider token=TEST-SECRET /private/user/path" } }) + "\n"); continue;
    }
    // Match the native contract: an explicitly empty provider filter lists
    // older providers too. Every page must retain the same filtering scope.
    const all = Array.isArray(request.params.modelProviders) && request.params.modelProviders.length === 0;
    result = { data: [thread(request.params.cursor ? "previous-provider" : "current-provider")], nextCursor: all && !request.params.cursor ? "older" : null };
  } else throw Error("Unexpected mutation/read: " + request.method);
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
}
