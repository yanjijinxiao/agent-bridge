import { RuntimeHandoffCoordinator, RuntimeHandoffJournal } from "../../src/agents/handoff.js";
import { JsonLineClient } from "../../src/agents/json-line-client.js";

const [, , file, socketPath] = process.argv;
const rpc = new JsonLineClient({ socketPath, dialect: "json-rpc", timeoutMs: 30000 });
const coordinator = new RuntimeHandoffCoordinator({ async send(value) {
  await rpc.request("write", { text: value.text }, { write: true, beforeWrite: value.assertCurrent });
  return { kind: "terminal-written", ref: value.target.ref, incarnation: value.target.incarnation!, started: null };
} }, new RuntimeHandoffJournal(file));
try {
  await coordinator.sendOnce({ source: { principal: "channel:user:chat", sourceId: "message1", operationId: "send1" },
    target: { ref: { endpointId: "runtime1", id: "terminal1" }, kind: "terminal", title: "Same name", state: "idle",
      evidence: "terminal-detection", incarnation: "program1", identityStrength: "observed", cwd: "/tmp/work" },
    text: "test input never persisted", assertCurrent() {} });
} finally { rpc.close(); }
