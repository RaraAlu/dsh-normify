import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectCodex } from './codex-rpc.mjs';
import { execCodex, resolveCodex } from './cli.mjs';
import { metadata, toolCount } from '../src/catalog.mjs';

const { values } = parseArgs({ options: {
  'codex-executable': { type: 'string' }, 'codex-home': { type: 'string' }, cwd: { type: 'string' },
  output: { type: 'string' },
} });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cwd = resolve(values.cwd ?? root);
const codexHome = resolve(values['codex-home'] ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
const executable = values['codex-executable'];
const servers = JSON.parse(execCodex(executable, ['mcp', 'list', '--json'],
  { env: { ...process.env, CODEX_HOME: codexHome } }));
const registered = servers.find(server => server.name === 'normify' && server.enabled);
assert.ok(registered, 'Normify is not enabled.');
assert.equal(registered.transport.command, process.execPath, 'Run the installer with this Node.js installation.');
assert.equal(registered.transport.args[0], join(root, 'src', 'stdio.mjs'), 'Normify belongs to a different checkout.');
// 只在验证进程禁用无关插件。
const codex = await connectCodex(executable, { cwd, codexHome, enableNormify: true });
try {
  const discovered = await codex.request('skills/list', { cwds: [cwd], forceReload: true });
  const names = ['normify-gen', 'normify-dev'];
  const candidates = discovered.data.flatMap(entry => entry.skills).filter(skill => names.includes(skill.name));
  const installed = [];
  for (const name of names) {
    let selected;
    for (const skill of candidates.filter(skill => skill.name === name && skill.enabled)) {
      try {
        const manifest = JSON.parse(await readFile(join(dirname(skill.path), '.normify-install.json'), 'utf8'));
        if (manifest.adapter === root) { selected = skill; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    assert.ok(selected, 'Managed skill not discovered for this checkout: ' + name);
    installed.push(selected);
  }
  const errors = discovered.data.flatMap(entry => entry.errors).filter(error => /normify/.test(JSON.stringify(error)));
  assert.deepEqual(errors, []);
  const inventory = await codex.request('mcpServerStatus/list', { limit: 100, detail: 'full' });
  const normify = inventory.data.find(server => server.name === 'normify');
  assert.ok(normify, 'Normify was not discovered by Codex.');
  assert.equal(normify.toolsError ?? null, null);
  assert.equal(Object.keys(normify.tools).length, toolCount);
  assert.equal(normify.serverInfo.name, metadata.name);
  assert.equal(normify.serverInfo.version, metadata.version);
  const report = { verifiedAt: new Date().toISOString(), cwd, executable: resolveCodex(executable).command,
    skills: installed.map(({ name, path, enabled }) => ({ name, path, enabled })),
    mcp: { name: normify.name, tools: Object.keys(normify.tools).length,
      toolsError: normify.toolsError ?? null, serverInfo: normify.serverInfo } };
  const output = resolve(values.output ?? join(root, 'reports', 'codex-installation.json'));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await codex.close(); }
