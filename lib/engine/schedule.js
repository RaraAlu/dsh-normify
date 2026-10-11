import { diag } from './diag.js';
import { isValidChangeId, listChangeIds, loadChangeFile } from './changes.js';
import { loadAllModules } from './store.js';
const SCHEDULE_KEYS = ['depends_on', 'phase', 'owner', 'files', 'resources', 'priority'];
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** 路径只代表写入声明；不访问磁盘，不支持 glob。 */
function canonicalPath(value) {
    const path = value.replace(/\\/g, '/');
    if (!path || path !== path.trim() || path.startsWith('/') || /[:*?\[\]{}\x00-\x1f]/.test(path))
        return null;
    const parts = path.replace(/\/$/, '').split('/');
    // 也拒绝 Windows 别名，避免尾点和尾空格绕过互斥。
    if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)))
        return null;
    return parts.join('/').toLowerCase();
}
/** L1 保持 v1 兼容；只有显式 schedule 才进入排程。 */
export function l1ValidateSchedule(value, id) {
    const errors = [];
    const fail = (code, message, evidence = {}) => errors.push(diag('error', code, message, { change: id }, evidence, ['修正 schedule 声明']));
    if (!isPlain(value)) {
        fail('schedule/shape', 'schedule 必须为对象');
        return errors;
    }
    for (const key of Object.keys(value)) {
        if (!SCHEDULE_KEYS.includes(key))
            fail('schedule/unknown-field', '排程不支持字段 ' + key);
    }
    for (const key of ['phase', 'owner']) {
        if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 200))
            fail('schedule/label', key + ' 必须为非空短标签');
    }
    if (value.priority !== undefined && (typeof value.priority !== 'number' || !Number.isInteger(value.priority) || value.priority < 0 || value.priority > 100))
        fail('schedule/priority', 'priority 必须为 0 至 100 的整数');
    for (const key of ['depends_on', 'files', 'resources']) {
        const list = value[key];
        if (list === undefined)
            continue;
        if (!Array.isArray(list) || list.length > 1000 || list.some(x => typeof x !== 'string' || !x.trim() || x.length > 1000)) {
            fail('schedule/list', key + ' 必须为非空字符串数组');
            continue;
        }
        const strings = list;
        if (key === 'depends_on') {
            for (const dep of strings) {
                if (!isValidChangeId(dep))
                    fail('schedule/dependency-id', '前置项必须采用变更 ID', { dependency: dep });
                if (dep === id)
                    fail('schedule/self-dependency', '任务不能依赖自身');
            }
        }
        if (key === 'files') {
            for (const file of strings) {
                if (canonicalPath(file) === null)
                    fail('schedule/file-path', '写入路径必须安全且相对', { path: file });
            }
        }
        const normalized = key === 'files' ? strings.map(s => canonicalPath(s) ?? s) : strings;
        if (new Set(normalized).size !== normalized.length)
            fail('schedule/duplicate', key + ' 含有重复项');
        if (key === 'resources' && strings.some(s => s !== s.trim() || /[\x00-\x1f]/.test(s)))
            fail('schedule/resource', '资源名不能含控制字符或外侧空格');
    }
    return errors;
}
function moduleClaims(change) {
    return [...new Set([
            ...(change.modules.create ?? []), ...(change.modules.modify ?? []), ...(change.modules.delete ?? []),
            ...(change.modules.api_add ?? []).map(a => a.module), ...(change.modules.api_remove ?? []).map(a => a.module),
        ])].sort();
}
const overlap = (a, b, separator = '/') => a === b || a.startsWith(b + separator) || b.startsWith(a + separator);
const open = (t) => t.status === 'proposed' || t.status === 'in_progress';
function pairConflict(a, b) {
    const modules = new Set();
    const files = new Set();
    for (const x of a.modules)
        for (const y of b.modules)
            if (overlap(x, y, '.'))
                modules.add(x.length <= y.length ? x : y);
    for (const x of a.files)
        for (const y of b.files)
            if (overlap(x, y))
                files.add(x.length <= y.length ? x : y);
    const resources = a.resources.filter(r => b.resources.includes(r));
    if (!modules.size && !files.size && !resources.length)
        return null;
    return { left: a.id, right: b.id, modules: [...modules].sort(), files: [...files].sort(), resources: resources.sort() };
}
/** 不从架构箭头推导开发顺序。不为未登记任务承诺并行安全。 */
export function buildSchedule(changes, byId) {
    const errors = [];
    const warnings = [];
    const hasSchedule = changes.some(c => c.schedule !== undefined);
    const fail = (code, message, id, evidence = {}) => errors.push(diag('error', code, message, { change: id }, evidence, ['修正任务前置或写入范围']));
    const seen = new Set();
    const tasks = changes.map(change => {
        if (seen.has(change.id))
            fail('schedule/duplicate-id', '任务 ID 重复', change.id);
        seen.add(change.id);
        const valid = change.schedule === undefined ? [] : l1ValidateSchedule(change.schedule, change.id);
        errors.push(...valid);
        const schedule = valid.length ? {} : (change.schedule ?? {});
        const modules = moduleClaims(change);
        if (change.schedule !== undefined && byId !== undefined && (change.status === 'proposed' || change.status === 'in_progress')) {
            for (const id of modules)
                if (!byId.has(id))
                    fail('schedule/module-missing', '写入模块不存在', change.id, { module: id });
        }
        const files = new Set((schedule.files ?? []).map(f => canonicalPath(f)).filter((f) => f !== null));
        // 父模块声明也覆盖子模块源码；同文件的不同模块仍需互斥。
        for (const [id, file] of byId ?? []) {
            if (!modules.some(m => id === m || id.startsWith(m + '.')))
                continue;
            for (const source of file.module.source) {
                const path = canonicalPath(source.path);
                if (path !== null)
                    files.add(path);
                else if (hasSchedule)
                    warnings.push(diag('warning', 'schedule/source-path', '源码路径不能用于写入互斥', { change: change.id, module: id }, { path: source.path }, ['显式补充 schedule.files']));
            }
        }
        return {
            id: change.id, title: change.title, status: change.status,
            ...(schedule.phase !== undefined ? { phase: schedule.phase } : {}),
            ...(schedule.owner !== undefined ? { owner: schedule.owner } : {}),
            depends_on: [...(schedule.depends_on ?? [])], modules, files: [...files].sort(),
            resources: [...(schedule.resources ?? [])].sort(), priority: schedule.priority ?? 50,
            readiness: change.schedule === undefined ? 'unscheduled' : 'blocked', blockers: [],
        };
    });
    tasks.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id, 'en'));
    const scheduled = new Set(changes.filter(c => c.schedule !== undefined).map(c => c.id));
    const taskById = new Map(tasks.map(t => [t.id, t]));
    // Kahn 检测保留显式边，已关闭任务也不得隐藏结构环。
    const indegrees = new Map(tasks.map(t => [t.id, 0]));
    const children = new Map(tasks.map(t => [t.id, []]));
    for (const task of tasks) {
        for (const dep of task.depends_on) {
            if (!taskById.has(dep))
                fail('schedule/dependency-missing', '前置任务不存在', task.id, { dependency: dep });
            else {
                indegrees.set(task.id, (indegrees.get(task.id) ?? 0) + 1);
                children.get(dep).push(task.id);
            }
        }
    }
    const queue = tasks.filter(t => indegrees.get(t.id) === 0).map(t => t.id);
    for (let i = 0; i < queue.length; i++) {
        for (const child of children.get(queue[i]) ?? []) {
            const remaining = indegrees.get(child) - 1;
            indegrees.set(child, remaining);
            if (remaining === 0)
                queue.push(child);
        }
    }
    const cycle = tasks.filter(t => (indegrees.get(t.id) ?? 0) > 0).map(t => t.id);
    if (cycle.length)
        fail('schedule/cycle', '任务前置图含环或受环阻塞', cycle[0], { tasks: cycle });
    const conflicts = [];
    for (let i = 0; i < tasks.length; i++)
        for (let j = i + 1; j < tasks.length; j++) {
            const a = tasks[i], b = tasks[j];
            if (!open(a) || !open(b) || (!scheduled.has(a.id) && !scheduled.has(b.id)))
                continue;
            const conflict = pairConflict(a, b);
            if (conflict === null)
                continue;
            conflicts.push(conflict);
            if (a.status === 'in_progress' && b.status === 'in_progress')
                fail('schedule/running-conflict', '运行任务争用写入范围或资源', a.id, { conflict });
        }
    for (const task of tasks) {
        if (scheduled.has(task.id) && open(task)) {
            for (const dep of task.depends_on) {
                if (taskById.get(dep)?.status !== 'verified')
                    task.blockers.push('dependency:' + dep);
            }
            for (const other of tasks) {
                if (other.id !== task.id && other.status === 'in_progress' && pairConflict(task, other))
                    task.blockers.push('conflict:' + other.id);
            }
            if (task.status === 'in_progress' && task.depends_on.some(dep => taskById.get(dep)?.status !== 'verified'))
                fail('schedule/prerequisite', '启动任务须先验收全部前置', task.id, { dependencies: task.depends_on.filter(dep => taskById.get(dep)?.status !== 'verified') });
        }
        if (task.status === 'verified' || task.status === 'abandoned')
            task.readiness = task.status;
        else if (!scheduled.has(task.id))
            task.readiness = 'unscheduled';
        else if (task.status === 'in_progress')
            task.readiness = 'in_progress';
        else
            task.readiness = task.blockers.length ? 'blocked' : 'ready';
    }
    if (errors.length) {
        for (const task of tasks)
            if (scheduled.has(task.id) && task.status === 'proposed') {
                task.readiness = 'blocked';
                task.blockers.push('invalid-plan');
            }
    }
    const waves = [];
    if (!errors.length) {
        const done = new Set(tasks.filter(t => t.status === 'verified').map(t => t.id));
        const running = tasks.filter(t => t.status === 'in_progress' && scheduled.has(t.id));
        const unknownRunning = tasks.filter(t => t.status === 'in_progress' && !scheduled.has(t.id));
        if (running.length) {
            waves.push(running.map(t => t.id));
            running.forEach(t => done.add(t.id));
        }
        const pending = tasks.filter(t => scheduled.has(t.id) && t.status === 'proposed');
        while (pending.length) {
            const wave = [];
            for (const task of pending) {
                if (task.depends_on.every(dep => done.has(dep))
                    && !unknownRunning.some(t => pairConflict(task, t))
                    && !wave.some(t => pairConflict(task, t)))
                    wave.push(task);
            }
            if (!wave.length)
                break;
            waves.push(wave.map(t => t.id));
            for (const task of wave) {
                done.add(task.id);
                pending.splice(pending.indexOf(task), 1);
            }
        }
    }
    const plan = {
        schema_version: 1, ok: errors.length === 0, tasks,
        ready: tasks.filter(t => t.readiness === 'ready').map(t => t.id),
        running: tasks.filter(t => t.status === 'in_progress').map(t => t.id),
        blocked: tasks.filter(t => t.readiness === 'blocked').map(t => t.id),
        unscheduled: tasks.filter(t => !scheduled.has(t.id) && open(t)).map(t => t.id),
        completed: tasks.filter(t => t.status === 'verified').map(t => t.id),
        waves, conflicts, errors, warnings, mermaid: '',
    };
    plan.mermaid = mermaidOf(plan);
    return plan;
}
async function readScheduleInputs(projectDir) {
    let loaded;
    try {
        loaded = await loadAllModules(projectDir, true);
    }
    catch (error) {
        loaded = { files: [], warnings: [], errors: [diag('error', 'schedule/modules-unreadable', '不能列出写入模块', {}, { reason: String(error) }, ['检查目录与权限'])] };
    }
    const changes = [];
    const errors = [...loaded.errors];
    let ids = [];
    try {
        ids = await listChangeIds(projectDir, true);
    }
    catch (error) {
        errors.push(diag('error', 'schedule/changes-unreadable', '不能列出任务文件', {}, { reason: String(error) }, ['检查目录与权限']));
    }
    for (const id of ids) {
        const result = await loadChangeFile(projectDir, id);
        if (result.error)
            errors.push(result.error);
        else if (result.change)
            changes.push(result.change);
        else
            errors.push(diag('error', 'schedule/change-unreadable', '不能读取任务文件', { change: id }, {}, ['检查文件权限']));
    }
    return { changes, byId: new Map(loaded.files.map(f => [f.module.id, f])), errors, warnings: loaded.warnings };
}
function withLoadDiagnostics(plan, errors, warnings) {
    plan.errors.unshift(...errors);
    plan.warnings.unshift(...warnings);
    plan.ok = plan.errors.length === 0;
    if (!plan.ok) {
        plan.ready = [];
        plan.waves = [];
        for (const task of plan.tasks)
            if (task.readiness === 'ready') {
                task.readiness = 'blocked';
                task.blockers.push('invalid-plan');
                plan.blocked.push(task.id);
            }
        plan.mermaid = mermaidOf(plan);
    }
    return plan;
}
export async function loadSchedulePlan(projectDir) {
    const input = await readScheduleInputs(projectDir);
    return withLoadDiagnostics(buildSchedule(input.changes, input.byId), input.errors, input.warnings);
}
/** 在持久化前检查候选；MCP 负责目录锁，直接调用者须自行串行化。 */
export async function checkScheduledChange(projectDir, candidate) {
    const input = await readScheduleInputs(projectDir);
    const current = input.changes.find(c => c.id === candidate.id);
    const changes = input.changes.filter(c => c.id !== candidate.id).concat(candidate);
    if (!changes.some(c => c.schedule !== undefined))
        return [];
    const errors = [...input.errors];
    const reject = (code, message) => errors.push(diag('error', code, message, { change: candidate.id }, {}, ['先明确终止任务，另建变更']));
    if (current?.schedule !== undefined) {
        if (candidate.schedule === undefined)
            reject('schedule/remove', '排程任务不能移除排程');
        if (current.status === 'verified' || current.status === 'abandoned')
            reject('schedule/terminal', '终态排程任务不能更新');
        if (current.status === 'in_progress') {
            if (candidate.status === 'proposed')
                reject('schedule/rollback', '运行任务不能退回候选态');
            const normalize = (items = [], paths = false) => JSON.stringify([...items].map(s => paths ? canonicalPath(s) ?? s : s).sort());
            if (normalize(moduleClaims(current)) !== normalize(moduleClaims(candidate))
                || normalize(current.schedule.depends_on) !== normalize(candidate.schedule?.depends_on)
                || normalize(current.schedule.files, true) !== normalize(candidate.schedule?.files, true)
                || normalize(current.schedule.resources) !== normalize(candidate.schedule?.resources))
                reject('schedule/running-claims', '运行时不能改写占用声明');
        }
    }
    return [...errors, ...buildSchedule(changes, input.byId).errors];
}
function mermaidLabel(text) {
    return text.replace(/[&<>"`\r\n]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '`': '&#96;', '\r': ' ', '\n': ' ' }[ch]));
}
function mermaidOf(plan) {
    const ids = new Map(plan.tasks.map((t, i) => [t.id, 'task_' + i]));
    const lines = ['flowchart TD'];
    for (const task of plan.tasks)
        lines.push('  ' + ids.get(task.id) + '["' + mermaidLabel(task.id + ' | ' + task.title.zh + ' | ' + task.readiness) + '"]');
    for (const task of plan.tasks)
        for (const dep of task.depends_on)
            if (ids.has(dep))
                lines.push('  ' + ids.get(dep) + ' --> ' + ids.get(task.id));
    return lines.join('\n') + '\n';
}
const cell = (value) => value.replace(/[|`<>\\\r\n]/g, ch => ({ '|': '&#124;', '`': '&#96;', '<': '&lt;', '>': '&gt;', '\\': '&#92;', '\r': ' ', '\n': ' ' }[ch]));
export function renderScheduleMarkdown(plan) {
    const lines = ['# 开发排程', '', '前置仅认可 verified。', '波次只预测候选顺序。', '实际启动须重新检查。', '未登记任务不承诺安全。', '阶段与负责人仅作标签。', '',
        '| 任务 | 标题 | 状态 | 就绪 | 前置 | 阶段 | 负责人 | 写入模块 | 写入路径 | 独占资源 | 阻塞 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
    for (const task of plan.tasks)
        lines.push('| ' + [task.id, task.title.zh, task.status, task.readiness, task.depends_on.join(', '), task.phase ?? '', task.owner ?? '', task.modules.join(', '), task.files.join(', '), task.resources.join(', '), task.blockers.join(', ')].map(cell).join(' | ') + ' |');
    lines.push('', '## 候选波次', '');
    plan.waves.forEach((wave, index) => lines.push('- ' + (index + 1) + ': ' + wave.map(cell).join(', ')));
    lines.push('', '## 并行冲突', '');
    for (const conflict of plan.conflicts)
        lines.push('- ' + cell(conflict.left) + ' / ' + cell(conflict.right) + ': ' + cell([...conflict.modules, ...conflict.files, ...conflict.resources].join(', ')));
    lines.push('', '## 诊断', '');
    for (const d of [...plan.errors, ...plan.warnings])
        lines.push('- ' + cell(d.code + ': ' + d.message));
    lines.push('', '## 开发流程图', '', '```mermaid', plan.mermaid.trimEnd(), '```', '');
    return lines.join('\n');
}
//# sourceMappingURL=schedule.js.map