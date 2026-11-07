import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { RuntimeError, assertSameResource, terminalOperations, type AgentRuntimeAdapter, type RuntimeResource, type RuntimeWrite } from "../src/agents/contracts.js";
import { RuntimeResourceCatalog, resourceBindingId } from "../src/agents/resource-catalog.js";
import { PeerExecutionService } from "../src/peer/execution-service.js";
import { GatewayPeerServer, GatewayPeerClient } from "../src/peer/transport.js";
import { PeerRegistry } from "../src/peer/registry.js";
import { connectorOnlyBackend } from "../src/peer/backend.js";
import { peerPrincipal, type PeerPrincipal } from "../src/peer/context.js";
import type { PeerConnection } from "../src/peer/rpc.js";
import type { PeerExecutionOptions } from "../src/peer/execution-service.js";
import { principal, token } from "./peer-fixture.js";

/** Real Gateway/Connector transport and authorization; deterministic runtime
 * boundary for fault injection. Adapter JSONL and real-host tests are separate. */
export async function runtimePeerFixture(t: TestContext, kind: "herdr-app" | "herdr-tui" = "herdr-app", options: { fixed?: boolean; managed?: boolean; approve?: boolean; webIDE?: PeerExecutionOptions["webIDE"]; interrupt?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-peer-"));
  const clientDir = path.join(root, "connector"); fs.mkdirSync(clientDir);
  const cwd = path.join(root, "workspace"); fs.mkdirSync(cwd);
  const resources: RuntimeResource[] = [{ ref: { endpointId: `${kind}:fixture`, id: "terminal-1" }, kind: "terminal", title: "Fixture agent",
    projectId: "workspace-1", cwd, state: "idle", evidence: "program-report", incarnation: "first-process", identityStrength: "observed", agent: "fixture" }];
  const writes: string[] = [], stops: string[] = [];
  let barrier: (() => Promise<void>) | undefined, afterWrite: (() => Promise<void>) | undefined;
  let screen = "ordinary terminal text";
  const runtime: AgentRuntimeAdapter = {
    async describe() { return { kind, endpointId: resources[0].ref.endpointId, version: "fixture", protocol: { name: "fixture" },
      operations: terminalOperations({ create: { supported: true, semantics: "launch" }, rename: { supported: true, semantics: "name" },
        delete: { supported: true, semantics: "close" }, ...(options.interrupt === false ? { interrupt: { supported: false as const, reason: "无结构化中断接口" } } : {}) }) }; },
    async catalog() { return { projects: [{ id: "workspace-1", name: "Project", roots: [cwd] }, { id: "empty", name: "Empty project", roots: [] }],
      resources: structuredClone(resources), complete: true, warnings: [] }; },
    async inspect(ref) { const r = resources.find(r => r.ref.id === ref.id && r.ref.endpointId === ref.endpointId);
      if (!r) throw new RuntimeError("changed", "missing resource"); return structuredClone(r); },
    async read(ref) { await this.inspect(ref); return { kind: "terminal-screen", ref, text: screen, complete: true, source: "screen" }; },
    async send(input) {
      const state = await this.inspect(input.target.ref); assertSameResource(input.target, state);
      if (state.state !== "idle") throw new RuntimeError("not-ready", "not idle");
      await barrier?.(); await input.prepareWrite?.(); input.assertCurrent(); writes.push(input.text); await afterWrite?.();
      return { kind: "terminal-written", ref: state.ref, incarnation: state.incarnation!, started: true };
    },
    async create(input) {
      await input.prepareWrite?.(); input.assertCurrent();
      const r: RuntimeResource = { ...resources[0], ref: { ...resources[0].ref, id: `new-${resources.length}` },
        title: input.title, cwd: input.cwd, projectId: input.projectId ?? "workspace-1", incarnation: `created-${resources.length}` };
      input.onCreated(r.ref); resources.push(r); return structuredClone(r);
    },
    async rename(input) {
      await input.prepareWrite?.(); input.assertCurrent(); assertSameResource(input.target, await this.inspect(input.target.ref));
      const r = resources.find(r => r.ref.id === input.target.ref.id)!; r.title = input.title; return structuredClone(r);
    },
    async closeResource(input) {
      await input.prepareWrite?.(); input.assertCurrent(); assertSameResource(input.target, await this.inspect(input.target.ref));
      resources.find(r => r.ref.id === input.target.ref.id)!.state = "exited";
      return { kind: "closed", ref: input.target.ref, scope: kind === "herdr-tui" ? "pane" : "terminal-process" };
    },
    async interrupt(input: RuntimeWrite) {
      assertSameResource(input.target, await this.inspect(input.target.ref));
      await input.prepareWrite?.(); input.assertCurrent(); stops.push(input.target.ref.id);
      return { kind: "interrupt-requested", ref: input.target.ref, observation: "stopped" };
    }, close() {}
  };
  const catalog = new RuntimeResourceCatalog(runtime, await runtime.describe());
  const id = resourceBindingId(resources[0].ref);
  const managedRoute = options.managed ? { hostId: "local", grantId: "00000000-0000-4000-8000-000000000001", nodeId: "fixture", profileId: "fixture" } : undefined;
  const createService = () => PeerExecutionService.create({ backend: catalog, profileId: "fixture", stateDir: clientDir,
    managedRoute,
    threadId: options.fixed ? id : undefined, webIDE: options.webIDE, independent: true, approve: async () => options.approve !== false, approveOwner: async () => true });
  let service = await createService();
  const registry = new PeerRegistry(path.join(root, "gateway-grants.json"), managedRoute ? [managedRoute] : []);
  let serverConnection!: PeerConnection, clientConnection!: PeerConnection;
  const server = await GatewayPeerServer.listen({ host: "127.0.0.1", port: 0, credentials: { fixture: token },
    accept(node, connection) { serverConnection = connection; registry.accept(node, connection); } });
  let registered = Promise.withResolvers<{ hostId: string; code: string }>();
  const client = new GatewayPeerClient({ url: server.url, nodeId: "fixture", token, reconnectMs: 10,
    async connected(connection) { clientConnection = connection; service.attach(connection);
      registered.resolve(await connection.request("peer.register", service.description)); } });
  t.after(async () => { client.close(); registry.close(); await service.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  client.start(); const ticket = await registered.promise, facade = connectorOnlyBackend(registry);
  return { root, cwd, runtime, catalog, id, resources, registry, facade, ticket, writes, stops,
    get description() { return service.description; }, get serverConnection() { return serverConnection; }, get clientConnection() { return clientConnection; },
    set beforeWrite(value: (() => Promise<void>) | undefined) { barrier = value; },
    set afterWrite(value: (() => Promise<void>) | undefined) { afterWrite = value; },
    set screen(value: string) { screen = value; },
    bind: () => registry.connect(ticket.code, principal, () => {}),
    as: <T>(action: () => T, who: PeerPrincipal = principal) => peerPrincipal.run(who, action),
    input: (source = "source-1") => ({ threadId: id, target: structuredClone(resources[0]), text: "Hello", clientUserMessageId: source, assertCurrent() {} }),
    async reconnect(reload = true) {
      if (reload) { await service.close(); service = await createService(); }
      registered = Promise.withResolvers(); serverConnection.close(); await registered.promise;
    }
  };
}
