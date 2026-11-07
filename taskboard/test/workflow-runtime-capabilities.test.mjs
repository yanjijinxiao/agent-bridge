import assert from "node:assert/strict";
import test from "node:test";
import { prepareNativeWorkflowNode } from "../server/workflow-native-nodes.mjs";

for (const kind of ["herdr-tui", "herdr-app"])
  for (const nodeKind of ["basic-planning", "skill", "mcp"])
    test(`${kind} ${nodeKind} checks structured execution before native queries`, async () => {
      let calls = 0;
      await assert.rejects(prepareNativeWorkflowNode({ node: { data: { kind: nodeKind } },
        run: { projectId: "project" }, context: {},
        aiChat: { async getCatalog() { calls++; throw Error("unexpected Skills query"); } },
        nativeBackend: { async backendInfo() { return { runtime: { kind, operations: { "structured-output": { supported: false } } } }; },
          async listMcpServers() { calls++; throw Error("unexpected MCP query"); } } }),
      error => error.code === "NATIVE_CONVERSATION_UNAVAILABLE" && /看板管理不受影响/.test(error.message));
      assert.equal(calls, 0);
    });

test("legacy native workflow preparation still returns the requested instruction", async () => {
  const result = await prepareNativeWorkflowNode({ node: { data: { kind: "run-tests", testScope: "related" } },
    run: { projectId: "project" }, context: {}, aiChat: {}, nativeBackend: {} });
  assert.match(result.turn.message, /实际运行测试/);
  assert.match(result.turn.message, /related/);
});
