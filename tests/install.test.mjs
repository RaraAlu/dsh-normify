import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { installCodex } from '../scripts/install-codex.mjs';
import { execCodex, resolveCodex, resolveNpm } from '../scripts/cli.mjs';
import { adapterRoot, fixture, testCodex } from './support.mjs';

const options = (base, root) => ({ executable: testCodex, codexHome: join(base, 'codex home 汉字'),
  skillsRoot: join(base, 'skills'), storageRoot: root });

test('installation preserves configuration, backs up skills, and safely reinstalls',
  { skip: !testCodex }, async t => {
    const { base, root } = await fixture(t);
    const opts = options(base, root);
    await mkdir(opts.codexHome);
    const initial = '# Preserve this comment\napproval_policy = "never"\n\n' +
      `[mcp_servers.other]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["--version"]\nenabled = false\n`;
    await writeFile(join(opts.codexHome, 'config.toml'), initial);
    const receipt = await installCodex(opts);
    assert.equal(receipt.tools, 31);
    assert.equal(await readFile(join(receipt.backup, 'config.toml'), 'utf8'), initial);
    const current = await readFile(join(opts.codexHome, 'config.toml'), 'utf8');
    assert.match(current, /Preserve this comment/);
    assert.match(current, /\[mcp_servers\.other\]/);
    const again = await installCodex(opts);
    assert.equal(await readFile(join(opts.codexHome, 'config.toml'), 'utf8'), current);
    for (const name of ['normify-gen', 'normify-dev']) {
      assert.match(await readFile(join(opts.skillsRoot, name, 'SKILL.md'), 'utf8'), new RegExp(`name: ${name}`));
      await access(join(again.backup, name, '.normify-install.json'));
    }
    const path = join(opts.skillsRoot, 'normify-dev', 'SKILL.md');
    const custom = await readFile(path, 'utf8') + '\n用户修改\n';
    await writeFile(path, custom);
    await assert.rejects(installCodex(opts), /user changes/);
    assert.equal(await readFile(path, 'utf8'), custom);
    assert.equal(await readFile(join(opts.codexHome, 'config.toml'), 'utf8'), current);
  });

test('installer auto-detects Codex without a native-binary argument', { skip: !testCodex }, async t => {
  const { base, root } = await fixture(t);
  const opts = options(base, root);
  const output = execFileSync(process.execPath, [join(adapterRoot, 'scripts', 'install-codex.mjs'),
    '--codex-home', opts.codexHome, '--skills-root', opts.skillsRoot, '--storage-root', root],
  { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_CLI_PATH: testCodex } });
  assert.equal(JSON.parse(output).tools, 31);
  assert.equal(resolveCodex(testCodex).command, testCodex);
  assert.ok(resolveNpm().args[0].endsWith('npm-cli.js'));
});

test('installer refuses unmanaged skills and symlink destinations', { skip: !testCodex }, async t => {
  const { base, root } = await fixture(t);
  const opts = options(base, root);
  const path = join(opts.skillsRoot, 'normify-gen');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), 'user-owned skill');
  await assert.rejects(installCodex(opts), /unmanaged skill/);
  assert.equal(await readFile(join(path, 'SKILL.md'), 'utf8'), 'user-owned skill');
  const external = join(base, 'external');
  const otherSkills = join(base, 'linked-skills');
  await mkdir(external);
  await mkdir(otherSkills);
  await symlink(external, join(otherSkills, 'normify-gen'), 'junction');
  await assert.rejects(installCodex({ ...opts, skillsRoot: otherSkills }), /symbolic-link/);
  assert.deepEqual(await readdir(external), []);
});

test('disabled or unrelated MCP configuration remains untouched', { skip: !testCodex }, async t => {
  const { base, root } = await fixture(t);
  const opts = options(base, root);
  await mkdir(opts.codexHome);
  const initial = `[mcp_servers.normify]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["--version"]\nenabled = false\n`;
  await writeFile(join(opts.codexHome, 'config.toml'), initial);
  await assert.rejects(installCodex({ ...opts, migrate: true }), /disabled normify/);
  assert.equal(await readFile(join(opts.codexHome, 'config.toml'), 'utf8'), initial);
  await assert.rejects(access(opts.skillsRoot));
});

test('explicit migration replaces only an unchanged managed checkout', { skip: !testCodex }, async t => {
  const { base, root } = await fixture(t);
  const opts = options(base, root);
  await installCodex(opts);
  const old = join(base, 'old adapter');
  for (const name of ['normify-gen', 'normify-dev']) {
    const path = join(opts.skillsRoot, name, '.normify-install.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.adapter = old;
    await writeFile(path, JSON.stringify(manifest));
  }
  execCodex(testCodex, ['mcp', 'add', 'normify', '--', process.execPath,
    join(old, 'src', 'stdio.mjs'), '--root', root], { env: { ...process.env, CODEX_HOME: opts.codexHome } });
  const before = await readFile(join(opts.codexHome, 'config.toml'), 'utf8');
  await assert.rejects(installCodex(opts), /--migrate/);
  assert.equal(await readFile(join(opts.codexHome, 'config.toml'), 'utf8'), before);
  const receipt = await installCodex({ ...opts, storageRoot: undefined, migrate: true });
  assert.equal(receipt.adapter, adapterRoot);
  assert.equal(receipt.storageRoot, root);
  const registered = JSON.parse(execCodex(testCodex, ['mcp', 'get', 'normify', '--json'],
    { env: { ...process.env, CODEX_HOME: opts.codexHome } }));
  assert.equal(registered.transport.args[0], join(adapterRoot, 'src', 'stdio.mjs'));
});

test('partial CLI failure rolls back configuration and newly installed skills', async t => {
  const { base, root } = await fixture(t);
  const home = join(base, 'rollback-home');
  const skills = join(base, 'rollback-skills');
  const stub = join(base, 'failing-cli.mjs');
  await mkdir(home);
  const initial = '# Exact rollback proof\napproval_policy = "never"\n';
  await writeFile(join(home, 'config.toml'), initial);
  await writeFile(stub, `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex-test');
else if (args[1] === 'list') console.log('[]');
else { writeFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'partial modification'); process.exit(7); }
`);
  await assert.rejects(installCodex({ executable: stub, codexHome: home, skillsRoot: skills, storageRoot: root }));
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), initial);
  assert.deepEqual(await readdir(skills), []);
  const backups = await readdir(join(home, 'backups', 'normify-codex'));
  assert.equal(await readFile(join(home, 'backups', 'normify-codex', backups[0], 'config.toml'), 'utf8'), initial);
});

test('resolver rejects missing executables and absent PATH entries', () => {
  assert.throws(() => resolveCodex('missing-normify-codex-binary'), /not found/);
  assert.throws(() => resolveCodex(undefined, { PATH: '' }), /Codex not found/);
});

test('failed reinstall restores existing managed skills exactly', { skip: !testCodex }, async t => {
  const { base, root } = await fixture(t);
  const opts = options(base, root);
  await installCodex(opts);
  const before = await readFile(join(opts.codexHome, 'config.toml'));
  const skillBefore = await readFile(join(opts.skillsRoot, 'normify-gen', '.normify-install.json'));
  const stub = join(base, 'failed-reinstall.mjs');
  await writeFile(stub, `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex-test');
else if (args[1] === 'list') console.log('[]');
else { writeFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'partial modification'); process.exit(7); }
`);
  await assert.rejects(installCodex({ ...opts, executable: stub }));
  assert.deepEqual(await readFile(join(opts.codexHome, 'config.toml')), before);
  assert.deepEqual(await readFile(join(opts.skillsRoot, 'normify-gen', '.normify-install.json')), skillBefore);
  assert.deepEqual((await readdir(opts.skillsRoot)).sort(), ['normify-dev', 'normify-gen']);
  assert.equal((await installCodex(opts)).tools, 31);
});

test('verification checks native Codex discovery of this checkout and both skills',
  { skip: !testCodex }, async t => {
    const { base, root, repo } = await fixture(t);
    const opts = { ...options(base, root), skillsRoot: join(repo, '.agents', 'skills') };
    await installCodex(opts);
    const report = join(base, 'verification.json');
    execFileSync(process.execPath, [join(adapterRoot, 'scripts', 'verify-codex.mjs'),
      '--codex-executable', testCodex, '--codex-home', opts.codexHome, '--cwd', repo, '--output', report],
    { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(result.mcp.tools, 31);
    assert.equal(result.mcp.serverInfo.version, '0.6.0');
    assert.deepEqual(result.skills.map(skill => skill.name).sort(), ['normify-dev', 'normify-gen']);
  });
