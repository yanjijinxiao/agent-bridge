import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RemoteIDEIngress, type IDEIngressState } from "../src/ide/remote-ingress.js";

const input = { installation: "/fixture", hostId: "remote-fixture", localPort: 12345, ca: Buffer.alloc(0),
  access: { publicOrigin: "https://203.0.113.10:20015", bindAddress: "192.168.5.3", port: 80 } };
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); } assert.fail("health transition missing"); }
function fixture(probe: (n: number, signal: AbortSignal) => Promise<void>) {
  let connects = 0, closes = 0, probes = 0, end!: () => void;
  let current: IDEIngressState = { state: "connecting" };
  const ingress = new RemoteIDEIngress(input, state => { current = { ...current, ...state }; }, {
    async connect() { connects++; const closed = new Promise<void>(resolve => { end = resolve; });
      return { closed, async close() { closes++; end(); } }; },
    async probe(_input, signal) { await probe(++probes, signal); }
  }, { retryMs: 2, probeMs: 5 });
  return { ingress, status: () => ({ connects, closes, probes, current }), disconnect: () => end() };
}

test("isolated failed TLS probes preserve the relay and recovery clears the stale error", async t => {
  const f = fixture(async n => { if ([1, 2, 4, 5].includes(n)) throw Error("slow TLS"); });
  t.after(() => f.ingress.close()); f.ingress.start();
  await until(() => f.status().probes >= 6 && f.status().current.state === "ready");
  assert.equal(f.status().connects, 1); assert.equal(f.status().closes, 0);
  assert.equal(f.status().current.error, undefined);
});

test("three consecutive probe failures reconnect without an endless unhealthy relay", async t => {
  const f = fixture(async n => { if (n <= 3) throw Error("unreachable"); });
  t.after(() => f.ingress.close()); f.ingress.start();
  await until(() => f.status().connects === 2 && f.status().current.state === "ready");
  assert.equal(f.status().closes, 1); assert.equal(f.status().current.error, undefined);
});

test("a closed SSH owner reconnects immediately and shutdown stops probe retries", async () => {
  const f = fixture(async () => {}); f.ingress.start();
  try {
    await until(() => f.status().current.state === "ready"); f.disconnect();
    await until(() => f.status().connects === 2 && f.status().current.state === "ready");
  } finally { await f.ingress.close(); }
  const stopped = f.status(); await delay(25);
  assert.deepEqual(f.status(), stopped);
});
