import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execCodex, resolveNpm } from './cli.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const { values } = parseArgs({ options: {
    'codex-executable': { type: 'string' }, 'codex-home': { type: 'string' },
    'skills-root': { type: 'string' }, 'storage-root': { type: 'string' },
    migrate: { type: 'boolean', default: false },
  } });
  execCodex(values['codex-executable'], ['--version']);
  const npm = resolveNpm();
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Installation step failed (exit ${result.status}).`);
  };
  run(npm.command, [...npm.args, 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  run(npm.command, [...npm.args, 'run', 'build']);
  run(npm.command, [...npm.args, 'run', 'check']);
  run(process.execPath, [join(root, 'scripts', 'install-codex.mjs'), ...process.argv.slice(2)]);
  console.log('Normify installed. Start a new Codex session to load its tools and skills.');
} catch (error) {
  console.error('[normify install]', error.message);
  process.exitCode = 1;
}
