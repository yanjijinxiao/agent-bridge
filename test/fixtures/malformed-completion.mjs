import readline from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const malformed = JSON.parse(process.argv[2]);
let starts = 0;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id == null) return;
  const reply = result => send({ id: m.id, result });
  if (m.method === "initialize") return reply({ userAgent: "completion-boundary-fixture" });
  if (m.method === "thread/start") return reply({ thread: { id: "thread" } });
  if (m.method === "thread/unsubscribe") return reply({});
  if (m.method === "turn/start") {
    if (++starts !== 1) throw Error("input replayed");
    reply({ turn: { id: "turn", status: "inProgress" } });
    send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", ...malformed } } });
    // The later authoritative failure must not be hidden by the invalid event.
    setTimeout(() => send({ method: "turn/completed", params: { threadId: "thread",
      turn: { id: "turn", status: "failed", error: { message: "authoritative failure" } } } }), 40);
    return;
  }
  send({ id: m.id, error: { code: -32601, message: m.method } });
});
