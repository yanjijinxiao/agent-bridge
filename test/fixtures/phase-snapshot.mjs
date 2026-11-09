import fs from "node:fs";
import readline from "node:readline";
const [stateFile, traceFile] = process.argv.slice(2);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line); if (m.id === undefined) continue;
  fs.appendFileSync(traceFile, JSON.stringify({ method: m.method, params: m.params }) + "\n");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  let result;
  if (m.method === "initialize") result = {};
  else if (m.method === "thread/read") result = { thread: { id: "thread", status: { type: "active", activeFlags: [] } } };
  else if (m.method === "thread/turns/list") {
    const full = m.params.itemsView === "full";
    if (full && state.readFailure) {
      process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32000, message: "temporary read failure" } }) + "\n");
      continue;
    }
    const texts = full ? state.phases : state.phases.slice(0, 1);
    result = { data: [{ id: full && state.mismatch ? "foreign" : "turn", status: "inProgress", itemsView: full && state.badView ? "summary" : m.params.itemsView,
      startedAt: Date.now() / 1000, completedAt: null,
      items: texts.map((text, i) => ({ id: `phase-${i}`, type: "agentMessage", phase: "commentary", text }))
        .concat(full ? [{ id: "compact", type: "contextCompaction" },
          { id: "command", type: "commandExecution", aggregatedOutput: "PRIVATE_TOOL_OUTPUT" }] : []) }], nextCursor: null };
  } else throw Error(`Unexpected operation ${m.method}`);
  process.stdout.write(JSON.stringify({ id: m.id, result }) + "\n");
}
