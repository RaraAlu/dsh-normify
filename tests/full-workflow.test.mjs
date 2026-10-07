import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { connect, fixture, localized, unpack } from './support.mjs';

test('all 31 tools execute through MCP and close a verified change', async t => {
  const { root, repo, git } = await fixture(t);
  const { client } = await connect(t, root);
  const called = new Set();
  const noProject = new Set(['normify_tree_list', 'normify_fingerprint', 'normify_help']);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: noProject.has(name)
      ? args : { project: 'demo', ...args } });
    const value = unpack(result);
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(value)}`);
    called.add(name);
    return value;
  };
  const revision = git('rev-parse', 'HEAD');
  let uid = 0;
  const module = (id, source = 'src/existing.rs', extra = {}) => ({
    uid: (++uid).toString(16).padStart(8, '0'), id,
    parent: id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null,
    name: localized(id), description: localized('架构契约'),
    source: source ? [{ path: source }] : [], revision,
    updated_at: new Date().toISOString(), fingerprint: 'pending', state: 'planned',
    apis: [{ protocol: 'file', path: id + '/run', description: localized('执行') }], ...extra,
  });

  await call('normify_project_init');
  await call('normify_help', { topic: 'tools' });
  const fingerprint = await call('normify_fingerprint', { repoRoot: repo,
    source: [{ path: 'src/existing.rs' }] });
  assert.match(JSON.stringify(fingerprint), /[a-f0-9]{64}/);
  await call('normify_module_upsert', { frontmatter: module('demo', null, { apis: undefined }) });
  await call('normify_module_batch', { items: [
    { frontmatter: module('demo.worker', 'src/worker.rs') },
    { frontmatter: module('demo.box') },
    { frontmatter: module('demo.temporary') },
  ] });
  await call('normify_module_promote', { id: 'demo.box' });
  await call('normify_module_upsert', { frontmatter: module('demo.box.child') });
  await call('normify_module_patch', { id: 'demo.worker', patch: { tags: ['worker'] } });
  await call('normify_module_move', { id: 'demo.temporary', new_id: 'demo.moved' });
  await call('normify_module_delete', { id: 'demo.moved' });

  await call('normify_tree_list');
  await call('normify_module_get', { id: 'demo.worker' });
  await call('normify_module_list', { parent: 'demo', direct_only: true });
  await call('normify_search', { query: 'worker' });
  await call('normify_deps_find', { to: 'demo.worker' });
  await call('normify_brief', { id: 'demo.worker', task: '实现执行接口' });
  await call('normify_policy_get');
  await call('normify_policy_upsert', { rules: [
    { id: 'acyclic', type: 'acyclic', scope: ['demo.**'] },
    { id: 'no-worker-to-box', type: 'forbid-dependency', from: ['demo.worker'], to: ['demo.box.**'] },
  ] });
  const blocked = await client.callTool({ name: 'normify_check', arguments: { project: 'demo',
    deps: [{ from: 'demo.worker', to: 'demo.box.child', kind: 'call' }],
  } });
  assert.equal(blocked.isError, true);
  assert.match(JSON.stringify(unpack(blocked)), /no-worker-to-box/);
  await call('normify_check', { modules: [{ id: 'demo.worker', parent: 'demo', state: 'planned' }] });

  await call('normify_layout_upsert', { id: 'demo', order: ['demo.box', 'demo.worker'],
    reading: localized('模块分层') });
  await call('normify_layout_get', { id: 'demo' });
  await call('normify_layout_delete', { id: 'demo' });
  await call('normify_layout_upsert', { id: 'demo', order: ['demo.box', 'demo.worker'],
    reading: localized('模块分层') });
  await call('normify_layout_upsert', { id: 'demo.box', order: ['demo.box.child'],
    reading: localized('组件下钻') });

  const change = await call('normify_change_open', { title: localized('接口实现'),
    intent: localized('完成架构闭环'), modules: { create: ['demo.worker'] },
    acceptance: ['源码落地，指纹匹配，架构校验零错误'],
  });
  await call('normify_change_update', { id: change.id, patch: { status: 'in_progress' } });
  await call('normify_change_list', { id: change.id });
  const before = await client.callTool({ name: 'normify_change_close', arguments: {
    project: 'demo', id: change.id, repoRoot: repo, activate: true,
  } });
  assert.equal(before.isError, true);
  await call('normify_sync', { repoRoot: repo });
  await writeFile(join(repo, 'src', 'worker.rs'), 'pub fn worker() {}\n');
  await call('normify_module_refresh', { repoRoot: repo, all: true, activate: true });
  await call('normify_validate', { repoRoot: repo });
  await call('normify_build', { repoRoot: repo });
  await call('normify_outline');
  await call('normify_render');
  const closed = await call('normify_change_close', { id: change.id, repoRoot: repo,
    activate: true, render: true });
  assert.ok(closed.ok);
  const details = await call('normify_change_list', { id: change.id });
  assert.match(JSON.stringify(details), /verified/);
  const receipt = JSON.parse(await readFile(join(root, 'normify-demo', 'receipt.json'), 'utf8'));
  assert.equal(receipt.stats.planned_count, 0);
  assert.deepEqual([...called].sort(), (await client.listTools()).tools.map(tool => tool.name).sort());
  assert.equal(called.size, 31);
});
