import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Pin the embedded package beside the compiled Gateway. Compiled Gateway imports this
 * package without consulting the development workspace, so deploy and rollback
 * move the server modules, shared contracts and web assets together. */
export function packageTaskboardRuntime({ source, web, destination }) {
  if (!fs.existsSync(path.join(web, 'index.html'))) throw Error('Taskboard web build is missing');
  const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  // Resolve existing parents too: macOS /var and /private/var may refer to the
  // same source even when the eventual output directory does not exist yet.
  const canonicalOutput = file => fs.existsSync(file) ? fs.realpathSync(file)
    : path.join(canonicalOutput(path.dirname(file)), path.basename(file));
  destination = path.resolve(destination);
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw Error('Taskboard artifact cannot be a symlink');
  source = fs.realpathSync(source); web = fs.realpathSync(web); destination = canonicalOutput(destination);
  if (inside(destination, source) || inside(source, destination) || inside(destination, web) || inside(web, destination))
    throw Error('Taskboard artifact must not overlap its source or web input');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (manifest.name !== 'codex-taskboard') throw Error('Unexpected Taskboard package');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(path.join(source, 'package.json'), path.join(destination, 'package.json'));
  for (const name of ['server', 'shared', 'skills', 'cli', 'scripts']) fs.cpSync(path.join(source, name), path.join(destination, name), { recursive: true });
  fs.cpSync(web, path.join(destination, 'dist', 'web'), { recursive: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2), options = {};
  if (args.length % 2) throw Error('Use --out PATH --web PATH');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--web'].includes(args[i]) || options[args[i]]) throw Error('Unknown or duplicate packaging option');
    options[args[i]] = args[i + 1];
  }
  packageTaskboardRuntime({ source: path.join(repo, 'taskboard'), web: path.resolve(options['--web'] ?? path.join(repo, 'taskboard/dist/web')),
    destination: path.resolve(options['--out'] ?? path.join(repo, 'dist/vendor/codex-taskboard')) });
}
