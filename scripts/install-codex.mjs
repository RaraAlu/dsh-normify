#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import lockfile from 'proper-lockfile';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { collectTools, metadata, toolCount } from '../src/catalog.mjs';
import { execCodex, resolveCodex } from './cli.mjs';

const adapter = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = ['normify-gen', 'normify-dev'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function exists(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing a symbolic-link installation target: ${path}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function contained(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) {
    throw new Error('Unsafe installation target.');
  }
}

async function hashes(dir) {
  const result = {};
  async function visit(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Skill trees must not contain symbolic links.');
      if (entry.isDirectory()) await visit(join(path, entry.name), key + '/');
      else if (key !== '.normify-install.json') result[key] = digest(await readFile(join(path, entry.name)));
    }
  }
  await visit(dir);
  return result;
}

export async function verifyMcp(entry, storageRoot) {
  const client = new Client({ name: 'normify-install-check', version: metadata.version });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [entry, '--root', storageRoot], stderr: 'pipe' });
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    const inventory = await client.listTools();
    const expected = collectTools({ rootDir: storageRoot }).map(tool => tool.name).sort();
    if (inventory.tools.length !== toolCount ||
        JSON.stringify(inventory.tools.map(tool => tool.name).sort()) !== JSON.stringify(expected)) {
      throw new Error('MCP tool discovery failed.');
    }
    return inventory.tools.length;
  } finally { await client.close(); }
}

export async function installCodex(options = {}) {
  const executable = options.executable;
  const cli = resolveCodex(executable);
  const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  const skillsRoot = resolve(options.skillsRoot ?? join(homedir(), '.agents', 'skills'));
  const env = { ...process.env, CODEX_HOME: codexHome };
  const run = (...args) => execCodex(executable, args, { env });
  await exists(codexHome);
  await mkdir(codexHome, { recursive: true });
  const release = await lockfile.lock(codexHome, { retries: { retries: 20, minTimeout: 100, maxTimeout: 500 } });
  let stage;
  let cleanupStage = true;
  let configChanged = false;
  let configBefore;
  const config = join(codexHome, 'config.toml');
  const swapped = [];
  try {
    run('--version');
    const previous = JSON.parse(run('mcp', 'list', '--json')).find(server => server.name === 'normify');
    const storageRoot = resolve(options.storageRoot ??
      (previous?.transport?.args?.[1] === '--root' ? previous.transport.args[2] : undefined) ??
      join(codexHome, 'normify'));
    const entry = join(adapter, 'src', 'stdio.mjs');
    const args = [entry, '--root', storageRoot];
    await exists(skillsRoot);
    const plans = [];
    for (const name of names) {
      const destination = join(skillsRoot, name);
      contained(skillsRoot, destination);
      const installed = await exists(destination);
      let manifest;
      if (installed) {
        const manifestPath = join(destination, '.normify-install.json');
        if (!await exists(manifestPath)) throw new Error(`An unmanaged skill already exists: ${name}`);
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const actual = await hashes(destination);
        if (!manifest.hashes || typeof manifest.hashes !== 'object' || Array.isArray(manifest.hashes) ||
            typeof manifest.adapter !== 'string' || !isAbsolute(manifest.adapter) ||
            Object.keys(actual).length !== Object.keys(manifest.hashes).length ||
            Object.entries(manifest.hashes).some(([path, hash]) => actual[path] !== hash)) {
          throw new Error(`Skill ${name} contains user changes; refusing to replace it.`);
        }
        if (manifest.adapter !== adapter && !options.migrate) {
          throw new Error(`Skill ${name} belongs to another checkout. Review it and rerun with --migrate.`);
        }
      }
      const source = join(adapter, 'skills', name);
      await hashes(source);
      plans.push({ name, source, destination, installed, manifest });
    }
    const matches = server => server?.enabled && server.transport?.type === 'stdio' &&
      server.transport.command === process.execPath && JSON.stringify(server.transport.args) === JSON.stringify(args);
    if (previous && !matches(previous)) {
      const oldAdapter = plans[0].manifest?.adapter;
      const oldArgs = oldAdapter ? [join(oldAdapter, 'src', 'stdio.mjs'), '--root', storageRoot] : [];
      if (!options.migrate || !previous.enabled || previous.transport?.type !== 'stdio' ||
          previous.transport.command !== process.execPath ||
          JSON.stringify(previous.transport.args) !== JSON.stringify(oldArgs) ||
          !plans.every(plan => plan.manifest?.adapter === oldAdapter)) {
        throw new Error('A different or disabled normify MCP exists. Refusing to overwrite unmanaged configuration.');
      }
    }
    // 安装前验证真实stdio服务。
    // 失败时不修改配置或技能。
    const discovered = await verifyMcp(entry, storageRoot);
    if (await exists(config)) configBefore = await readFile(config);
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    const backup = join(codexHome, 'backups', 'normify-codex', id);
    await mkdir(backup, { recursive: true });
    if (configBefore) await copyFile(config, join(backup, 'config.toml'));
    await mkdir(skillsRoot, { recursive: true });
    stage = join(skillsRoot, '.normify-stage-' + randomUUID());
    contained(skillsRoot, stage);
    await mkdir(stage);
    for (const plan of plans) {
      const prepared = join(stage, plan.name);
      await cp(plan.source, prepared, { recursive: true, errorOnExist: true, force: false });
      await writeFile(join(prepared, '.normify-install.json'), JSON.stringify({
        product: metadata.name, version: metadata.version, adapter,
        installedAt: new Date().toISOString(), hashes: await hashes(prepared),
      }, null, 2) + '\n');
      if (plan.installed) {
        await cp(plan.destination, join(backup, plan.name), { recursive: true, errorOnExist: true, force: false });
      }
    }
    for (const plan of plans) {
      const old = join(stage, 'previous-' + plan.name);
      if (plan.installed) await rename(plan.destination, old);
      swapped.push({ ...plan, old, placed: false });
      await rename(join(stage, plan.name), plan.destination);
      swapped.at(-1).placed = true;
    }
    if (!matches(previous)) {
      configChanged = true;
      run('mcp', 'add', 'normify', '--', process.execPath, ...args);
    }
    if (!matches(JSON.parse(run('mcp', 'get', 'normify', '--json')))) {
      throw new Error('MCP registration verification failed.');
    }
    const receipt = { adapter, version: metadata.version, executable: cli.command,
      nodePath: process.execPath, storageRoot, skillsRoot, backup,
      mcp: 'normify', tools: discovered, skills: names, installedAt: new Date().toISOString() };
    await writeFile(join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } catch (error) {
    const rollbackErrors = [];
    if (configChanged) {
      try {
        if (configBefore !== undefined) {
          const temp = config + '.' + randomUUID() + '.tmp';
          await writeFile(temp, configBefore);
          await rename(temp, config);
        } else { await unlink(config).catch(failure => { if (failure.code !== 'ENOENT') throw failure; }); }
      } catch (failure) { rollbackErrors.push(failure); }
    }
    for (const plan of swapped.reverse()) {
      try {
        if (plan.placed) await rename(plan.destination, join(stage, 'failed-' + plan.name));
        if (plan.installed) await rename(plan.old, plan.destination);
      } catch (failure) { rollbackErrors.push(failure); }
    }
    if (rollbackErrors.length) {
      cleanupStage = false;
      throw new AggregateError([error, ...rollbackErrors], `Rollback needs manual recovery. Keep staging directory: ${stage}`);
    }
    throw error;
  } finally {
    try {
      if (stage && cleanupStage) {
        contained(skillsRoot, stage);
        await rm(stage, { recursive: true, force: true });
      }
    } finally { await release(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      'codex-executable': { type: 'string' }, 'codex-home': { type: 'string' },
      'skills-root': { type: 'string' }, 'storage-root': { type: 'string' },
      migrate: { type: 'boolean', default: false },
    } });
    console.log(JSON.stringify(await installCodex({ executable: values['codex-executable'],
      codexHome: values['codex-home'], skillsRoot: values['skills-root'],
      storageRoot: values['storage-root'], migrate: values.migrate }), null, 2));
  } catch (error) {
    console.error('[normify install]', error.message);
    process.exitCode = 1;
  }
}
