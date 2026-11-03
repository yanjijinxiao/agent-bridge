import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerGateway } from "../src/codex/app-server-gateway.js";

for (const host of ["local", "remote-a"]) {
  for (const operation of ["models", "capabilities", "diagnostics"]) {
    test(`closed Gateway cannot acquire or query an executor (${host}, ${operation})`, async () => {
      let resolutions = 0, reads = 0;
      const gateway = new CodexAppServerGateway({ appServerBackend: {
        id: "app-server", capabilities: {}, close() {},
        listModels() { reads++; return Promise.resolve([]); },
        serverIdentity() { reads++; return Promise.resolve({ processId: 1 }); }
      } as never, remoteTransportResolver() {
        resolutions++; throw Error("unexpected remote connection acquisition");
      } });
      await gateway.close();
      const action = () => operation === "models" ? gateway.listModels(host)
        : operation === "diagnostics" ? gateway.serverIdentity(host) : gateway.backendInfo(host);
      await assert.rejects(Promise.resolve().then(action), /runner is closed/);
      assert.equal(resolutions, 0);
      assert.equal(reads, 0);
      assert.equal(gateway.hasInFlightWork(), false);
    });
  }
}

test("an open Gateway still delegates reads to its existing owner", async () => {
  let reads = 0;
  const gateway = new CodexAppServerGateway({ appServerBackend: {
    id: "app-server", capabilities: {}, close() {},
    listModels() { reads++; return Promise.resolve([{ model: "fixture" }]); }
  } as never });
  try { assert.equal((await gateway.listModels())[0].model, "fixture"); assert.equal(reads, 1); }
  finally { await gateway.close(); }
});

for (const operation of ["stage", "fetch"]) test(`closed Gateway cannot reacquire a file transport (${operation})`, async () => {
  let resolutions = 0;
  const gateway = new CodexAppServerGateway({ appServerBackend: { close() {} } as never,
    remoteTransportResolver() { resolutions++; throw Error("unexpected transport acquisition"); } });
  await gateway.close();
  const action = () => operation === "stage"
    ? gateway.stageAttachments([{ kind: "file", path: "/unused", label: "unused" }], { hostId: "remote-a", scope: "scope", maxBytes: 1 })
    : gateway.fetchOutputFile("/unused", { hostId: "remote-a", scope: "scope", maxBytes: 1, directory: "/unused" } as never);
  await assert.rejects(Promise.resolve().then(action), /runner is closed/);
  assert.equal(resolutions, 0);
});
