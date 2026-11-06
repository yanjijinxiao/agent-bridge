// npm run package:npm -- --out /absolute/new/directory
// Build away from live dist; publish only the returned tarball. The source
// workspace remains private so `npm publish` cannot ship an old live build.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageTaskboardRuntime } from './package-taskboard-runtime.mjs';

export function publicationManifest(source) {
  const fields = ['name', 'version', 'description', 'license', 'author', 'contributors', 'homepage', 'bugs',
    'repository', 'keywords', 'type', 'engines', 'dependencies', 'overrides', 'bin', 'publishConfig'];
  const manifest = Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  if (manifest.name !== '@yanjijinxiao/agent-bridge' || !/^\d+\.\d+\.\d+$/.test(manifest.version))
    throw Error('Unexpected npm product identity');
  // Explicitly exclude private deployment state, tests and internal audits.
  return { ...manifest, files: ['dist/', 'README.md', 'README.en.md', 'LICENSE', 'examples/', 'docs/'] };
}

export function packageNpm(out) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const clean = () => {
    if (git(['status', '--porcelain', '--untracked-files=no'])) throw Error('Commit tracked source changes before preparing an npm release');
    const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(f => f && f !== '.DS_Store');
    if (untracked.length) throw Error('Untracked source exists; review it before packaging');
  };
  clean();
  const commit = git(['rev-parse', 'HEAD']);
  out = path.resolve(out);
  if (fs.existsSync(out)) throw Error('Use a new output directory; previous artifacts are never overwritten');
  // Resolve ancestors to stop symlink paths from accidentally building inside
  // the live checkout. The output directory must be outside it.
  const canonical = file => fs.existsSync(file) ? fs.realpathSync(file) : path.join(canonical(path.dirname(file)), path.basename(file));
  const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
  if (inside(canonical(out), fs.realpathSync(repo)) || inside(fs.realpathSync(repo), canonical(out)))
    throw Error('npm artifact must be outside the source checkout');
  fs.mkdirSync(out, { recursive: true });
  const stage = path.join(out, 'package'), dist = path.join(stage, 'dist');
  fs.mkdirSync(stage);
  const manifest = publicationManifest(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')));
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const run = (name, args) => {
    const fd = fs.openSync(path.join(out, name + '.log'), 'w', 0o600);
    try { execFileSync(process.execPath, args, { cwd: repo, stdio: ['ignore', fd, fd] }); }
    catch (error) { throw new Error(`${name} failed; see ${path.join(out, name + '.log')}`, { cause: error }); }
    finally { fs.closeSync(fd); }
  };
  run('build', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--outDir', dist]);
  const web = path.join(out, 'taskboard-web');
  run('taskboard-build', ['taskboard/node_modules/vite/bin/vite.js', 'build', '--config', 'taskboard/web/vite.config.ts', '--outDir', web]);
  packageTaskboardRuntime({ source: path.join(repo, 'taskboard'), web, destination: path.join(dist, 'vendor/codex-taskboard') });
  fs.cpSync(path.join(repo, 'src/web'), path.join(dist, 'web'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'web/vendor'), { recursive: true });
  for (const [file, name] of [['lucide/dist/umd/lucide.min.js', 'lucide.min.js'], ['marked/lib/marked.umd.js', 'marked.umd.js'], ['dompurify/dist/purify.min.js', 'purify.min.js']])
    fs.copyFileSync(path.join(repo, 'node_modules', file), path.join(dist, 'web/vendor', name));
  for (const name of ['README.md', 'README.en.md', 'LICENSE', 'examples/peer-client.json', 'examples/peer-server.json',
    'docs/tantan-connector-guide.md', 'docs/gateway-peers.md', 'docs/local-run.md', 'docs/npm-release.md']) {
    fs.mkdirSync(path.dirname(path.join(stage, name)), { recursive: true });
    fs.copyFileSync(path.join(repo, name), path.join(stage, name));
  }
  for (const bin of Object.values(manifest.bin)) fs.chmodSync(path.join(stage, bin), 0o755);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const sourceHash = hash(git(['ls-files', '-z']).split('\0').filter(Boolean)
    .map(file => `${file}\0${hash(fs.readFileSync(path.join(repo, file)))}`).join('\n'));
  const build = { productVersion: manifest.version, commit, sourceHash, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dist, 'build-info.json'), JSON.stringify(build, null, 2) + '\n');
  clean(); if (git(['rev-parse', 'HEAD']) !== commit) throw Error('Source changed while packaging');
  const npm = process.env.npm_execpath;
  if (!npm || !/\.(?:c?js|mjs)$/.test(npm)) throw Error('Run through npm run package:npm so npm-cli.js is explicit');
  const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', out],
    { cwd: stage, encoding: 'utf8' }))[0];
  if (packed.name !== manifest.name || packed.version !== manifest.version) throw Error('npm tarball identity differs from runtime');
  const names = new Set(packed.files.map(file => file.path));
  for (const name of ['dist/server/index.js', 'dist/peer/index.js', 'dist/build-info.json', 'dist/web/index.html',
    'dist/vendor/codex-taskboard/server/index.mjs', 'dist/vendor/codex-taskboard/dist/web/index.html'])
    if (!names.has(name)) throw Error(`npm omitted required runtime file: ${name}`);
  const receipt = { ...build, name: manifest.name, path: path.join(out, packed.filename), integrity: packed.integrity, files: names.size, size: packed.size };
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out' || !path.isAbsolute(args[1])) throw Error('Use --out /absolute/new/directory');
  console.log(JSON.stringify(packageNpm(args[1]), null, 2));
}
