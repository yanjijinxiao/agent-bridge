import assert from "node:assert/strict";
import test from "node:test";
import { connectorConfigSchema } from "../src/peer/config.js";
import { runtimeEndpointId } from "../src/agents/config.js";
import { resourceBindingId } from "../src/agents/resource-catalog.js";

const url = "ws://127.0.0.1:12345/gateway/v1/peer";
const tui = { version: 1 as const, id: "fixture", kind: "herdr-tui" as const, socketPath: "/private/tmp/fixture/herdr.sock" };
const app = { version: 1 as const, id: "fixture", kind: "herdr-app" as const, coreSocketPath: "/private/tmp/fixture/core.sock",
  windowSocketPath: "/private/tmp/fixture/app.sock", expectedCoreId: "fixture-core" };
test("old Connector configuration still chooses Codex without a runtime fallback", () => {
  const parsed = connectorConfigSchema.parse({ url, nodeId: "fixture", tokenFile: "device.token" });
  assert.equal(parsed.backend, "app-server"); assert.equal(parsed.runtime, undefined); assert.equal(parsed.appServerTransport, "daemon");
});
for (const runtime of [tui, app]) {
  test(`${runtime.kind}: explicit single runtime configuration is accepted`, () => {
    const parsed = connectorConfigSchema.parse({ url, backend: runtime.kind, runtime });
    assert.deepEqual(parsed.runtime, runtime);
  });
  test(`${runtime.kind}: missing runtime, mixed kind and implicit replacement are rejected`, () => {
    for (const value of [{ url, backend: runtime.kind }, { url, runtime },
      { url, backend: runtime.kind === "herdr-app" ? "herdr-tui" : "herdr-app", runtime }])
      assert.equal(connectorConfigSchema.safeParse(value).success, false);
  });
  test(`${runtime.kind}: Codex profile and remote-host exports cannot leak into the runtime`, () => {
    const base = { url, backend: runtime.kind, runtime };
    assert.equal(connectorConfigSchema.safeParse({ ...base, codexHome: "/private/tmp/codex-profile" }).success, false);
    for (const setting of [{ codexHome: "" }, { codexBin: "codex" }, { appServerTransport: "daemon" }])
      assert.equal(connectorConfigSchema.safeParse({ ...base, ...setting }).success, false);
    assert.equal(connectorConfigSchema.safeParse({ ...base, managedHosts: [{ hostId: "remote", nativeHostId: "another" }] }).success, false);
    assert.equal(connectorConfigSchema.safeParse({ ...base, unrecognized: true }).success, false);
  });
  test(`${runtime.kind}: endpoint identity survives JSON property order but not endpoint replacement`, () => {
    const reordered = Object.fromEntries(Object.entries(runtime).reverse()) as typeof runtime;
    assert.equal(runtimeEndpointId(runtime), runtimeEndpointId(reordered));
    assert.notEqual(runtimeEndpointId(runtime), runtimeEndpointId({ ...runtime, id: "replacement" }));
  });
}
test("App requires its configured core identity and both absolute sockets", () => {
  for (const change of [{ expectedCoreId: undefined }, { coreSocketPath: "relative.sock" }, { windowSocketPath: "~/app.sock" }, { version: 2 }])
    assert.equal(connectorConfigSchema.safeParse({ url, backend: "herdr-app", runtime: { ...app, ...change } }).success, false);
  assert.notEqual(runtimeEndpointId(app), runtimeEndpointId({ ...app, expectedCoreId: "other-core" }));
});
test("legacy credentials remain paired and cannot be half configured", () => {
  for (const change of [{ nodeId: "fixture" }, { tokenFile: "device.token" }])
    assert.equal(connectorConfigSchema.safeParse({ url, ...change }).success, false);
});
test("binding identity refuses overlong resource IDs instead of producing an unusable grant", () => {
  assert.throws(() => resourceBindingId({ endpointId: "x".repeat(200), id: "y".repeat(512) }), /长度限制/);
});
