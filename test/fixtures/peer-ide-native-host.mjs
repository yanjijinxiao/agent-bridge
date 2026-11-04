// Run only on an explicitly selected test host. Owns its Codex home, project,
// fake inference endpoint and Connector; never discovers production sessions.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { sharedNativeCore } from './shared-native-core.mjs';
import { CodexAppServerGateway } from '../../src/codex/app-server-gateway.ts';
import { PeerExecutionService } from '../../src/peer/execution-service.ts';
import { GatewayPeerClient } from '../../src/peer/transport.ts';

const lines = readline.createInterface({ input: process.stdin });
const closers = []; let client, service, core, native, roots;
const reply = (id, result, error) => process.stdout.write(JSON.stringify({ id, result, error }) + '\n');
let initialized = false, stopped = false, work = Promise.resolve();
const close = async () => {
  if (stopped) return; stopped = true; client?.close(); await service?.close();
  for (const cleanup of closers.reverse()) await cleanup();
};
lines.on('line', text => { work = work.then(async () => {
  const { id, method, ...input } = JSON.parse(text);
  try {
    if (method === 'init') {
      if (initialized) throw Error('Already initialized'); initialized = true;
      process.env.CODEX_NATIVE_QUEUE_TEST_BIN = input.codexBin;
      // Only the isolated mock inference endpoint bypasses host proxy defaults.
      // External extension installation keeps the device's normal network path.
      process.env.NO_PROXY = process.env.no_proxy = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
      core = await sharedNativeCore({ after: fn => closers.push(fn) });
      roots = ['alpha', 'beta'].map(name => {
        const folder = path.join(core.root, name); fs.mkdirSync(folder); execFileSync('git', ['init', '--quiet', folder]);
        fs.writeFileSync(path.join(folder, `${name}.txt`), `${name} sample\nsecond line\n`); return folder;
      });
      native = new CodexAppServerGateway({ appServerBackend: core.runner() });
      const thread = await native.run({ cwd: roots[0], projectName: 'CLI IDE isolated project', projectRoots: roots,
        prompt: 'fixture initialization', clientUserMessageId: 'ide-fixture-only', assertCurrent() {} });
      if (!thread.threadId) throw Error('Native fixture did not create a thread');
      const state = await native.inspectThread(thread.threadId), projects = await native.listProjects();
      if (state.projectMembership !== 'assigned' || !projects.projects.some(p => p.id === state.projectId)) throw Error('Native CLI project membership missing');
      service = await PeerExecutionService.create({ backend: native, profileId: 'cli-ide-test', stateDir: path.join(core.root, 'connector'),
        independent: true, approve: async () => true,
        webIDE: { enabled: true, binary: input.binary, autoInstall: false } });
      const connected = Promise.withResolvers();
      client = new GatewayPeerClient({ url: input.url, nodeId: 'cli-ide-test', token: input.token, reconnectMs: 20,
        connected: async connection => { service.attach(connection); const ticket = await connection.request('peer.register', service.description); connected.resolve(ticket); } });
      client.start(); const ticket = await connected.promise;
      reply(id, { ...ticket, root: core.root, roots, threadId: thread.threadId, nativeProjectId: state.projectId,
        platform: process.platform, arch: process.arch, nativeInputs: core.calls.length }); return;
    }
    if (!core) throw Error('Host not initialized');
    if (method === 'read') {
      const allowed = ['terminal-cwd.txt', 'alpha/alpha.txt'];
      if (!allowed.includes(input.file)) throw Error('Test receipt not allowed');
      const file = path.join(core.root, input.file); reply(id, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null); return;
    }
    if (method === 'status') { reply(id, { nativeInputs: core.calls.length, nativeAlive: fs.existsSync(core.endpoint) }); return; }
    if (method === 'diagnostics') {
      const logs = [], base = path.join(core.root, 'connector', 'ide', 'instances');
      const walk = folder => { if (!fs.existsSync(folder)) return; for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, item.name); if (item.isDirectory()) walk(file);
        else if (item.isFile() && item.name.endsWith('.log') && logs.length < 30) logs.push({ file: path.relative(core.root, file), tail: fs.readFileSync(file, 'utf8').slice(-3000) });
      } }; walk(base); reply(id, logs); return;
    }
    if (method === 'close') { await close(); reply(id, true); lines.close(); return; }
    throw Error('Unknown host control');
  } catch (error) { reply(id, undefined, error.message); }
}).catch(() => { process.exitCode = 1; }); });
lines.on('close', () => { void work.finally(close); });
process.on('SIGTERM', () => { void close().finally(() => process.exit()); });
