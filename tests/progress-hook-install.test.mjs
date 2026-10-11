import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { installProgressHook } from '../scripts/install-progress-hook.mjs';
import { connectCodex } from '../scripts/codex-rpc.mjs';
import { adapterRoot, fixture, testCodex } from './support.mjs';
import { progressBundleHash } from '../src/progress-hook.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const initialConfig = '# Preserve user settings\napproval_policy = "never"\n\n[features]\nhooks = true\n';
const oldGroup = { matcher: '^apply_patch$', hooks: [{ type: 'command', command: 'echo edit-reminder',
  statusMessage: 'Normify companion reminder' }] };
const userGroup = { hooks: [{ type: 'command', command: 'echo user-prompt', statusMessage: 'User prompt hook' }] };

async function fakeCodex(base, { eventSupported = true } = {}) {
  const path = join(base, 'fake-progress-codex.mjs');
  await writeFile(path, `import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const configPath = join(home, 'config.toml');
const config = () => existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
if (args[0] === 'features') {
  console.log('hooks stable ' + !/hooks\\s*=\\s*false/.test(config()));
} else if (args.includes('generate-json-schema')) {
  const out = args[args.indexOf('--out') + 1];
  mkdirSync(join(out, 'v2'), { recursive: true });
  writeFileSync(join(out, 'v2', 'HooksListResponse.json'), JSON.stringify({ definitions: {
    HookEventName: { enum: ${JSON.stringify(eventSupported ? ['postToolUse', 'userPromptSubmit'] : ['postToolUse'])} }
  } }));
} else if (args[0] === 'mcp') {
  console.log('[]');
} else if (args.includes('app-server')) {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    const request = JSON.parse(line);
    if (request.id == null) return;
    appendFileSync(join(home, 'rpc-requests.jsonl'), JSON.stringify(request) + '\\n');
    let result = {};
    if (request.method === 'hooks/list') {
      const file = join(home, 'hooks.json');
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const hooks = Object.entries(data.hooks).flatMap(([event, groups]) => groups.flatMap(group =>
        group.hooks.map(handler => {
          const hash = createHash('sha256').update(JSON.stringify({ event, group })).digest('hex');
          return { sourcePath: file, eventName: event[0].toLowerCase() + event.slice(1),
            statusMessage: handler.statusMessage, matcher: group.matcher ?? null, enabled: true,
            isManaged: false, handlerType: handler.type, additionalContextLimit: handler.additionalContextLimit ?? null,
            command: handler.commandWindows ?? handler.command,
            key: 'hook-' + hash.slice(0, 16), currentHash: hash,
            trustStatus: config().includes('# trusted-progress: ' + hash) ? 'trusted' : 'untrusted' };
        })));
      result = { data: request.params.cwds.map(cwd => ({ cwd, hooks })) };
    } else if (request.method === 'config/value/write') {
      appendFileSync(configPath, '\\n# trusted-progress: ' + request.params.value + '\\n');
    } else if (request.method !== 'initialize') {
      throw new Error('Unexpected RPC: ' + request.method);
    }
    process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
  });
} else {
  throw new Error('Unexpected CLI invocation: ' + args.join(' '));
}
`);
  return path;
}

async function setup(t, fakeOptions) {
  const { base, repo } = await fixture(t);
  const codexHome = join(base, 'codex home 汉字');
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'config.toml'), initialConfig);
  const initial = { description: 'User hooks', hooks: { PostToolUse: [oldGroup],
    UserPromptSubmit: [userGroup], Stop: [] } };
  await writeFile(join(codexHome, 'hooks.json'), JSON.stringify(initial, null, 2) + '\n');
  return { base, repo, codexHome, initial, executable: await fakeCodex(base, fakeOptions) };
}

test('progress hook installation preserves edit hooks and trusts only the progress hash', async t => {
  const { repo, codexHome, initial, executable } = await setup(t);
  const reminderManifest = join(codexHome, 'normify', 'hooks-installation.json');
  await mkdir(join(codexHome, 'normify'));
  await writeFile(reminderManifest, 'old reminder manifest\n');
  const before = await readFile(join(codexHome, 'hooks.json'), 'utf8');
  const receipt = await installProgressHook({ executable, codexHome, cwd: repo, trustInstalled: true });
  assert.equal(receipt.trustStatus, 'trusted');
  assert.equal(receipt.sourceHash, await progressBundleHash());
  assert.equal(receipt.root, join(codexHome, 'normify'));
  assert.equal(receipt.evidenceConfig, undefined);
  const config = JSON.parse(await readFile(receipt.hooksFile, 'utf8'));
  assert.deepEqual(config.hooks.PostToolUse, initial.hooks.PostToolUse);
  assert.deepEqual(config.hooks.UserPromptSubmit[0], userGroup);
  assert.deepEqual(config.hooks.Stop, []);
  assert.equal(config.description, initial.description);
  assert.equal(config.hooks.UserPromptSubmit.length, 2);
  const group = config.hooks.UserPromptSubmit[1];
  assert.equal(group.matcher, undefined);
  assert.equal(group.hooks[0].additionalContextLimit, 0);
  assert.match(group.hooks[0].commandWindows, /--root/);
  assert.match(group.hooks[0].commandWindows, /--expected-sha256/);
  assert.ok(!group.hooks[0].commandWindows.includes('--evidence-config'));
  assert.equal(await readFile(join(receipt.backup, 'hooks.json'), 'utf8'), before);
  assert.equal(await readFile(join(receipt.backup, 'config.toml'), 'utf8'), initialConfig);
  assert.equal(await readFile(reminderManifest, 'utf8'), 'old reminder manifest\n');
  const requests = (await readFile(join(codexHome, 'rpc-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const writes = requests.filter(request => request.method === 'config/value/write');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].params, { keyPath: `hooks.state.${JSON.stringify(receipt.key)}.trusted_hash`,
    value: receipt.currentHash, mergeStrategy: 'replace' });
  assert.ok(requests.every(request => ['initialize', 'hooks/list', 'config/value/write'].includes(request.method)));
});

test('progress hook reinstalls without duplication and backs up its own manifest', async t => {
  const { repo, codexHome, executable } = await setup(t);
  const options = { executable, codexHome, cwd: repo, trustInstalled: true };
  const receipt = await installProgressHook(options);
  const manifest = join(codexHome, 'normify', 'progress-hooks-installation.json');
  const beforeManifest = await readFile(manifest, 'utf8');
  const beforeHooks = await readFile(receipt.hooksFile, 'utf8');
  const beforeConfig = await readFile(join(codexHome, 'config.toml'), 'utf8');
  const again = await installProgressHook(options);
  assert.equal(again.currentHash, receipt.currentHash);
  assert.equal(await readFile(receipt.hooksFile, 'utf8'), beforeHooks);
  assert.equal(await readFile(join(codexHome, 'config.toml'), 'utf8'), beforeConfig);
  assert.equal(await readFile(join(again.backup, 'progress-hooks-installation.json'), 'utf8'), beforeManifest);
});

test('progress hook refuses user changes and unmanaged hooks without replacing them', async t => {
  const { base, repo, codexHome, executable } = await setup(t);
  const receipt = await installProgressHook({ executable, codexHome, cwd: repo });
  assert.equal(receipt.trustStatus, 'untrusted');
  const modified = JSON.parse(await readFile(receipt.hooksFile, 'utf8'));
  modified.hooks.UserPromptSubmit[1].hooks[0].timeout = 23;
  await writeFile(receipt.hooksFile, JSON.stringify(modified));
  const beforeConfig = await readFile(join(codexHome, 'config.toml'), 'utf8');
  await assert.rejects(installProgressHook({ executable, codexHome, cwd: repo }), /user changes/);
  assert.deepEqual(JSON.parse(await readFile(receipt.hooksFile, 'utf8')), modified);
  assert.equal(await readFile(join(codexHome, 'config.toml'), 'utf8'), beforeConfig);
  const otherHome = join(base, 'unmanaged-home');
  await mkdir(otherHome);
  await writeFile(join(otherHome, 'hooks.json'), JSON.stringify(modified));
  await assert.rejects(installProgressHook({ executable, codexHome: otherHome, cwd: repo }), /unmanaged/);
  assert.deepEqual(JSON.parse(await readFile(join(otherHome, 'hooks.json'), 'utf8')), modified);
});

test('progress hook checks feature and event support before changing configuration', async t => {
  const { base, repo } = await fixture(t);
  const executable = await fakeCodex(base);
  const disabledHome = join(base, 'disabled-home');
  await mkdir(disabledHome);
  const disabled = '[features]\nhooks = false\n';
  await writeFile(join(disabledHome, 'config.toml'), disabled);
  await assert.rejects(installProgressHook({ executable, codexHome: disabledHome, cwd: repo }), /disabled/);
  assert.equal(await readFile(join(disabledHome, 'config.toml'), 'utf8'), disabled);
  await assert.rejects(readFile(join(disabledHome, 'hooks.json')), { code: 'ENOENT' });
  const oldHome = join(base, 'unsupported-home');
  const oldExecutable = await fakeCodex(base, { eventSupported: false });
  await assert.rejects(installProgressHook({ executable: oldExecutable, codexHome: oldHome, cwd: repo }), /UserPromptSubmit/);
  await assert.rejects(readFile(join(oldHome, 'hooks.json')), { code: 'ENOENT' });
});

test('native Codex discovers and trusts UserPromptSubmit in an isolated home without starting a model',
  { skip: !testCodex }, async t => {
    const { base, repo } = await fixture(t);
    const codexHome = join(base, 'native-progress-home');
    await mkdir(codexHome);
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [oldGroup] } }));
    const receipt = await installProgressHook({ executable: testCodex, codexHome, cwd: repo, trustInstalled: true });
    assert.equal(receipt.trustStatus, 'trusted');
    const config = JSON.parse(await readFile(receipt.hooksFile, 'utf8'));
    assert.deepEqual(config.hooks.PostToolUse, [oldGroup]);
    assert.equal(config.hooks.UserPromptSubmit.length, 1);
    assert.equal(config.hooks.UserPromptSubmit[0].matcher, undefined);
    const rpc = await connectCodex(testCodex, { cwd: repo, codexHome });
    try {
      const inventory = await rpc.request('hooks/list', { cwds: [repo] });
      const hooks = inventory.data[0].hooks;
      const progress = hooks.find(hook => hook.key === receipt.key);
      assert.equal(progress.eventName, 'userPromptSubmit');
      assert.equal(progress.trustStatus, 'trusted');
      assert.equal(progress.additionalContextLimit, 0);
      assert.equal(hooks.find(hook => hook.statusMessage === 'Normify companion reminder').trustStatus, 'untrusted');
      assert.deepEqual(rpc.notifications, []);
    } finally { await rpc.close(); }
  });
