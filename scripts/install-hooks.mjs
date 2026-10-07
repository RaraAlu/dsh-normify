import assert from 'node:assert/strict';
import { execCodex } from './cli.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeMatcher } from '../src/companion-hook.mjs';
import { connectCodex } from './codex-rpc.mjs';

export const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = text => createHash('sha256').update(text).digest('hex');
async function optional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const posix = value => "'" + value.replaceAll("'", "'\\''") + "'";
const powershell = value => "'" + value.replaceAll("'", "''") + "'";

export async function installHooks({ executable, codexHome, cwd, threshold = 8, trustInstalled = false }) {
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error('Invalid reminder threshold.');
  codexHome = resolve(codexHome);
  cwd = resolve(cwd);
  await mkdir(codexHome, { recursive: true });
  const features = execCodex(executable, ['features', 'list'], { env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!/^hooks\s+\S+\s+true\s*$/m.test(features)) {
    throw new Error('Native Codex hooks are unavailable or disabled; refusing to change that setting.');
  }
  const hooksFile = join(codexHome, 'hooks.json');
  const manifestFile = join(codexHome, 'normify', 'hooks-installation.json');
  const before = await optional(hooksFile);
  const config = before == null ? {} : JSON.parse(before);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid hooks.json.');
  config.hooks ??= {};
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('Invalid hook event table.');
  config.hooks.PostToolUse ??= [];
  if (!Array.isArray(config.hooks.PostToolUse)) throw new Error('Invalid PostToolUse hooks.');
  const previous = await optional(manifestFile);
  const manifest = previous == null ? null : JSON.parse(previous);
  const script = join(adapterRoot, 'src', 'companion-hook.mjs');
  const sourceHash = hash(await readFile(script));
  const args = [script, '--state-root', join(codexHome, 'normify', 'hooks-state'),
    '--threshold', String(threshold), '--expected-sha256', sourceHash];
  // 显式启动PowerShell，避免宿主shell差异。
  const psCommand = '& ' + [process.execPath, ...args].map(powershell).join(' ');
  if (/[\r\n"`$]/.test(psCommand)) throw new Error('Unsupported characters in Windows hook paths.');
  const group = { matcher: writeMatcher, hooks: [{ type: 'command',
    command: [process.execPath, ...args].map(posix).join(' '),
    commandWindows: 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "' + psCommand + '"',
    timeout: 10, statusMessage: 'Normify companion reminder' }] };
  let index = config.hooks.PostToolUse.length;
  if (manifest) {
    index = manifest.index;
    if (manifest.adapter !== adapterRoot || manifest.hooksFile !== hooksFile ||
        !Number.isSafeInteger(index) || index < 0 ||
        JSON.stringify(config.hooks.PostToolUse[index]) !== JSON.stringify(manifest.group)) {
      throw new Error('The installed Normify hook contains user changes; refusing to overwrite it.');
    }
  } else if (config.hooks.PostToolUse.some(entry => entry.hooks?.some(handler =>
    handler.statusMessage === 'Normify companion reminder' || handler.command?.includes('companion-hook.mjs')))) {
    throw new Error('An unmanaged Normify hook exists; refusing to overwrite it.');
  }
  config.hooks.PostToolUse[index] = group;
  const installId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const backup = join(codexHome, 'backups', 'normify-hooks', installId);
  await mkdir(backup, { recursive: true });
  for (const [source, name] of [[hooksFile, 'hooks.json'], [join(codexHome, 'config.toml'), 'config.toml'],
    [manifestFile, 'hooks-installation.json']]) {
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
      hook.eventName === 'postToolUse' && hook.statusMessage === 'Normify companion reminder');
    assert.ok(hook, 'Codex did not discover the Normify hook.');
    assert.equal(hook.enabled, true, 'Normify hook is disabled.');
    assert.equal(hook.matcher, writeMatcher);
    assert.equal(hook.isManaged, false);
    assert.equal(hook.handlerType, 'command');
    assert.ok([group.hooks[0].command, group.hooks[0].commandWindows].includes(hook.command));
    if (trustInstalled && hook.trustStatus !== 'trusted') {
      // 仅信任本次审阅的精确钩子哈希。
      // 不使用全局信任旁路。
      await codex.request('config/value/write', { keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`,
        value: hook.currentHash, mergeStrategy: 'replace' });
    }
    const after = await codex.request('hooks/list', { cwds: [cwd] });
    const verified = after.data.flatMap(entry => entry.hooks).find(entry => entry.key === hook.key);
    assert.ok(verified?.enabled);
    if (trustInstalled) assert.equal(verified.trustStatus, 'trusted');
    const receipt = { installedAt: new Date().toISOString(), hooksFile, script, sourceHash, threshold, backup,
      key: verified.key, currentHash: verified.currentHash, trustStatus: verified.trustStatus, enabled: verified.enabled };
    await writeFile(join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } finally { await codex.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    'codex-executable': { type: 'string' }, 'codex-home': { type: 'string' }, cwd: { type: 'string' },
    threshold: { type: 'string', default: '8' }, 'trust-installed': { type: 'boolean', default: false },
  } });
  const receipt = await installHooks({ executable: values['codex-executable'] ?? process.env.CODEX_CLI_PATH,
    codexHome: values['codex-home'] ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    cwd: values.cwd ?? process.cwd(), threshold: Number(values.threshold), trustInstalled: values['trust-installed'] });
  console.log(JSON.stringify(receipt, null, 2));
}
