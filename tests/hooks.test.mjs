import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { companionReminder } from '../src/companion-hook.mjs';
import { connectCodex } from '../scripts/codex-rpc.mjs';
import { installHooks } from '../scripts/install-hooks.mjs';
import { adapterRoot, fixture, testCodex } from './support.mjs';
import { mockModel, modelCatalog } from './mock-model.mjs';

const executable = testCodex;
const patch = { command: '*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-old\n+new\n*** End Patch' };
const payload = (cwd, call, session = 'test-session') => ({ hook_event_name: 'PostToolUse',
  session_id: session, cwd, tool_name: 'apply_patch', tool_use_id: String(call), tool_input: patch,
  tool_response: 'Success. Updated the following files.' });

test('companion hook reminds at eight successful edits and repeats at sixteen', async t => {
  const { base, repo } = await fixture(t);
  const stateRoot = join(base, 'state');
  for (let call = 1; call <= 16; call++) {
    const output = await companionReminder(payload(repo, call), { stateRoot });
    if (call % 8) assert.equal(output, null);
    else {
      assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
      assert.match(output.hookSpecificOutput.additionalContext, /normify_sync/);
      assert.equal(output.decision, undefined);
      assert.equal(output.continue, undefined);
    }
  }
});

test('companion hook ignores reads, shell calls, failed writes and malformed contexts', async t => {
  const { base, repo } = await fixture(t);
  const stateRoot = join(base, 'state');
  const baseInput = payload(repo, 1);
  const ignored = [null, {}, { ...baseInput, tool_name: 'Bash' },
    { ...baseInput, tool_name: 'mcp__normify__normify_module_patch' },
    { ...baseInput, hook_event_name: 'PreToolUse' }, { ...baseInput, session_id: '' },
    { ...baseInput, cwd: 'relative' }, { ...baseInput, tool_response: { isError: true } },
    { ...baseInput, tool_response: { exit_code: 1 } }, { ...baseInput, tool_response: 'Failed to find expected lines' },
    { ...baseInput, tool_input: { command: '*** Begin Patch\n*** End Patch' } }];
  for (const input of ignored) assert.equal(await companionReminder(input, { stateRoot }), null);
  await assert.rejects(readdir(stateRoot), { code: 'ENOENT' });
});

test('companion hook isolates sessions and repositories', async t => {
  const { base, repo } = await fixture(t);
  const stateRoot = join(base, 'state');
  assert.equal(await companionReminder(payload(repo, 1), { stateRoot, threshold: 2 }), null);
  assert.equal(await companionReminder(payload(repo, 2, 'other-session'), { stateRoot, threshold: 2 }), null);
  assert.equal(await companionReminder(payload(base, 3), { stateRoot, threshold: 2 }), null);
  assert.ok(await companionReminder(payload(repo, 4), { stateRoot, threshold: 2 }));
  assert.equal((await readdir(stateRoot)).length, 3);
});

test('companion hook deduplicates retried tool calls', async t => {
  const { base, repo } = await fixture(t);
  const stateRoot = join(base, 'state');
  for (let repeat = 0; repeat < 8; repeat++) assert.equal(await companionReminder(payload(repo, 'same'), { stateRoot }), null);
  for (let call = 2; call <= 7; call++) assert.equal(await companionReminder(payload(repo, call), { stateRoot }), null);
  assert.ok(await companionReminder(payload(repo, 8), { stateRoot }));
});

test('companion hook safely counts simultaneous writes', async t => {
  const { base, repo } = await fixture(t);
  const stateRoot = join(base, 'state');
  const results = await Promise.all(Array.from({ length: 16 }, (_, call) => companionReminder(payload(repo, call), { stateRoot })));
  assert.equal(results.filter(Boolean).length, 2);
  const [directory] = await readdir(stateRoot);
  const state = JSON.parse(await readFile(join(stateRoot, directory, 'counter.json'), 'utf8'));
  assert.equal(state.writes, 0);
  assert.equal(state.recentCalls.length, 16);
  assert.ok(!JSON.stringify(state).includes(repo));
  assert.ok(!JSON.stringify(state).includes(patch.command));
});

test('hook executable rejects changed code and malformed input without leaking details', async t => {
  const { base, repo } = await fixture(t);
  const script = join(adapterRoot, 'src', 'companion-hook.mjs');
  const expected = createHash('sha256').update(await readFile(script)).digest('hex');
  const args = [script, '--state-root', join(base, 'state'), '--expected-sha256'];
  for (const [digest, input] of [['bad-hash', JSON.stringify(payload(repo, 1))], [expected, 'not-json']]) {
    let caught;
    try { execFileSync(process.execPath, [...args, digest], { input, stdio: 'pipe' }); }
    catch (error) { caught = error; }
    assert.equal(caught.status, 1);
    assert.match(JSON.parse(caught.stdout.toString()).systemMessage, /normify/);
    assert.equal(caught.stderr.toString(), '');
  }
  await assert.rejects(readdir(join(base, 'state')), { code: 'ENOENT' });
});

test('hook installation preserves existing hooks, trusts only its hash and reinstalls safely',
  { skip: !executable }, async t => {
    const { base, repo } = await fixture(t);
    const codexHome = join(base, 'codex home 汉字');
    await mkdir(codexHome);
    const previousGroup = { matcher: '^Bash$', hooks: [{ type: 'command', command: 'echo original' }] };
    const initial = { description: 'User hooks', hooks: { PostToolUse: [previousGroup], Stop: [] } };
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify(initial));
    const config = '# Keep user settings\napproval_policy = "never"\n\n[features]\nhooks = true\n';
    await writeFile(join(codexHome, 'config.toml'), config);
    const receipt = await installHooks({ executable, codexHome, cwd: repo, trustInstalled: true });
    assert.equal(receipt.trustStatus, 'trusted');
    const current = JSON.parse(await readFile(receipt.hooksFile, 'utf8'));
    assert.deepEqual(current.hooks.PostToolUse[0], previousGroup);
    assert.equal(current.description, initial.description);
    assert.deepEqual(current.hooks.Stop, []);
    assert.equal(current.hooks.PostToolUse.length, 2);
    assert.equal(await readFile(join(receipt.backup, 'config.toml'), 'utf8'), config);
    const after = await readFile(join(codexHome, 'config.toml'), 'utf8');
    assert.ok(after.startsWith(config.trimEnd()));
    const rpc = await connectCodex(executable, { cwd: repo, codexHome });
    try {
      const inventory = await rpc.request('hooks/list', { cwds: [repo] });
      assert.equal(inventory.data[0].hooks.find(hook => hook.command === 'echo original').trustStatus, 'untrusted');
    } finally { await rpc.close(); }
    const again = await installHooks({ executable, codexHome, cwd: repo, trustInstalled: true });
    assert.equal(again.currentHash, receipt.currentHash);
    assert.equal(await readFile(join(codexHome, 'config.toml'), 'utf8'), after);
    const command = current.hooks.PostToolUse[1].hooks[0].commandWindows;
    if (process.platform === 'win32') {
      for (let call = 1; call <= 8; call++) {
        const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
          { input: JSON.stringify(payload(repo, call)), encoding: 'utf8', windowsHide: true });
        if (call < 8) assert.equal(output.trim(), '');
        else assert.equal(JSON.parse(output).hookSpecificOutput.hookEventName, 'PostToolUse');
      }
    }
  });

test('hook installation refuses user-modified and unmanaged Normify hooks', { skip: !executable }, async t => {
  const { base, repo } = await fixture(t);
  const codexHome = join(base, 'home');
  const receipt = await installHooks({ executable, codexHome, cwd: repo });
  assert.equal(receipt.trustStatus, 'untrusted');
  const current = JSON.parse(await readFile(receipt.hooksFile, 'utf8'));
  current.hooks.PostToolUse[0].matcher = '*';
  await writeFile(receipt.hooksFile, JSON.stringify(current));
  await assert.rejects(installHooks({ executable, codexHome, cwd: repo }), /user changes/);
  assert.deepEqual(JSON.parse(await readFile(receipt.hooksFile, 'utf8')), current);
  const unmanagedHome = join(base, 'unmanaged-home');
  await mkdir(unmanagedHome);
  await writeFile(join(unmanagedHome, 'hooks.json'), JSON.stringify(current));
  await assert.rejects(installHooks({ executable, codexHome: unmanagedHome, cwd: repo }), /unmanaged/);
});

test('hook installation preserves a user-disabled native hooks feature', { skip: !executable }, async t => {
  const { base, repo } = await fixture(t);
  const codexHome = join(base, 'disabled-home');
  await mkdir(codexHome);
  const config = '[features]\nhooks = false\n';
  await writeFile(join(codexHome, 'config.toml'), config);
  await assert.rejects(installHooks({ executable, codexHome, cwd: repo, trustInstalled: true }), /disabled/);
  assert.equal(await readFile(join(codexHome, 'config.toml'), 'utf8'), config);
  await assert.rejects(readFile(join(codexHome, 'hooks.json')), { code: 'ENOENT' });
});

test('native Codex triggers the real reminder after eight apply_patch calls',
  { skip: !executable }, async t => {
    const { base, repo } = await fixture(t);
    const codexHome = join(base, 'native-home');
    await installHooks({ executable, codexHome, cwd: repo, trustInstalled: true });
    const model = await mockModel();
    t.after(() => model.close());
    const catalog = join(base, 'fixture-models.json');
    await writeFile(catalog, JSON.stringify(modelCatalog));
    const rpc = await connectCodex(executable, { cwd: repo, codexHome, captureDiagnostics: true, extraConfig: [
      'model="normify-fixture"', 'model_provider="normify_test"', `model_catalog_json=${JSON.stringify(catalog)}`,
      `model_providers.normify_test={name="Normify fixture",base_url=${JSON.stringify(model.url)},wire_api="responses",requires_openai_auth=false}`,
    ] });
    try {
      // 隔离配置与内存会话，不创建持久任务。
      const started = await rpc.request('thread/start', { cwd: repo, ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access' });
      await rpc.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text',
        text: 'Run the isolated hook fixture. Only write the eight hook-proof files in this temporary repository.' }] });
      for (let check = 0; check < 300 && !rpc.notifications.some(event => event.method === 'turn/completed'); check++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const finished = rpc.notifications.filter(event => event.method === 'hook/completed' && event.params.run.eventName === 'postToolUse');
      assert.equal(finished.length, 8, JSON.stringify({ calls: model.calls(), tools: model.tools(), toolResults: model.toolResults.slice(-8), notifications: rpc.notifications }));
      assert.ok(finished.every(event => event.params.run.status === 'completed'), JSON.stringify(finished.map(event => event.params.run.entries)));
      const reminders = finished.flatMap(event => event.params.run.entries).filter(entry => entry.kind === 'context');
      assert.equal(reminders.length, 1);
      assert.match(reminders[0].text, /normify_sync/);
      for (let file = 1; file <= 8; file++) assert.equal(await readFile(join(repo, `hook-proof-${file}.txt`), 'utf8'), 'fixture\n');
    } finally { await rpc.close(); await model.close(); }
  });
