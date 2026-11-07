import assert from "node:assert/strict";
import test from "node:test";
import { closeConnectorResources } from "../src/peer/cleanup.js";

for (const failing of ["transport", "terminal", "native-observer", "ide-service", "host-service", "runtime", "lock", "none"])
  test(`Connector cleanup with ${failing} failure still attempts each independent resource`, async () => {
    const resources = ["transport", "terminal", "native-observer", "ide-service", "host-service", "runtime", "lock"], seen: string[] = [];
    const work = closeConnectorResources(resources.map(name => () => {
      seen.push(name);
      if (name === failing) { if (name === "ide-service") return Promise.reject(Error(name)); throw Error(name); }
    }));
    if (failing === "none") await work;
    else await assert.rejects(work, (e: unknown) => e instanceof AggregateError && e.errors.length === 1 && e.errors[0].message === failing);
    assert.deepEqual(seen, resources);
  });
