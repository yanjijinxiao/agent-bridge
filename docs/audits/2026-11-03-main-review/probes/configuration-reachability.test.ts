// Production-path control: direct exec injection is not a deployed config.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, saveConfig } from '../../../../src/state/config.js';
import { resolveStatePaths } from '../../../../src/state/paths.js';

test('production configuration normalizes retired exec to the single App Server', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-config-reachability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  fs.writeFileSync(paths.configPath, JSON.stringify({ codexBackend: 'exec' }));
  const config = loadConfig(paths);
  assert.equal(config.codexBackend, 'app-server');
  saveConfig(paths, { ...config, codexBackend: 'exec' });
  assert.equal(JSON.parse(fs.readFileSync(paths.configPath, 'utf8')).codexBackend, 'app-server');
});
