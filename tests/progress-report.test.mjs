import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { collectTools } from '../src/catalog.mjs';
import { collectProgressReport, compactProgressReport, stableJson, summarizeAcceptance, workspaceSnapshot } from '../src/progress-report.mjs';
import { progressHook, progressIntent } from '../src/progress-hook.mjs';
import { fixture, localized } from './support.mjs';

async function setup(t) {
  const ctx = await fixture(t);
  const tools = collectTools({ rootDir: ctx.root });
  const call = async (name, args) => {
    const result = await tools.find(tool => tool.name === name).execute({ project: 'demo', ...args });
    assert.notEqual(result.ok, false, JSON.stringify(result));
    return result;
  };
  await call('normify_project_init', { root: { id: 'demo', name: localized('演示'), description: localized('测试') } });
  await call('normify_change_open', { id: '2026-10-12-first', title: localized('第一步'), intent: localized('实现'), modules: {},
    acceptance: ['目标验收'], schedule: { phase: 'P0', files: ['src/existing.rs'] } });
  const options = { rootDir: ctx.root, project: 'demo', repoRoot: ctx.repo };
  return { ...ctx, options, call, directory: join(ctx.root, 'normify-demo') };
}

async function contents(root) {
  const files = [];
  async function visit(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path, name + '/');
      else files.push([name, createHash('sha256').update(await readFile(path)).digest('hex')]);
    }
  }
  await visit(root);
  return files.sort((a, b) => a[0].localeCompare(b[0]));
}

test('report freezes deterministic facts without writes, builds, tests or rendering', async t => {
  const { options, repo, directory } = await setup(t);
  const before = { project: await contents(directory), repo: await contents(repo) };
  const first = await collectProgressReport(options);
  const second = await collectProgressReport(options);
  assert.deepEqual(first, second);
  assert.equal(first.consistent, true);
  assert.equal(first.read_only, true);
  assert.equal(first.tasks[0].task_status, 'proposed');
  assert.equal(first.tasks[0].readiness, 'ready');
  assert.equal(first.tasks[0].acceptance.status, 'not_verified');
  assert.deepEqual({ project: await contents(directory), repo: await contents(repo) }, before);
  assert.ok(!first.url && !first.html);
});

test('content fingerprints detect tracked, staged and untracked changes', async t => {
  const { repo, git } = await fixture(t);
  const a = await workspaceSnapshot(repo);
  await writeFile(join(repo, 'src', 'existing.rs'), 'changed\n');
  const b = await workspaceSnapshot(repo);
  assert.notEqual(a.workspace_sha256, b.workspace_sha256);
  git('add', 'src/existing.rs');
  const c = await workspaceSnapshot(repo);
  assert.notEqual(b.workspace_sha256, c.workspace_sha256);
  await writeFile(join(repo, 'new.rs'), 'one\n');
  const d = await workspaceSnapshot(repo);
  await writeFile(join(repo, 'new.rs'), 'two\n');
  assert.notEqual(d.workspace_sha256, (await workspaceSnapshot(repo)).workspace_sha256);
  await assert.rejects(workspaceSnapshot(join(repo, 'src')), /repository root/);
});

test('strict Git snapshots disable fsmonitor and refuse clean command filters', async t => {
  const { repo, git } = await fixture(t);
  git('config', 'core.fsmonitor', 'echo fsmonitor > forbidden-monitor.txt');
  await workspaceSnapshot(repo);
  await assert.rejects(access(join(repo, 'forbidden-monitor.txt')));
  git('config', 'filter.external.clean', 'echo filtered > forbidden-filter.txt');
  await writeFile(join(repo, '.gitattributes'), '* filter=external\n');
  await assert.rejects(workspaceSnapshot(repo), /filters prevent strict read-only/);
  await assert.rejects(access(join(repo, 'forbidden-filter.txt')));
});

test('a mutation during reading prevents a frozen current report', async t => {
  const { options, repo } = await setup(t);
  const report = await collectProgressReport({ ...options,
    afterRead: () => writeFile(join(repo, 'src', 'existing.rs'), 'changed during collection\n') });
  assert.equal(report.consistent, false);
  assert.equal(report.error, 'snapshot/changed-during-read');
});

test('architecture completion never substitutes for physical acceptance', () => {
  const snapshot = { head: 'head', workspace_sha256: 'work' };
  const row = { task_id: 'task', repo_head: 'head', workspace_sha256: 'work', platform: 'windows',
    configuration: 'release', captured_at: '2026-10-12T00:00:00Z', result: 'passed' };
  const failure = { ...row, captured_at: '2026-10-12T00:00:01Z', result: 'failed' };
  const result = summarizeAcceptance([failure, row], 'task', snapshot);
  assert.equal(result.status, 'failure_recorded');
  assert.equal(result.configurations[0].result, 'failed');
  assert.equal(summarizeAcceptance([row], 'task', snapshot).status, 'not_verified');
  assert.equal(summarizeAcceptance([failure], 'task', { head: 'other', workspace_sha256: 'work' }).status, 'not_verified');
  assert.equal(summarizeAcceptance([row, { ...row, result: 'failed' }], 'task', snapshot).status, 'failure_recorded');
});

test('receipt validation rejects partial files and unsafe paths', async t => {
  const { options, repo } = await setup(t);
  const snapshot = await workspaceSnapshot(repo);
  const row = { task_id: '2026-10-12-first', repo_head: snapshot.head, workspace_sha256: snapshot.workspace_sha256,
    platform: 'windows', configuration: 'release', captured_at: '2026-10-12T00:00:00Z', result: 'failed' };
  await writeFile(join(repo, '.gitignore'), 'receipt.json\n');
  await writeFile(join(repo, 'receipt.json'), JSON.stringify({ schema_version: 1, records: [row, {}] }));
  const report = await collectProgressReport({ ...options, evidencePaths: ['receipt.json', '../outside.json'] });
  assert.equal(report.evidence_warnings.length, 3);
  assert.equal(report.tasks[0].acceptance.configurations.length, 0);
});

test('prompt routing suppresses irrelevant, negative and quoted requests', () => {
  for (const prompt of ['修复质量矩阵', '不要汇报开发进度', '不需要打开排程图', '> 当前开发进度如何',
    '```text\n汇报当前进度\n```', '新增只读汇报触发流程', '请解释"打开排程图"的意思',
    '解释当前进度查询如何触发钩子', '我没有让你打开流程图', "don't open mermaid and don't show progress"]) assert.deepEqual(progressIntent(prompt), { report: false, diagram: false }, prompt);
  for (const prompt of ['汇报当前开发进度', '现在项目完成情况如何', '当前项目下一步要做什么', 'report current progress']) {
    assert.equal(progressIntent(prompt).report, true, prompt);
    assert.equal(progressIntent(prompt).diagram, false, prompt);
  }
  assert.deepEqual(progressIntent('汇报进度，不要打开网页'), { report: true, diagram: false });
  assert.deepEqual(progressIntent('汇报进度，不打开排程图'), { report: true, diagram: false });
  assert.equal(progressIntent('别的项目进度怎样').report, true);
  assert.deepEqual(progressIntent('打开完整开发排程图'), { report: false, diagram: true });
});

test('hook collects progress but never renders or opens browsers', async t => {
  const { repo, root } = await fixture(t);
  let calls = 0;
  const report = { consistent: true, tasks: [], normify: { conflicts: [] }, codegraph: {} };
  const collect = async options => { calls++; assert.equal(options.repoRoot, repo); return report; };
  const input = { hook_event_name: 'UserPromptSubmit', cwd: repo, prompt: '汇报当前进度' };
  const result = await progressHook(input, { rootDir: root, collect });
  assert.equal(calls, 1);
  assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(result.hookSpecificOutput.additionalContext, /不要调用渲染或打开网页/);
  await progressHook({ ...input, prompt: '打开完整排程图' }, { rootDir: root, collect });
  assert.equal(calls, 1, 'Diagram-only requests do not run the report collector.');
  assert.equal(await progressHook({ ...input, prompt: '请修复源码' }, { rootDir: root, collect }), null);
  const failed = await progressHook(input, { rootDir: root, collect: async () => { throw new Error('missing project'); } });
  assert.match(failed.hookSpecificOutput.additionalContext, /自动汇总未完成/);
});

test('compact context preserves scope and separately labels omitted tasks', () => {
  const report = { tasks: Array.from({ length: 30 }, (_, i) => ({ id: String(i), readiness: 'blocked' })),
    normify: { conflicts: [] }, codegraph: { files: [] } };
  const compact = compactProgressReport(report);
  assert.equal(compact.tasks.length, 20);
  assert.equal(compact.omitted_tasks, 10);
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
  const huge = { ...report, tasks: report.tasks.map(task => ({ ...task,
    title: { zh: '长'.repeat(10000), en: 'long'.repeat(10000) }, blockers: Array(10000).fill('blocked') })) };
  assert.ok(Buffer.byteLength(JSON.stringify(compactProgressReport(huge))) <= 24 * 1024);
  const noisy = { ...report, normify: { conflicts: Array(200).fill({ left: 'a', right: 'b',
    files: Array(1000).fill('shared-file'), modules: [], resources: [] }),
    warnings: Array(100).fill({ code: 'test/warning', message: 'x'.repeat(10000) }) } };
  const bounded = compactProgressReport(noisy);
  assert.equal(bounded.normify.conflict_count, 200);
  assert.equal(bounded.normify.warning_count, 100);
  assert.ok(bounded.tasks.length > 0, 'Verbose diagnostics must not erase progress evidence.');
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 24 * 1024);
});

test('default receipt collection remains read-only and binds ignored evidence', async t => {
  const { options, repo } = await setup(t);
  await writeFile(join(repo, '.gitignore'), '.normify/\n');
  await mkdir(join(repo, '.normify'));
  const snapshot = await workspaceSnapshot(repo);
  const receipt = join(repo, '.normify', 'progress-evidence.json');
  const row = { task_id: '2026-10-12-first', repo_head: snapshot.head, workspace_sha256: snapshot.workspace_sha256,
    platform: 'windows', configuration: 'release', captured_at: '2026-10-12T00:00:00Z', result: 'failed' };
  await writeFile(receipt, JSON.stringify({ schema_version: 1, records: [row] }));
  const report = await collectProgressReport(options);
  assert.equal(report.tasks[0].acceptance.status, 'failure_recorded');
  assert.equal(report.tasks[0].acceptance.configurations[0].current_snapshot, true);
  const raced = await collectProgressReport({ ...options, afterRead: () => writeFile(receipt, JSON.stringify({ schema_version: 1, records: [] })) });
  assert.equal(raced.consistent, false);
});
