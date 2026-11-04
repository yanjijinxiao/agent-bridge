import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { peerCertificateAuthority } from "../src/peer/gateway-trust.js";
import { GatewayPeerClient, GatewayPeerServer } from "../src/peer/transport.js";
import { IDETLSManager } from "../src/ide/tls.js";

const endpoint = "wss://11.158.199.29:49186/gateway/v1/peer";

test("Tantan without caFile selects the reviewed persistent CA, not a short-lived leaf", () => {
  const ca = peerCertificateAuthority(endpoint)!;
  const cert = new X509Certificate(ca);
  assert.equal(cert.ca, true);
  assert.equal(cert.verify(cert.publicKey), true);
  assert.equal(cert.fingerprint256, "9E:3E:CF:DC:BA:F8:3A:D6:22:53:C3:02:CA:B7:51:86:94:91:0F:E3:3D:D7:31:08:F6:4D:8C:72:79:03:30:51");
  assert.equal(new Date(cert.validTo).toISOString(), "2031-11-03T08:26:10.000Z");
  ca.fill(0);
  assert.equal(new X509Certificate(peerCertificateAuthority(endpoint)!).fingerprint256, cert.fingerprint256);
});

test("bundled Gateway trust is limited to the exact WSS endpoint", () => {
  for (const url of [
    "wss://other.example/gateway/v1/peer", "wss://11.158.199.43:49186/gateway/v1/peer",
    "wss://11.158.199.29:49187/gateway/v1/peer", "ws://11.158.199.29:49186/gateway/v1/peer",
    endpoint + "?next=other", endpoint + "#other", endpoint + "/", endpoint.replace("/gateway/v1/peer", "/other"),
    endpoint.replace("wss://", "wss://user@"), "wss://example.com/gateway/v1/peer"
  ]) assert.equal(peerCertificateAuthority(url), undefined, url);
});

test("explicit CA overrides bundled trust even when the override is empty or invalid", () => {
  for (const ca of [Buffer.from("operator CA"), Buffer.alloc(0)]) {
    assert.equal(peerCertificateAuthority(endpoint, ca), ca);
    assert.equal(peerCertificateAuthority("wss://example.com/gateway/v1/peer", ca), ca);
  }
});

test("peer TLS rejects untrusted and wrong-address servers before sending device credentials", { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "peer-trust-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new IDETLSManager(path.join(root, "authority"));
  const valid = await authority.prepare("127.0.0.1"), wrongAddress = await authority.prepare("127.0.0.2");
  const foreign = new IDETLSManager(path.join(root, "foreign")); await foreign.prepare("127.0.0.1");
  for (const [name, files, ca, expected] of [
    ["explicit CA", valid, authority.caCertificate(), true],
    ["unknown endpoint without CA", valid, undefined, false],
    ["foreign CA", valid, foreign.caCertificate(), false],
    ["trusted CA but wrong IP", wrongAddress, authority.caCertificate(), false]
  ] as const) await t.test(name, async t => {
    let accepted = 0;
    const token = "isolated-connector-trust-fixture-credential";
    const server = await GatewayPeerServer.listen({ host: "127.0.0.1", port: 0, credentials: { fixture: token },
      tls: { cert: fs.readFileSync(files.certFile), key: fs.readFileSync(files.keyFile) }, accept(connectionId, connection) {
        accepted++; connection.handle("trust.probe", () => connectionId);
      } });
    t.after(() => server.close());
    const outcome = Promise.withResolvers<boolean>();
    const client = new GatewayPeerClient({ url: server.url, nodeId: "fixture", token, ca, reconnectMs: 60000,
      connected: async connection => { assert.equal(await connection.request("trust.probe", {}), "fixture"); outcome.resolve(true); },
      status: state => { if (state === "disconnected") outcome.resolve(false); } });
    t.after(() => client.close());
    client.start(); assert.equal(await outcome.promise, expected); assert.equal(accepted, expected ? 1 : 0);
  });
});
