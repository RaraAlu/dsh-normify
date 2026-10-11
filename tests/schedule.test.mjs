import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { connect, fixture, localized, unpack } from './support.mjs';

const at = '2026-10-11T00:00:00.000Z';
const id = slug => '2026-10-11-' + slug;
const ids = values => values.map(value => typeof value === 'string' ? value : value.id);
const engine = () => import('../lib/engine/schedule.js');

function change(slug, extra = {}) {
  return {
    schema_version: 1, id: id(slug), title: localized(slug), intent: localized('开发排程'),
    status: 'proposed', modules: {}, acceptance: ['验收通过'],
    revision: { before: null, after: null }, created_at: at, updated_at: at,
    ...extra,
  };
}

async function project(t) {
  const context = await fixture(t);
  const session = await connect(t, context.root);
  const invoke = async (name, args = {}) => session.client.callTool({
    name, arguments: { project: 'demo', ...args },
  });
  const call = async (name, args = {}) => {
    const result = await invoke(name, args);
    const value = unpack(result);
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(value)}`);
    return value;
  };
  const reject = async (name, args = {}) => {
    const result = await invoke(name, args);
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(unpack(result))}`);
    return unpack(result);
  };
  const open = (slug, extra = {}) => call('normify_change_open', {
    id: id(slug), title: localized(slug), intent: localized('开发排程'),
    modules: {}, acceptance: ['验收通过'], ...extra,
  });
  await call('normify_project_init', { root: {
    id: 'demo', name: localized('演示'), description: localized('排程验收'),
  } });
  await call('normify_module_upsert', { frontmatter: {
    uid: '1234abc0', id: 'demo.base', parent: 'demo', name: localized('基础'),
    description: localized('测试基础模块'), source: [{ path: 'src/existing.rs' }],
    revision: context.git('rev-parse', 'HEAD'), updated_at: at,
    fingerprint: 'pending', state: 'planned', apis: [],
  } });
  return { ...context, ...session, call, reject, invoke, open,
    directory: join(context.root, 'normify-demo') };
}

test('schedule metadata validates without changing legacy changes', async () => {
  const { l1ValidateChange } = await import('../lib/engine/changes.js');
  const legacy = change('legacy', { status: 'in_progress' });
  assert.deepEqual(l1ValidateChange(legacy, legacy.id, 'test').change, legacy);
  const valid = change('valid', { schedule: { depends_on: [id('legacy')], phase: 'P1',
    owner: 'agent-a', files: ['src/model.ts', 'tests/'], resources: ['gpu:0'], priority: 100 } });
  assert.deepEqual(l1ValidateChange(valid, valid.id, 'test').change.schedule, valid.schedule);
  for (const schedule of [null, [], { extra: true }, { priority: -1 }, { priority: 101 },
    { priority: 1.5 }, { depends_on: ['not-a-change'] }, { depends_on: [id('a'), id('a')] },
    { files: ['../escape'] }, { files: ['/absolute'] }, { files: ['C:/absolute'] },
    { files: ['\\\\server\\share'] }, { files: ['src/../escape'] }, { files: [''] },
    { resources: [''] }, { phase: '' }, { owner: '' }]) {
    const candidate = change('invalid', { schedule });
    const result = l1ValidateChange(candidate, candidate.id, 'test');
    assert.equal(result.change, null, JSON.stringify(schedule));
    assert.ok(result.errors.length > 0, JSON.stringify(schedule));
  }
});

test('schedule distinguishes verified dependencies from pending and abandoned work', async () => {
  const { buildSchedule } = await engine();
  const changes = [
    change('done', { schedule: {}, status: 'verified', closed_at: at }),
    change('ready', { schedule: { depends_on: [id('done')] } }),
    change('pending', { schedule: { depends_on: [id('ready')] } }),
    change('discarded', { schedule: {}, status: 'abandoned', closed_at: at }),
    change('discarded-child', { schedule: { depends_on: [id('discarded')] } }),
    change('legacy', { status: 'in_progress' }),
  ];
  const before = JSON.stringify(changes);
  const plan = buildSchedule(changes);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(ids(plan.ready), [id('ready')]);
  assert.ok(ids(plan.blocked).includes(id('pending')));
  assert.ok(ids(plan.blocked).includes(id('discarded-child')));
  assert.ok(ids(plan.completed).includes(id('done')));
  assert.ok(!ids(plan.completed).includes(id('discarded')));
  assert.ok(ids(plan.unscheduled).includes(id('legacy')));
  assert.equal(JSON.stringify(changes), before, 'The planner must not mutate change records.');
  assert.match(plan.mermaid, /flowchart/);
});

test('schedule rejects missing dependencies, self references, and dependency cycles', async () => {
  const { buildSchedule } = await engine();
  const invalid = [
    [change('missing', { schedule: { depends_on: [id('absent')] } })],
    [change('self', { schedule: { depends_on: [id('self')] } })],
    [change('a', { schedule: { depends_on: [id('b')] } }),
      change('b', { schedule: { depends_on: [id('c')] } }),
      change('c', { schedule: { depends_on: [id('a')] } })],
  ];
  for (const changes of invalid) {
    const plan = buildSchedule(changes);
    assert.equal(plan.ok, false, JSON.stringify(changes));
    assert.ok(plan.errors.length > 0);
  }
});

test('schedule orders candidate waves by priority and explicit dependencies', async () => {
  const { buildSchedule } = await engine();
  const changes = [
    change('last', { schedule: { phase: 'P0', priority: 100, files: ['src/last.ts'] } }),
    change('child', { schedule: { depends_on: [id('first')], priority: 0, files: ['src/child.ts'] } }),
    change('first', { schedule: { phase: 'P9', priority: 0, files: ['src/first.ts'] } }),
  ];
  const plan = buildSchedule(changes);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(ids(plan.ready), [id('first'), id('last')]);
  const waves = plan.waves.map(ids);
  assert.ok(waves[0].includes(id('first')));
  assert.ok(waves[0].includes(id('last')));
  assert.ok(!waves[0].includes(id('child')));
  assert.ok(waves.findIndex(wave => wave.includes(id('child'))) >
    waves.findIndex(wave => wave.includes(id('first'))));
  const reversed = buildSchedule([...changes].reverse());
  assert.deepEqual(reversed.waves, plan.waves);
  assert.deepEqual(reversed.ready, plan.ready);
});

test('parallel waves serialize overlapping modules, paths, and exclusive resources', async () => {
  const { buildSchedule } = await engine();
  const pairs = [
    [{ modules: { modify: ['demo.worker'] } }, { modules: { modify: ['demo.worker.child'] } }],
    [{ modules: { modify: ['demo.worker'] } },
      { modules: { api_add: [{ module: 'demo.worker', key: 'file/run' }] } }],
    [{ schedule: { files: ['src/model.ts'] } }, { schedule: { files: ['SRC/MODEL.ts'] } }],
    [{ schedule: { files: ['src/model/'] } }, { schedule: { files: ['src/model/types.ts'] } }],
    [{ schedule: { resources: ['gpu:0'] } }, { schedule: { resources: ['gpu:0'] } }],
  ];
  for (const [left, right] of pairs) {
    const changes = [change('left', { schedule: {}, ...left }), change('right', { schedule: {}, ...right })];
    const plan = buildSchedule(changes);
    assert.equal(plan.ok, true, JSON.stringify(plan.errors));
    assert.ok(plan.conflicts.length > 0, JSON.stringify(changes));
    assert.ok(plan.waves.every(wave => !(ids(wave).includes(id('left')) && ids(wave).includes(id('right')))),
      JSON.stringify(plan.waves));
    const running = buildSchedule(changes.map(value => ({ ...value, status: 'in_progress' })));
    assert.equal(running.ok, false, JSON.stringify(changes));
    assert.ok(running.errors.length > 0);
  }
});

test('parallel waves preserve path and module boundaries', async () => {
  const { buildSchedule } = await engine();
  const plan = buildSchedule([
    change('one', { modules: { modify: ['demo.worker'] },
      schedule: { files: ['src/model/'], resources: ['gpu:0'] } }),
    change('two', { modules: { modify: ['demo.workers'] },
      schedule: { files: ['src/models/types.ts'], resources: ['gpu:1'] } }),
  ]);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.equal(plan.conflicts.length, 0);
  assert.ok(plan.waves.some(wave => ids(wave).includes(id('one')) && ids(wave).includes(id('two'))));
});

test('planner includes unscheduled running module conflicts', async () => {
  const { buildSchedule } = await engine();
  const plan = buildSchedule([
    change('legacy', { status: 'in_progress', modules: { modify: ['demo.worker'] } }),
    change('scheduled', { status: 'in_progress', schedule: {},
      modules: { modify: ['demo.worker.child'] } }),
  ]);
  assert.equal(plan.ok, false);
  assert.ok(plan.conflicts.length > 0);
  assert.ok(ids(plan.unscheduled).includes(id('legacy')));
});

test('unscheduled running tasks block conflicts without entering predicted waves', async () => {
  const { buildSchedule } = await engine();
  const plan = buildSchedule([
    change('legacy', { status: 'in_progress', modules: { modify: ['demo.worker'] } }),
    change('blocked', { schedule: {}, modules: { modify: ['demo.worker.child'] } }),
    change('independent', { schedule: { files: ['src/independent.ts'] } }),
  ]);
  assert.equal(plan.ok, true);
  assert.ok(plan.running.includes(id('legacy')));
  assert.ok(plan.unscheduled.includes(id('legacy')));
  assert.ok(plan.blocked.includes(id('blocked')));
  assert.deepEqual(plan.ready, [id('independent')]);
  const predicted = plan.waves.flat();
  assert.ok(!predicted.includes(id('legacy')));
  assert.ok(!predicted.includes(id('blocked')));
  assert.ok(predicted.includes(id('independent')));
});

test('planner infers shared source files from distinct modules and ancestor claims', async () => {
  const { buildSchedule } = await engine();
  const file = (id, paths) => ({ module: { id, source: paths.map(path => ({ path })) }, body: '', file: id + '.md' });
  const byId = new Map([
    ['demo.left', file('demo.left', ['src/Shared.ts'])],
    ['demo.right', file('demo.right', ['src/shared.ts'])],
    ['demo.container', file('demo.container', [])],
    ['demo.container.child', file('demo.container.child', ['src/nested.ts'])],
    ['demo.writer', file('demo.writer', ['src/nested.ts'])],
  ]);
  const shared = buildSchedule([
    change('left', { schedule: {}, modules: { modify: ['demo.left'] } }),
    change('right', { schedule: {}, modules: { modify: ['demo.right'] } }),
  ], byId);
  assert.equal(shared.ok, true);
  assert.deepEqual(shared.conflicts[0].modules, []);
  assert.deepEqual(shared.conflicts[0].files, ['src/shared.ts']);
  assert.ok(shared.waves.every(wave => wave.length === 1));
  const parent = buildSchedule([
    change('parent', { schedule: {}, modules: { modify: ['demo.container'] } }),
    change('writer', { schedule: {}, modules: { modify: ['demo.writer'] } }),
  ], byId);
  assert.equal(parent.ok, true);
  assert.deepEqual(parent.conflicts[0].files, ['src/nested.ts']);
  assert.deepEqual(parent.tasks.find(task => task.id === id('parent')).files, ['src/nested.ts']);
  const running = buildSchedule([
    change('left', { schedule: {}, status: 'in_progress', modules: { modify: ['demo.left'] } }),
    change('right', { schedule: {}, status: 'in_progress', modules: { modify: ['demo.right'] } }),
  ], byId);
  assert.equal(running.ok, false);
});

test('MCP preserves 31 tools and scheduled versus legacy defaults', async t => {
  const { client, open, call, directory } = await project(t);
  assert.equal((await client.listTools()).tools.length, 31);
  assert.equal((await open('legacy')).status, 'in_progress');
  assert.equal((await open('scheduled', { schedule: { phase: 'P1', owner: 'agent-a' } })).status, 'proposed');
  const detail = await call('normify_change_list', { id: id('scheduled') });
  assert.deepEqual(detail.change.schedule, { phase: 'P1', owner: 'agent-a' });
  const legacy = JSON.parse(await readFile(join(directory, 'changes', id('legacy') + '.json'), 'utf8'));
  assert.ok(!Object.hasOwn(legacy, 'schedule'));
  const listing = await call('normify_change_list');
  assert.equal(listing.count, 2);
  const scheduled = await call('normify_change_list', { view: 'schedule' });
  assert.ok(scheduled.tasks);
  assert.ok(ids(scheduled.ready).includes(id('scheduled')));
  const unfiltered = await call('normify_change_list', { view: 'schedule', id: id('absent'), status: 'verified' });
  assert.deepEqual(unfiltered.tasks, scheduled.tasks);
  assert.deepEqual(unfiltered.ready, scheduled.ready);
  const brief = await call('normify_brief', { include_schedule: true });
  assert.ok(brief.schedule);
  assert.deepEqual(ids(brief.schedule.ready), ids(scheduled.ready));
  assert.ok(!Object.hasOwn(await call('normify_brief'), 'schedule'));
});

test('MCP rejects missing, self, and cyclic dependencies without writing changes', async t => {
  const { open, call, reject, directory } = await project(t);
  for (const [slug, schedule] of [
    ['missing', { depends_on: [id('absent')] }], ['self', { depends_on: [id('self')] }],
  ]) {
    await reject('normify_change_open', { id: id(slug), title: localized(slug), intent: localized('排程'),
      modules: {}, acceptance: ['验收通过'], schedule });
    await assert.rejects(access(join(directory, 'changes', id(slug) + '.json')));
  }
  await open('a', { schedule: {} });
  await open('b', { schedule: { depends_on: [id('a')] } });
  const file = join(directory, 'changes', id('a') + '.json');
  const before = await readFile(file, 'utf8');
  await reject('normify_change_update', { id: id('a'), patch: { schedule: { depends_on: [id('b')] } } });
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual((await call('normify_change_list', { id: id('a') })).change.schedule, {});
});

test('MCP replaces schedule metadata and rejects removal and direct verification', async t => {
  const { open, call, reject, directory } = await project(t);
  await open('replace', { schedule: { phase: 'P1', owner: 'agent-a', files: ['src/one.ts'],
    resources: ['gpu:0'], priority: 20 } });
  await call('normify_change_update', { id: id('replace'), patch: { schedule: { owner: 'agent-b' } } });
  assert.deepEqual((await call('normify_change_list', { id: id('replace') })).change.schedule, { owner: 'agent-b' });
  const file = join(directory, 'changes', id('replace') + '.json');
  const before = await readFile(file, 'utf8');
  await reject('normify_change_update', { id: id('replace'), patch: { schedule: null } });
  await reject('normify_change_update', { id: id('replace'), patch: { status: 'verified', closed_at: at } });
  assert.equal(await readFile(file, 'utf8'), before);
});

test('MCP freezes running claims and prevents abandoned scheduled tasks from reviving', async t => {
  const { open, call, reject, directory } = await project(t);
  await open('done', { schedule: {} });
  await call('normify_change_close', { id: id('done') });
  const schedule = { depends_on: [id('done')], files: ['src/owned.ts'], resources: ['gpu:0'] };
  await open('running', { schedule });
  await call('normify_change_update', { id: id('running'), patch: { status: 'in_progress' } });
  const file = join(directory, 'changes', id('running') + '.json');
  const before = await readFile(file, 'utf8');
  for (const patch of [
    { status: 'proposed' }, { modules: { modify: ['demo.base'] } },
    { schedule: { ...schedule, depends_on: [] } },
    { schedule: { ...schedule, files: ['src/other.ts'] } },
    { schedule: { ...schedule, resources: ['gpu:1'] } },
  ]) {
    await reject('normify_change_update', { id: id('running'), patch });
    assert.equal(await readFile(file, 'utf8'), before);
  }
  await call('normify_change_update', { id: id('running'), patch: { schedule: { ...schedule, owner: 'agent-b' } } });
  assert.equal((await call('normify_change_list', { id: id('running') })).change.schedule.owner, 'agent-b');
  await call('normify_change_update', { id: id('running'), patch: { status: 'abandoned' } });
  const abandoned = await readFile(file, 'utf8');
  await reject('normify_change_update', { id: id('running'), patch: { status: 'proposed', closed_at: null } });
  await reject('normify_change_update', { id: id('running'), patch: { status: 'in_progress', closed_at: null } });
  await reject('normify_change_close', { id: id('running') });
  assert.equal(await readFile(file, 'utf8'), abandoned);
});

test('MCP starts dependents only after close verifies predecessors', async t => {
  const { open, call, reject, directory } = await project(t);
  await open('parent', { schedule: {} });
  await open('child', { schedule: { depends_on: [id('parent')], files: ['src/child.ts'] } });
  const file = join(directory, 'changes', id('child') + '.json');
  const before = await readFile(file, 'utf8');
  await reject('normify_change_update', { id: id('child'), patch: { status: 'in_progress' } });
  assert.equal(await readFile(file, 'utf8'), before);
  await call('normify_change_update', { id: id('parent'), patch: { status: 'in_progress' } });
  await reject('normify_change_update', { id: id('child'), patch: { status: 'in_progress' } });
  await call('normify_change_close', { id: id('parent') });
  const closedPlan = await call('normify_change_list', { view: 'schedule', id: id('child'), status: 'proposed' });
  assert.ok(ids(closedPlan.completed).includes(id('parent')));
  assert.ok(ids(closedPlan.ready).includes(id('child')));
  assert.deepEqual(closedPlan.tasks.find(task => task.id === id('child')).depends_on, [id('parent')]);
  assert.equal((await call('normify_change_update', { id: id('child'), patch: { status: 'in_progress' } })).status,
    'in_progress');
});

test('MCP checks close dependencies before refreshing or activating modules', async t => {
  const { open, call, reject, directory, repo, git } = await project(t);
  await call('normify_module_upsert', { frontmatter: {
    uid: '1234abcd', id: 'demo.worker', parent: 'demo', name: localized('执行器'),
    description: localized('排程刷新测试'), source: [{ path: 'src/existing.rs' }],
    revision: git('rev-parse', 'HEAD'), updated_at: at, fingerprint: 'pending', state: 'planned', apis: [],
  } });
  await open('predecessor', { schedule: {} });
  await open('dependent', { schedule: { depends_on: [id('predecessor')] }, modules: { create: ['demo.worker'] } });
  const moduleFile = join(directory, 'modules', 'demo', 'worker.md');
  const before = await readFile(moduleFile, 'utf8');
  await writeFile(join(repo, 'src', 'existing.rs'), 'pub fn changed() {}\n');
  await reject('normify_change_close', { id: id('dependent'), repoRoot: repo, activate: true });
  assert.equal(await readFile(moduleFile, 'utf8'), before);
  assert.equal((await call('normify_change_list', { id: id('dependent') })).change.status, 'proposed');
});

test('MCP refuses concurrent file and resource writers atomically', async t => {
  const { root, client, open, call, reject, directory } = await project(t);
  await open('writer-a', { schedule: { files: ['src/Model/'], resources: ['gpu:0'] } });
  await open('writer-b', { schedule: { files: ['src/model/types.ts'], resources: ['gpu:0'] } });
  const peer = await connect(t, root);
  const starts = await Promise.all([client, peer.client].map((target, index) => target.callTool({
    name: 'normify_change_update', arguments: { project: 'demo',
      id: id(index === 0 ? 'writer-a' : 'writer-b'), patch: { status: 'in_progress' } },
  })));
  assert.equal(starts.filter(result => !result.isError).length, 1);
  assert.equal(starts.filter(result => result.isError).length, 1);
  const statuses = await Promise.all(['writer-a', 'writer-b'].map(slug =>
    call('normify_change_list', { id: id(slug) })));
  assert.deepEqual(statuses.map(value => value.change.status).sort(), ['in_progress', 'proposed']);
  const running = statuses.find(value => value.change.status === 'in_progress').change;
  const pending = statuses.find(value => value.change.status === 'proposed').change;
  const file = join(directory, 'changes', pending.id + '.json');
  const before = await readFile(file, 'utf8');
  await reject('normify_change_update', { id: pending.id, patch: { status: 'in_progress' } });
  assert.equal(await readFile(file, 'utf8'), before);
  await call('normify_change_close', { id: running.id });
  await call('normify_change_update', { id: pending.id, patch: { status: 'in_progress' } });
});

test('different MCP storage roots serialize writers targeting the same absolute project directory', async t => {
  const { base, client, open, call, directory } = await project(t);
  const peer = await connect(t, join(base, 'other-storage'));
  for (let round = 0; round < 4; round++) {
    const slugs = ['cross-root-a-' + round, 'cross-root-b-' + round];
    for (const slug of slugs) {
      await open(slug, { schedule: { files: ['src/' + slug + '.ts'], resources: ['gpu:cross-root-' + round] } });
    }
    const results = await Promise.all([client, peer.client].map((target, index) => target.callTool({
      name: 'normify_change_update', arguments: { dir: directory, id: id(slugs[index]),
        patch: { status: 'in_progress' } },
    })));
    assert.equal(results.filter(result => !result.isError).length, 1, JSON.stringify(results.map(unpack)));
    assert.equal(results.filter(result => result.isError).length, 1);
    const winner = results.findIndex(result => !result.isError);
    await call('normify_change_close', { id: id(slugs[winner]) });
    await call('normify_change_update', { id: id(slugs[1 - winner]), patch: { status: 'abandoned' } });
  }
});

test('MCP accounts for an unscheduled running module writer', async t => {
  const { open, call, reject } = await project(t);
  await open('legacy', { modules: { modify: ['demo'] } });
  await open('planned', { schedule: {}, modules: { modify: ['demo'] } });
  await reject('normify_change_update', { id: id('planned'), patch: { status: 'in_progress' } });
  const plan = await call('normify_change_list', { view: 'schedule' });
  assert.ok(ids(plan.unscheduled).includes(id('legacy')));
  assert.ok(plan.conflicts.length > 0);
});

test('MCP build and render generate schedule artifacts only for scheduled projects', async t => {
  const { open, call, directory } = await project(t);
  await call('normify_build');
  for (const file of ['schedule.json', 'schedule.md', 'schedule.mmd']) {
    await assert.rejects(access(join(directory, file)));
  }
  const title = '</script><script>alert("schedule")</script>" [injected]';
  await open('display', { title: localized(title), schedule: { phase: 'P1', owner: '<agent>',
    files: ['src/display.ts'], resources: ['gpu:0'], priority: 80 } });
  await call('normify_build');
  const plan = JSON.parse(await readFile(join(directory, 'schedule.json'), 'utf8'));
  assert.equal(plan.ok, true);
  assert.ok(ids(plan.ready).includes(id('display')));
  const markdown = await readFile(join(directory, 'schedule.md'), 'utf8');
  const mermaid = await readFile(join(directory, 'schedule.mmd'), 'utf8');
  assert.match(markdown, /2026-10-11-display/);
  assert.match(mermaid, /flowchart/);
  assert.equal(mermaid.trim(), plan.mermaid.trim());
  const rendered = await call('normify_render', { view: 'schedule' });
  assert.match(rendered.url, /^http:\/\/127\.0\.0\.1:\d+\//);
  assert.equal(rendered.html, undefined);
  await assert.rejects(access(join(directory, 'schedule.html')));
  const html = await (await fetch(rendered.url)).text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /2026-10-11-display/);
  assert.ok(!html.includes(title), 'Untrusted schedule titles must not create HTML script elements.');
  assert.ok(!html.includes('<script>alert("schedule")</script>'));
  await call('normify_render');
  assert.match(await readFile(join(directory, 'normify.html'), 'utf8'), /<!doctype html>/i);
});

test('live schedule ignores frozen artifacts and rejects all file outputs', async t => {
  const { open, call, reject, directory, root } = await project(t);
  await open('render', { schedule: {} });
  await call('normify_build');
  const receiptFile = join(directory, 'receipt.json');
  const backupFile = join(directory, 'receipt.saved.json');
  await rename(receiptFile, backupFile);
  const missing = await call('normify_render', { view: 'schedule' });
  assert.match(missing.url, /^http:\/\/127\.0\.0\.1:/);
  await assert.rejects(access(join(directory, 'schedule.html')));
  await rename(backupFile, receiptFile);
  const scheduleFile = join(directory, 'schedule.json');
  const frozen = await readFile(scheduleFile, 'utf8');
  await writeFile(scheduleFile, frozen + ' ');
  const tampered = await call('normify_render', { view: 'schedule' });
  assert.equal(tampered.url, missing.url);
  await assert.rejects(access(join(directory, 'schedule.html')));
  await writeFile(scheduleFile, frozen);
  for (const view of ['schedule', 'architecture']) {
    const escaped = await reject('normify_render', { view, out: '../outside.html' });
    assert.match(JSON.stringify(escaped), view === 'schedule' ? /render\/schedule-file-output/ : /render\/unsafe-out/);
    await assert.rejects(access(join(root, 'outside.html')));
    await reject('normify_render', { view, out: join(root, 'absolute.html') });
    await assert.rejects(access(join(root, 'absolute.html')));
  }
  await reject('normify_render', { view: 'schedule', out: 'safe.html' });
  await assert.rejects(access(join(directory, 'safe.html')));
});

test('schedule rendering rejects symbolic links to output files', async t => {
  const { open, call, reject, directory, base } = await project(t);
  await open('links', { schedule: {} });
  await call('normify_build');
  const outside = join(base, 'outside');
  await mkdir(outside);
  const sentinel = join(outside, 'sentinel.html');
  await writeFile(sentinel, 'keep');
  const linkedFile = join(directory, 'linked.html');
  try {
    await symlink(sentinel, linkedFile, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('The platform does not permit symbolic link creation.');
      return;
    }
    throw error;
  }
  const rejected = await reject('normify_render', { view: 'schedule', out: 'linked.html' });
  assert.match(JSON.stringify(rejected), /render\/schedule-file-output/);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});

test('schedule rendering rejects external symbolic directory and junction parents', async t => {
  const { open, call, reject, directory, base } = await project(t);
  await open('directory-link', { schedule: {} });
  await call('normify_build');
  const outside = join(base, 'outside');
  await mkdir(outside);
  const linkedDirectory = join(directory, 'linked-parent');
  try {
    await symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('The platform does not permit symbolic directory links.');
      return;
    }
    throw error;
  }
  const rejected = await reject('normify_render', { view: 'schedule', out: 'linked-parent/generated.html' });
  assert.match(JSON.stringify(rejected), /render\/schedule-file-output/);
  await assert.rejects(access(join(outside, 'generated.html')));
});

test('live schedule never displays stale artifacts after task removal', async t => {
  const { open, call, reject, directory } = await project(t);
  await open('archived', { schedule: {} });
  await call('normify_build');
  const scheduleFile = join(directory, 'schedule.json');
  const oldSchedule = await readFile(scheduleFile, 'utf8');
  const oldReceipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
  assert.ok(oldReceipt.artifacts['schedule.json']);
  await rename(join(directory, 'changes', id('archived') + '.json'), join(directory, 'archived.saved.json'));
  await call('normify_build');
  const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
  assert.ok(!Object.hasOwn(receipt.artifacts, 'schedule.json'));
  await writeFile(scheduleFile, oldSchedule);
  const rendered = await call('normify_render', { view: 'schedule' });
  const html = await (await fetch(rendered.url)).text();
  assert.ok(!html.includes(id('archived')));
  await assert.rejects(access(join(directory, 'schedule.html')));
  await call('normify_render');
});

test('loadSchedulePlan reports corrupt change files rather than hiding them', async t => {
  const { loadSchedulePlan, checkScheduledChange, renderScheduleMarkdown } = await engine();
  const { directory, open } = await project(t);
  await open('good', { schedule: {} });
  await writeFile(join(directory, 'changes', id('broken') + '.json'), '{ broken json\n');
  const plan = await loadSchedulePlan(directory);
  assert.equal(plan.ok, false);
  assert.ok(plan.errors.length > 0);
  const checked = await checkScheduledChange(directory, change('candidate', { schedule: {} }));
  assert.ok(checked.some(diagnostic => diagnostic.severity === 'error'));
  assert.equal(typeof renderScheduleMarkdown(plan), 'string');
  assert.deepEqual((await readdir(join(directory, 'changes'))).sort(),
    [id('broken') + '.json', id('good') + '.json'].sort());
});

test('schedule loading reports an unreadable change directory rather than an empty plan', async t => {
  const { loadSchedulePlan } = await engine();
  const { directory, open, reject } = await project(t);
  await open('visible', { schedule: {} });
  await rename(join(directory, 'changes'), join(directory, 'changes.saved'));
  await writeFile(join(directory, 'changes'), 'This is a file, not a directory.\n');
  const plan = await loadSchedulePlan(directory);
  assert.equal(plan.ok, false);
  assert.ok(plan.errors.length > 0);
  assert.deepEqual(plan.ready, []);
  assert.deepEqual(plan.waves, []);
  await reject('normify_change_list', { view: 'schedule' });
});
