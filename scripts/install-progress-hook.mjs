import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execCodex } from './cli.mjs';
import { connectCodex } from './codex-rpc.mjs';
import { progressBundleHash } from '../src/progress-hook.mjs';

export const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const statusMessage = 'Normify progress briefing';
const posix = value => "'" + value.replaceAll("'", "'\\''") + "'";
const powershell = value => "'" + value.replaceAll("'", "''") + "'";

async function optional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function checkCapability(executable, codexHome) {
  const options = { env: { ...process.env, CODEX_HOME: codexHome }, encoding: 'utf8',
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  const features = execCodex(executable, ['features', 'list'], options);
  if (!/^hooks\s+\S+\s+true\s*$/m.test(features)) {
    throw new Error('Native Codex hooks are unavailable or disabled; refusing to change that setting.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'normify-progress-schema-'));
  try {
    execCodex(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', directory], options);
    const schema = JSON.parse(await readFile(join(directory, 'v2', 'HooksListResponse.json'), 'utf8'));
    if (!schema.definitions?.HookEventName?.enum?.includes('userPromptSubmit')) {
      throw new Error('This Codex version does not support UserPromptSubmit hooks.');
    }
  } finally {
    const target = resolve(directory);
    const rel = relative(resolve(tmpdir()), target);
    if (isAbsolute(rel) || rel.startsWith('..') || !basename(target).startsWith('normify-progress-schema-')) {
      throw new Error('Unsafe schema cleanup target.');
    }
    await rm(target, { recursive: true, force: true });
  }
}

export async function installProgressHook({ executable, codexHome, cwd, trustInstalled = false }) {
  codexHome = resolve(codexHome);
  cwd = resolve(cwd);
  await checkCapability(executable, codexHome);
  const hooksFile = join(codexHome, 'hooks.json');
  const manifestFile = join(codexHome, 'normify', 'progress-hooks-installation.json');
  const before = await optional(hooksFile);
  const config = before == null ? {} : JSON.parse(before);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid hooks.json.');
  config.hooks ??= {};
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    throw new Error('Invalid hook event table.');
  }
  config.hooks.UserPromptSubmit ??= [];
  if (!Array.isArray(config.hooks.UserPromptSubmit)) throw new Error('Invalid UserPromptSubmit hooks.');
  const previous = await optional(manifestFile);
  const manifest = previous == null ? null : JSON.parse(previous);
  const script = join(adapterRoot, 'src', 'progress-hook.mjs');
  const sourceHash = await progressBundleHash();
  const root = join(codexHome, 'normify');
  const args = [script, '--root', root, '--expected-sha256', sourceHash];
  const psCommand = '& ' + [process.execPath, ...args].map(powershell).join(' ');
  if (/[\r\n"`$]/.test(psCommand)) throw new Error('Unsupported characters in Windows hook paths.');
  const group = { hooks: [{ type: 'command',
    command: [process.execPath, ...args].map(posix).join(' '),
    commandWindows: 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "' + psCommand + '"',
    timeout: 30, additionalContextLimit: 0, statusMessage }] };
  let index = config.hooks.UserPromptSubmit.length;
  if (manifest) {
    index = manifest.index;
    if (manifest.adapter !== adapterRoot || manifest.hooksFile !== hooksFile ||
        !Number.isSafeInteger(index) || index < 0 ||
        JSON.stringify(config.hooks.UserPromptSubmit[index]) !== JSON.stringify(manifest.group)) {
      throw new Error('The installed Normify progress hook contains user changes; refusing to overwrite it.');
    }
  } else if (config.hooks.UserPromptSubmit.some(entry => entry.hooks?.some(handler =>
    handler.statusMessage === statusMessage || handler.command?.includes('progress-hook.mjs')))) {
    throw new Error('An unmanaged Normify progress hook exists; refusing to overwrite it.');
  }
  config.hooks.UserPromptSubmit[index] = group;
  const installId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const backup = join(codexHome, 'backups', 'normify-progress-hooks', installId);
  await mkdir(backup, { recursive: true });
  for (const [source, name] of [[hooksFile, 'hooks.json'], [join(codexHome, 'config.toml'), 'config.toml'],
    [manifestFile, 'progress-hooks-installation.json']]) {
    if (await optional(source) != null) await copyFile(source, join(backup, name));
  }
  if (before == null || JSON.stringify(JSON.parse(before)) !== JSON.stringify(config)) {
    const temp = hooksFile + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(config, null, 2) + '\n');
    await rename(temp, hooksFile);
  }
  await mkdir(dirname(manifestFile), { recursive: true });
  await writeFile(manifestFile, JSON.stringify({ adapter: adapterRoot, hooksFile, index, group, sourceHash,
    installedAt: new Date().toISOString() }, null, 2) + '\n');

  const codex = await connectCodex(executable, { cwd, codexHome });
  try {
    const inventory = await codex.request('hooks/list', { cwds: [cwd] });
    const entry = inventory.data.find(entry => resolve(entry.cwd) === cwd);
    assert.ok(entry, 'Codex did not return the requested workspace.');
    const hook = entry.hooks.find(hook => resolve(hook.sourcePath) === hooksFile &&
      hook.eventName === 'userPromptSubmit' && hook.statusMessage === statusMessage);
    assert.ok(hook, 'Codex did not discover the Normify progress hook.');
    assert.equal(hook.enabled, true, 'Normify progress hook is disabled.');
    assert.ok(hook.matcher == null || hook.matcher === '', 'Progress hooks must not use a matcher.');
    assert.equal(hook.isManaged, false);
    assert.equal(hook.handlerType, 'command');
    assert.equal(hook.additionalContextLimit, 0, 'Progress context must not spill to disk.');
    assert.ok([group.hooks[0].command, group.hooks[0].commandWindows].includes(hook.command));
    if (trustInstalled && hook.trustStatus !== 'trusted') {
      await codex.request('config/value/write', { keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`,
        value: hook.currentHash, mergeStrategy: 'replace' });
    }
    const after = await codex.request('hooks/list', { cwds: [cwd] });
    const verified = after.data.flatMap(entry => entry.hooks).find(entry => entry.key === hook.key);
    assert.ok(verified?.enabled);
    if (trustInstalled) assert.equal(verified.trustStatus, 'trusted');
    const receipt = { installedAt: new Date().toISOString(), hooksFile, script, sourceHash, root,
      backup, key: verified.key, currentHash: verified.currentHash,
      trustStatus: verified.trustStatus, enabled: verified.enabled };
    await writeFile(join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } finally { await codex.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    'codex-executable': { type: 'string' }, 'codex-home': { type: 'string' }, cwd: { type: 'string' },
    'trust-installed': { type: 'boolean', default: false },
  } });
  const receipt = await installProgressHook({ executable: values['codex-executable'] ?? process.env.CODEX_CLI_PATH,
    codexHome: values['codex-home'] ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    cwd: values.cwd ?? process.cwd(), trustInstalled: values['trust-installed'] });
  console.log(JSON.stringify(receipt, null, 2));
}
