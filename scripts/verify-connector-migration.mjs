#!/usr/bin/env node
// Read-only migration evidence. This tool never submits a prompt, resumes a
// thread, changes bindings, copies credentials into evidence or stops Codex.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const [mode, build, configOrApi, baselineFile, resultFile] = process.argv.slice(2);
if (!["snapshot", "verify"].includes(mode) || !build || !configOrApi || !baselineFile) throw Error("Usage: snapshot|verify build-dir api-url|peer-config baseline-file [result-file]");
const moduleAt = file => import(pathToFileURL(path.join(path.resolve(build), file)).href);
const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); };
async function mapBounded(items, fn) {
  const result = new Array(items.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => { while (index < items.length) { const n = index++; result[n] = await fn(items[n]); } })); return result;
}
const stateOf = state => ({ threadId: state.threadId, cwd: state.cwd, projectId: state.projectId, projectMembership: state.projectMembership,
  persistence: state.persistence, internal: state.internal === true });
if (mode === "snapshot") {
  const { CodexAppServerGateway } = await moduleAt("codex/app-server-gateway.js");
  const { withConnectorProjects } = await moduleAt("peer/project-catalog.js");
  const native = new CodexAppServerGateway({ appServerTransport: "daemon" });
  try {
    const response = await fetch(new URL("/api/sessions", configOrApi)); if (!response.ok) throw Error("Gateway snapshot unavailable");
    const { sessions } = await response.json();
    const bound = sessions.filter(s => s.binding?.bound && s.threadId && !s.hostId?.startsWith("peer:"));
    const hosts = [...new Set(bound.map(s => s.hostId ?? "local"))];
    const identity = {}, projects = {};
    for (const host of hosts) { identity[host] = await native.serverIdentity(host); projects[host] = await (host === "local" ? withConnectorProjects(native) : native).listProjects(host, { timeoutMs: 15000 }); }
    const threads = await mapBounded(bound, async s => ({ accountId: s.accountId, sessionId: s.id, hostId: s.hostId ?? "local",
      ...await native.inspectThread(s.threadId, s.hostId, { includeTurns: false, timeoutMs: 15000 }).then(state => ({ state: stateOf(state) }), () => ({ state: { threadId: s.threadId }, unavailable: true })) }));
    save(baselineFile, { capturedAt: new Date().toISOString(), identity, projects, threads });
    console.log(JSON.stringify({ snapshot: baselineFile, hosts: hosts.length, bindings: bound.length }));
  } finally { await native.close(); }
} else {
  const { loadPeerListener, listenGatewayPeers } = await moduleAt("peer/runtime.js");
  const { PeerRegistry } = await moduleAt("peer/registry.js");
  const { connectorOnlyBackend } = await moduleAt("peer/backend.js");
  const config = loadPeerListener(path.resolve(configOrApi)), baseline = JSON.parse(fs.readFileSync(baselineFile));
  const registry = new PeerRegistry(path.join(path.dirname(baselineFile), "preflight-grants.json"), config.managedRoutes);
  const backend = connectorOnlyBackend(registry), server = await listenGatewayPeers(config, registry);
  console.log(JSON.stringify({ preflightListening: server.url }));
  const errors = [], identity = {}, projects = {}, observed = [];
  try {
    const deadline = Date.now() + 10 * 60_000;
    while (Object.keys(baseline.identity).some(host => !registry.isOnline(host))) { if (Date.now() > deadline) throw Error("Connector preflight deadline exceeded"); await delay(1000); }
    for (const [host, before] of Object.entries(baseline.identity)) {
      identity[host] = await backend.serverIdentity(host);
      if (identity[host].processId !== before.processId) errors.push({ host, reason: "native-process-changed" });
      projects[host] = await backend.listProjects(host, { timeoutMs: 15000 });
      const normalize = catalog => catalog.projects.map(p => ({ id: p.id, roots: [...p.roots].sort() })).sort((a, b) => a.id.localeCompare(b.id));
      if (JSON.stringify(normalize(projects[host])) !== JSON.stringify(normalize(baseline.projects[host]))) errors.push({ host, reason: "project-identity-or-roots-changed" });
    }
    const results = await mapBounded(baseline.threads, async previous => {
      let next;
      try { next = stateOf(await backend.inspectThread(previous.state.threadId, previous.hostId, { includeTurns: false, timeoutMs: 15000 })); }
      catch { if (!previous.unavailable) errors.push({ host: previous.hostId, threadId: previous.state.threadId, reason: "newly-unavailable" }); return { ...previous, unavailable: true }; }
      if (previous.unavailable) return { ...previous, state: next, unavailable: false };
      const changed = ["threadId", "cwd", "projectId", "projectMembership", "persistence", "internal"].filter(key => next[key] !== previous.state[key]);
      if (changed.length) errors.push({ host: previous.hostId, threadId: previous.state.threadId, changed });
      return { ...previous, state: next };
    }); observed.push(...results);
    const result = { verifiedAt: new Date().toISOString(), identity, projects, threads: observed, errors, passed: errors.length === 0 };
    save(resultFile ?? baselineFile + ".verified.json", result);
    console.log(JSON.stringify({ checkedBindings: observed.length, sameNativeProcesses: !errors.some(e => e.reason === "native-process-changed"), errors }));
    if (errors.length) process.exitCode = 1;
  } finally { await backend.close(); registry.close(); await server.close(); }
}
