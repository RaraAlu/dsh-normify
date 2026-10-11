import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { collectTools } from './catalog.mjs';
import { readCodegraphEvidence } from './progress-codegraph.mjs';

export const reportRulesVersion = 1;
const digest = value => createHash('sha256').update(value).digest('hex');
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort(order)
    .filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function git(repoRoot, args, input) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', repoRoot, ...args], { windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 5000, maxBuffer: 32 * 1024 * 1024,
    input, stdio: ['pipe', 'pipe', 'pipe'] });
}

export async function workspaceSnapshot(repoRoot) {
  const root = await realpath(repoRoot);
  let filterKeys = '';
  try {
    filterKeys = git(root, ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$']).toString();
  } catch (error) {
    // 无匹配项时Git返回1；其他错误必须停止。
    if (error.status !== 1) throw error;
  }
  if (filterKeys.trim()) {
    const drivers = new Set(filterKeys.trim().split('\n').map(key => key.replace(/^filter\./, '').replace(/\.(clean|process)$/, '')));
    const tracked = git(root, ['ls-files', '-z', '--cached']);
    const attributes = git(root, ['check-attr', '-z', '--stdin', 'filter'], tracked).toString().split('\0');
    for (let i = 0; i + 2 < attributes.length; i += 3) {
      if (drivers.has(attributes[i + 2])) throw new Error('Repository filters prevent strict read-only snapshots.');
    }
  }
  if (await realpath(git(root, ['rev-parse', '--show-toplevel']).toString().trim()) !== root) {
    throw new Error('Pass the repository root, not a subdirectory.');
  }
  const head = git(root, ['rev-parse', 'HEAD']).toString().trim();
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const diff = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']);
  const index = git(root, ['ls-files', '--stage', '-z']);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean).sort(order);
  const hash = createHash('sha256');
  for (const value of [head, status, diff, index]) hash.update(value).update('\0');
  for (const file of untracked) {
    const path = join(root, file);
    await safeFile(root, path, true);
    const info = await lstat(path);
    hash.update(file).update('\0').update(info.isSymbolicLink() ? await readlink(path) : await readFile(path)).update('\0');
  }
  return { head, workspace_sha256: hash.digest('hex'), dirty: status.length > 0,
    changed_entries: status.toString().split('\0').filter(Boolean) };
}

async function safeFile(root, path, allowFinalLink = false) {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Unsafe evidence path.');
  const parts = rel.split(sep);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() && !(allowFinalLink && i === parts.length - 1)) throw new Error('Refusing linked evidence.');
  }
}

export async function normifySnapshot(projectDir) {
  const root = await realpath(projectDir);
  const entries = [];
  async function visit(path, name) {
    let info;
    try { info = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') { entries.push([name, null]); return; } throw error; }
    if (info.isSymbolicLink()) throw new Error('Refusing linked Normify inputs.');
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort(order)) await visit(join(path, entry), name + '/' + entry);
    } else if (info.isFile()) entries.push([name, digest(await readFile(path))]);
    else throw new Error('Unsupported Normify input.');
  }
  for (const name of ['modules', 'changes', 'renders', 'policy.yml']) await visit(join(root, name), name);
  return digest(stableJson(entries));
}

// 凭据只表达已有记录。汇报器不执行验收，也不升级任务状态。
export function summarizeAcceptance(records, taskId, snapshot) {
  const relevant = records.filter(row => row.task_id === taskId);
  const latest = new Map();
  for (const row of relevant) {
    const key = stableJson([row.platform, row.configuration]);
    const old = latest.get(key);
    if (!old || Date.parse(row.captured_at) > Date.parse(old.captured_at) ||
      (Date.parse(row.captured_at) === Date.parse(old.captured_at) && row.result === 'failed')) latest.set(key, row);
  }
  const configurations = [...latest.values()].sort((a, b) => order(stableJson(a), stableJson(b))).map(row => ({
    ...row, current_snapshot: row.repo_head === snapshot.head && row.workspace_sha256 === snapshot.workspace_sha256,
  }));
  return { status: configurations.some(row => row.current_snapshot && row.result === 'failed')
    ? 'failure_recorded' : 'not_verified', configurations,
    reason: '只汇总凭据；不证明全配置覆盖。' };
}

async function readAcceptance(repoRoot, paths) {
  const records = [];
  const inputs = [];
  const warnings = [];
  for (const name of [...new Set(paths)].sort(order)) {
    try {
      if (isAbsolute(name)) throw new Error('Use repository-relative receipt paths.');
      const path = resolve(repoRoot, name);
      await safeFile(repoRoot, path);
      const bytes = await readFile(path);
      if (bytes.length > 1024 * 1024) throw new Error('Receipt exceeds 1 MiB.');
      inputs.push({ path: name, sha256: digest(bytes) });
      const data = JSON.parse(bytes);
      if (data.schema_version !== 1 || !Array.isArray(data.records)) throw new Error('Unsupported receipt schema.');
      const accepted = [];
      for (const row of data.records) {
        if (!row || !['task_id', 'repo_head', 'workspace_sha256', 'platform', 'configuration', 'captured_at'].every(key =>
          typeof row[key] === 'string' && row[key].trim()) || !['passed', 'failed', 'not_run'].includes(row.result) ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row.captured_at) || Number.isNaN(Date.parse(row.captured_at))) {
          throw new Error('Invalid receipt record.');
        }
        accepted.push(Object.fromEntries(['task_id', 'repo_head', 'workspace_sha256', 'platform', 'configuration', 'captured_at', 'result']
          .map(key => [key, row[key]]).concat([['receipt', name], ['receipt_sha256', digest(bytes)]])));
      }
      records.push(...accepted);
    } catch (error) { warnings.push({ path: name, reason: error.message }); }
  }
  return { records, inputs, warnings };
}

export async function collectProgressReport({ rootDir, project, dir, repoRoot, evidencePaths = [], afterRead }) {
  if (!isAbsolute(repoRoot) || !isAbsolute(rootDir)) throw new Error('Pass absolute repository and storage roots.');
  repoRoot = await realpath(repoRoot);
  // 默认只查一个约定文件，不扫描验收文档。
  evidencePaths = [...new Set(['.normify/progress-evidence.json', ...evidencePaths])];
  const tools = collectTools({ rootDir, readOnly: true });
  const read = async (name, args) => {
    const tool = tools.find(tool => tool.name === name);
    if (!tool?.readOnly || !tool.validate(args)) throw new Error('Invalid read-only tool request: ' + name);
    const result = await tool.execute(args);
    if (result.ok === false) throw new Error('Normify read failed: ' + name);
    return result;
  };
  const selector = dir ? { dir } : { project: project ?? basename(repoRoot) };
  const projectDir = dir ? resolve(dir) : join(rootDir, 'normify-' + selector.project);
  if (!basename(projectDir).startsWith('normify-') || (!dir && !/^[a-z0-9][a-z0-9-]*$/.test(selector.project))) {
    throw new Error('Invalid Normify project.');
  }
  const before = await workspaceSnapshot(repoRoot);
  const normifyBefore = await normifySnapshot(projectDir);
  const brief = await read('normify_brief', { ...selector, include_schedule: true });
  const plan = brief.schedule;
  if (!plan || !Array.isArray(plan.tasks)) throw new Error('Normify schedule is unavailable.');
  const graphTasks = plan.tasks.filter(task => ['in_progress', 'ready'].includes(task.readiness));
  const graphPaths = [...new Set(graphTasks.flatMap(task => task.files))].sort(order);
  const graph = await readCodegraphEvidence(repoRoot, graphPaths);
  const acceptance = await readAcceptance(repoRoot, evidencePaths);
  await afterRead?.();
  const graphAfter = await readCodegraphEvidence(repoRoot, graphPaths);
  const evidenceAfter = await readAcceptance(repoRoot, evidencePaths);
  const after = await workspaceSnapshot(repoRoot);
  const normifyAfter = await normifySnapshot(projectDir);
  const stable = stableJson(before) === stableJson(after) && normifyBefore === normifyAfter
    && stableJson(graph) === stableJson(graphAfter) && stableJson(acceptance) === stableJson(evidenceAfter);
  const tasks = plan.tasks.map(task => ({ id: task.id, title: task.title, phase: task.phase,
    task_status: task.status, readiness: task.readiness, blockers: [...task.blockers].sort(order),
    depends_on: [...task.depends_on].sort(order), files: task.files,
    source_status: graphTasks.some(selected => selected.id === task.id) ? 'scoped_evidence' : 'not_queried',
    source_evidence: graph.files?.filter(file => task.files.some(path => file.path === path || file.path.startsWith(path.replace(/\/$/, '') + '/'))) ?? [],
    acceptance: summarizeAcceptance(acceptance.records, task.id, before),
  })).sort((a, b) => {
    const phase = value => /^P\d+\b/.test(value ?? '') ? Number(value.match(/^P(\d+)/)[1]) : Number.MAX_SAFE_INTEGER;
    return phase(a.phase) - phase(b.phase) || order(a.phase ?? '', b.phase ?? '') || order(a.id, b.id);
  });
  const phaseSummary = [];
  for (const phase of [...new Set(tasks.map(task => task.phase).filter(Boolean))]) {
    const rows = tasks.filter(task => task.phase === phase);
    const counts = {};
    for (const row of rows) counts[row.task_status] = (counts[row.task_status] ?? 0) + 1;
    phaseSummary.push({ phase, registered_tasks: rows.length, task_states: counts });
  }
  const facts = { schema_version: 1, rules_version: reportRulesVersion, read_only: true,
    project: basename(projectDir).slice(8), repository: repoRoot, consistent: stable,
    snapshot: { ...before, normify_sha256: normifyBefore },
    normify: { ok: plan.ok, errors: plan.errors, warnings: plan.warnings, policy: brief.policy,
      ready: plan.ready, running: plan.running, blocked: plan.blocked, unscheduled: plan.unscheduled,
      completed: plan.completed, conflicts: plan.conflicts },
    codegraph: { ...graph, task_scope: graphTasks.map(task => task.id).sort(order) },
    evidence_inputs: acceptance.inputs, evidence_warnings: acceptance.warnings, tasks,
    phase_summary: phaseSummary, unphased_records_count: tasks.filter(task => !task.phase).length,
    boundaries: ['任务verified只表示架构收尾。', '源码符号不证明产品验收。', '历史凭据不证明当前快照。',
      '缺少凭据时报告未验收。', '汇报不运行测试或打开网页。'],
  };
  return { ...facts, snapshot_id: digest(stableJson(facts)),
    ...(stable ? {} : { error: 'snapshot/changed-during-read' }) };
}

export function compactProgressReport(report, limit = 20) {
  const rank = task => ({ in_progress: 0, ready: 1, blocked: 2, unscheduled: 3, verified: 4, abandoned: 5 }[task.readiness] ?? 6);
  const tasks = [...report.tasks].sort((a, b) => rank(a) - rank(b) || order(a.id, b.id));
  const diagnostics = rows => (rows ?? []).slice(0, 3).map(row => ({ code: row.code,
    message: String(row.message ?? row.reason ?? '').slice(0, 200), path: row.path }));
  const compact = { schema_version: report.schema_version, rules_version: report.rules_version,
    snapshot_id: report.snapshot_id, consistent: report.consistent, read_only: report.read_only,
    project: report.project, repository: report.repository, error: report.error,
    snapshot: report.snapshot ? { ...report.snapshot,
      changed_entry_count: report.snapshot.changed_entries?.length,
      changed_entries: report.snapshot.changed_entries?.slice(0, limit) } : undefined,
    phase_summary: report.phase_summary, unphased_records_count: report.unphased_records_count,
    boundaries: report.boundaries,
    tasks: tasks.slice(0, limit).map(task => ({ id: task.id, phase: task.phase,
      task_status: task.task_status, readiness: task.readiness, source_status: task.source_status,
      blockers: task.blockers?.slice(0, 8), omitted_blockers: Math.max(0, (task.blockers?.length ?? 0) - 8),
      depends_on: task.depends_on?.slice(0, 8), omitted_dependencies: Math.max(0, (task.depends_on?.length ?? 0) - 8),
      files: task.files?.slice(0, 4), omitted_files: Math.max(0, (task.files?.length ?? 0) - 4),
    title: task.title ? { zh: task.title.zh.slice(0, 80), en: task.title.en.slice(0, 80) } : undefined,
    source_evidence: task.source_evidence?.slice(0, 2).map(file => ({ path: file.path, freshness: file.freshness,
      indexed_hash: file.indexed_hash, raw_sha256: file.raw_sha256,
      symbols: file.symbols?.slice(0, 2).map(symbol => ({ name: symbol.name?.slice(0, 120), kind: symbol.kind,
        start_line: symbol.start_line, end_line: symbol.end_line })),
      omitted_symbols: Math.max(0, (file.symbols?.length ?? 0) - 2) })),
    omitted_source_files: Math.max(0, (task.source_evidence?.length ?? 0) - 2),
    acceptance: task.acceptance ? { status: task.acceptance.status,
      configurations: task.acceptance.configurations.slice(0, 4),
      omitted_configurations: Math.max(0, task.acceptance.configurations.length - 4) } : undefined,
  })), omitted_tasks: Math.max(0, tasks.length - limit),
    codegraph: { available: report.codegraph.available, index: report.codegraph.index,
      diagnostics: diagnostics(report.codegraph.diagnostics), task_scope: report.codegraph.task_scope },
    normify: { ok: report.normify.ok, policy: { exists: report.normify.policy?.exists,
      rule_count: report.normify.policy?.rule_count },
      error_count: report.normify.errors?.length, warning_count: report.normify.warnings?.length,
      errors: diagnostics(report.normify.errors), warnings: diagnostics(report.normify.warnings),
      conflict_count: report.normify.conflicts.length,
      conflicts: report.normify.conflicts.slice(0, 5).map(row => ({ left: row.left, right: row.right,
        module_count: row.modules?.length, file_count: row.files?.length, resource_count: row.resources?.length })) },
    evidence_inputs: report.evidence_inputs?.slice(0, 8),
    evidence_warnings: diagnostics(report.evidence_warnings),
  };
  // 钩子保持有限上下文。完整快照仍由独立命令返回。
  for (const key of ['ready', 'running', 'blocked', 'unscheduled', 'completed']) {
    if (Array.isArray(report.normify[key])) {
      compact.normify[key + '_count'] = report.normify[key].length;
      compact.normify[key] = report.normify[key].slice(0, limit);
    }
  }
  while (Buffer.byteLength(JSON.stringify(compact)) > 24 * 1024 && compact.tasks.length) {
    compact.tasks.pop(); compact.omitted_tasks++;
  }
  if (Buffer.byteLength(JSON.stringify(compact)) > 24 * 1024) return {
    schema_version: report.schema_version, rules_version: report.rules_version, snapshot_id: report.snapshot_id,
    consistent: report.consistent, read_only: true, tasks: [], omitted_tasks: tasks.length,
    context_limited: true, error: 'report/context-limit',
  };
  return compact;
}
