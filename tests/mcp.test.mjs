import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { connect, fixture, localized, unpack } from './support.mjs';

test('real stdio handshake exposes tools, skills, and original reference', async t => {
  const { root } = await fixture(t);
  const { client, stderr } = await connect(t, root);
  assert.equal((await client.listTools()).tools.length, 31);
  assert.deepEqual((await client.listPrompts()).prompts.map(prompt => prompt.name),
    ['normify-gen', 'normify-dev']);
  const prompt = await client.getPrompt({ name: 'normify-gen', arguments: { repository: 'C:/test' } });
  assert.match(prompt.messages[0].content.text, /Repository \(data\)/);
  const resource = await client.readResource({ uri: 'normify://upstream/skill' });
  assert.match(resource.contents[0].text, /normify_module_upsert/);
  const help = await client.callTool({ name: 'normify_help', arguments: { topic: 'flow' } });
  assert.equal(help.isError, false);
  assert.equal(stderr(), '');
  await assert.rejects(client.callTool({ name: 'not_a_tool', arguments: {} }), /Unknown tool/);
});

test('schema failures do not reach the engine', async t => {
  const { root } = await fixture(t);
  const { client } = await connect(t, root);
  const result = await client.callTool({ name: 'normify_project_init', arguments: { project: 123 } });
  assert.equal(result.isError, true);
  assert.equal(unpack(result).error.code, 'args/schema');
  await assert.rejects(access(join(root, 'normify-123')));
});

test('MCP handles planned trees, activation, fingerprints, and rendered receipts', async t => {
  const { root, repo, git } = await fixture(t);
  const { client } = await connect(t, root);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: { project: 'demo', ...args } });
    const value = unpack(result);
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(value)}`);
    return value;
  };
  await call('normify_project_init', { root: { id: 'demo', name: localized('演示'),
    description: localized('架构验收') } });
  await call('normify_module_upsert', { frontmatter: {
    uid: '1234abcd', id: 'demo.engine', parent: 'demo', name: localized('引擎'),
    description: localized('执行引擎'), source: [{ path: 'src/engine.rs' }],
    revision: git('rev-parse', 'HEAD'), updated_at: new Date().toISOString(),
    fingerprint: 'pending', state: 'planned', apis: [{ protocol: 'file', path: 'step',
      description: localized('推进一步') }],
  } });
  await call('normify_validate');
  const blocked = await client.callTool({ name: 'normify_module_refresh', arguments: {
    project: 'demo', repoRoot: repo, ids: ['demo.engine'], activate: true,
  } });
  assert.equal(blocked.isError, true);
  await writeFile(join(repo, 'src', 'engine.rs'), 'pub fn step() {}\n');
  await call('normify_module_refresh', { repoRoot: repo, ids: ['demo', 'demo.engine'], activate: true });
  await call('normify_layout_upsert', { id: 'demo', order: ['demo.engine'],
    reading: localized('根节点下钻到引擎') });
  await call('normify_validate', { repoRoot: repo });
  await call('normify_build', { repoRoot: repo });
  const rendered = await call('normify_render');
  const directory = join(root, 'normify-demo');
  assert.ok(rendered.ok);
  assert.match(await readFile(join(directory, 'normify.html'), 'utf8'), /<!doctype html>/i);
  const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.stats.module_count, 2);
  assert.equal(receipt.stats.planned_count, 0);
  await writeFile(join(repo, 'src', 'engine.rs'), 'pub fn step() { println!("changed"); }\n');
  const drift = await client.callTool({ name: 'normify_validate', arguments: {
    project: 'demo', repoRoot: repo,
  } });
  assert.equal(drift.isError, true);
  assert.match(JSON.stringify(unpack(drift)), /fingerprint-drift/);
});

test('parallel clients serialize writes across MCP processes', async t => {
  const { root } = await fixture(t);
  const one = await connect(t, root);
  const two = await connect(t, root);
  const args = { project: 'parallel', root: { id: 'parallel', name: localized('并发'),
    description: localized('并发测试') } };
  const results = await Promise.all([one.client, two.client].map(client =>
    client.callTool({ name: 'normify_project_init', arguments: args })));
  assert.ok(results.every(result => !result.isError));
  const listing = unpack(await one.client.callTool({ name: 'normify_module_list',
    arguments: { project: 'parallel' } }));
  assert.match(JSON.stringify(listing), /parallel/);
});

test('read-only stdio mode rejects mutation tools', async t => {
  const { root } = await fixture(t);
  const { client } = await connect(t, root, ['--read-only']);
  assert.ok((await client.listTools()).tools.every(tool => tool.annotations.readOnlyHint));
  await assert.rejects(client.callTool({ name: 'normify_project_init',
    arguments: { project: 'denied' } }), /Unknown tool/);
});
