import type { SchedulePlan } from './schedule.js';
import type { RenderSummary } from './template.js';

type Language = 'zh' | 'en';
type Task = SchedulePlan['tasks'][number];

function escape(value: unknown): string {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function lines(value: unknown): string[] {
    return Array.isArray(value) ? value.map(item => String(item)) : [];
}

function taskTitle(task: Task, lang: Language): string {
    return task.title[lang] || task.title.zh;
}

function words(zh: string, en: string, lang: Language): string {
    return lang === 'zh' ? zh : en;
}

function list(values: unknown): string {
    const entries = lines(values);
    return entries.length ? '<ul>' + entries.map(value => '<li>' + escape(value) + '</li>').join('') + '</ul>'
        : '<p class="muted">—</p>';
}

function titleLines(title: string, limit: number): string[] {
    const rows = [''];
    let width = 0;
    for (const char of title) {
        const charWidth = (char.codePointAt(0) ?? 0) > 0x2e80 ? 14 : 8;
        if (width + charWidth > limit) {
            if (rows.length === 2) {
                rows[1] = rows[1].slice(0, -1) + '…';
                break;
            }
            rows.push('');
            width = 0;
        }
        rows[rows.length - 1] += char;
        width += charWidth;
    }
    return rows;
}

/** 主线只投影真实可达边。阶段编号不产生前置。 */
function overviewPlan(plan: SchedulePlan): SchedulePlan {
    const selected = plan.tasks.filter(task => {
        if (!task.phase) return false;
        const prefix = task.title.zh.slice(0, task.phase.length);
        const suffix = task.title.zh.slice(task.phase.length);
        return prefix === task.phase && /^(?:-(?:CONTRACT|HOST|BASE|UPLOAD|ENTRY))?(?:\s|$)/i.test(suffix);
    });
    const tasks = selected.length > 1 ? selected : plan.tasks.length <= 12 ? plan.tasks : selected;
    const byId = new Map(plan.tasks.map(task => [task.id, task]));
    const ancestors = new Map<string, Set<string>>();
    for (const task of tasks) {
        const found = new Set<string>();
        const visit = (id: string): void => {
            if (found.has(id)) return;
            found.add(id);
            byId.get(id)?.depends_on.forEach(visit);
        };
        task.depends_on.forEach(visit);
        ancestors.set(task.id, found);
    }
    return { ...plan, tasks: tasks.map(task => {
        const predecessors = tasks.filter(other => ancestors.get(task.id)?.has(other.id));
        return { ...task, depends_on: predecessors.filter(predecessor => !predecessors.some(other =>
            other.id !== predecessor.id && ancestors.get(other.id)?.has(predecessor.id))).map(other => other.id) };
    }) };
}

function stagePlan(plan: SchedulePlan, phase: string): { plan: SchedulePlan; external: Set<string> } {
    const members = plan.tasks.filter(task => task.phase === phase);
    const ids = new Set(members.map(task => task.id));
    const external = new Set(members.flatMap(task => task.depends_on).filter(id => !ids.has(id)));
    const tasks = plan.tasks.filter(task => ids.has(task.id) || external.has(task.id));
    const included = new Set(tasks.map(task => task.id));
    return { plan: { ...plan, tasks: tasks.map(task => ({ ...task,
        depends_on: task.depends_on.filter(id => included.has(id)) })) }, external };
}

/** 历史占用只补冲突端点。开关不得移除任何真实前置。 */
function withHistory(value: SchedulePlan, source: SchedulePlan): {
    plan: SchedulePlan; historyOnly: Set<string>; legacy: Set<string>;
} {
    const included = new Set(value.tasks.map(task => task.id));
    const unscheduled = new Set(source.unscheduled);
    const legacy = new Set(source.running.filter(id => unscheduled.has(id)));
    const historyOnly = new Set<string>();
    for (const conflict of source.conflicts) {
        if (included.has(conflict.left) && legacy.has(conflict.right) && !included.has(conflict.right))
            historyOnly.add(conflict.right);
        if (included.has(conflict.right) && legacy.has(conflict.left) && !included.has(conflict.left))
            historyOnly.add(conflict.left);
    }
    const tasks = [...value.tasks, ...source.tasks.filter(task => historyOnly.has(task.id))];
    const all = new Set(tasks.map(task => task.id));
    return { plan: { ...value, tasks: tasks.map(task => ({ ...task,
        depends_on: task.depends_on.filter(id => all.has(id)) })) }, historyOnly, legacy };
}

function shortTitle(task: Task, lang: Language): string {
    if (lang === 'en') return taskTitle(task, lang);
    return taskTitle(task, lang).replace(/-(?:CONTRACT|HOST|BASE|UPLOAD|ENTRY)/g, ' ')
        .replace(/阶段切片|全量矩阵与|全部61族|全量|与门槛|与资产/g, '').replace(/准入$/, '').trim();
}

/** 实线仅用显式前置；主线用真实依赖路径的传递约简。 */
function diagram(value: SchedulePlan, source: SchedulePlan, lang: Language, key: string,
    external = new Set<string>()): string {
    if (!source.ok) return '<p class="graph-message">' + words('排程含错误。请先修复。',
        'Schedule errors prevent a valid dependency graph.', lang) + '</p>';
    if (!value.tasks.length) return '<p class="graph-message">' + words('尚无可识别门禁。请看完整依赖。',
        'No recognizable gates. Open all dependencies.', lang) + '</p>';
    const { plan, historyOnly, legacy } = withHistory(value, source);
    const core = plan.tasks.filter(task => !historyOnly.has(task.id));
    const byId = new Map(core.map(task => [task.id, task]));
    const ranks = new Map<string, number>();
    const visiting = new Set<string>();
    const rank = (id: string): number => {
        const hit = ranks.get(id);
        if (hit !== undefined) return hit;
        if (visiting.has(id)) return 0;
        visiting.add(id);
        let value = 0;
        for (const predecessor of byId.get(id)?.depends_on ?? []) {
            if (byId.has(predecessor)) value = Math.max(value, rank(predecessor) + 1);
        }
        visiting.delete(id);
        ranks.set(id, value);
        return value;
    };
    core.forEach(task => rank(task.id));
    const rows = new Map<number, Task[]>();
    for (const task of core) {
        const level = ranks.get(task.id) ?? 0;
        rows.set(level, [...(rows.get(level) ?? []), task]);
    }
    const compact = key === 'overview';
    const nodeWidth = compact ? 154 : 286;
    const nodeHeight = compact ? 76 : 126;
    const xStep = compact ? 184 : 350;
    const yStep = compact ? 102 : 162;
    const maxLevel = Math.max(...rows.keys());
    const maxMembers = Math.max(...[...rows.values()].map(members => members.length));
    const baseWidth = Math.max(compact ? 360 : 720, 48 + (maxMembers - 1) * xStep + nodeWidth);
    const baseHeight = 48 + maxLevel * yStep + nodeHeight;
    const positions = new Map<string, { x: number; y: number }>();
    // 层级只跟随真实前置。同层横排不授予并行许可。
    for (const [level, members] of rows) {
        const rowWidth = (members.length - 1) * xStep + nodeWidth;
        const startX = (baseWidth - rowWidth) / 2;
        members.forEach((task, index) => positions.set(task.id,
            { x: startX + index * xStep, y: 24 + level * yStep }));
    }
    const added = plan.tasks.filter(task => historyOnly.has(task.id));
    added.forEach((task, index) => positions.set(task.id, { x: 24 + index * xStep, y: baseHeight + 24 }));
    const width = Math.max(baseWidth, added.length ? 48 + (added.length - 1) * xStep + nodeWidth : 0);
    const height = baseHeight + (added.length ? nodeHeight + 48 : 0);
    const edges: string[] = [];
    for (const task of plan.tasks) {
        const to = positions.get(task.id)!;
        for (const predecessor of task.depends_on) {
            const from = positions.get(predecessor);
            if (!from) continue;
            const x1 = from.x + nodeWidth / 2, x2 = to.x + nodeWidth / 2;
            const y1 = from.y + nodeHeight, y2 = to.y;
            const bend = Math.max(18, Math.min(48, (y2 - y1) / 2));
            const path = 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + bend) + ', '
                + x2 + ' ' + (y2 - bend) + ', ' + x2 + ' ' + y2;
            edges.push('<path class="prerequisite" data-from="' + escape(predecessor) + '" data-to="'
                + escape(task.id) + '" marker-end="url(#arrow-' + key + '-' + lang + ')" d="' + path
                + '"><title>' + escape(predecessor + ' → ' + task.id) + '</title></path>');
        }
    }
    for (const conflict of source.conflicts) {
        const from = positions.get(conflict.left), to = positions.get(conflict.right);
        if (!from || !to) continue;
        // 路径和资源清单只在详情保存，避免各视图反复展开。
        edges.push('<path class="conflict-edge' + (legacy.has(conflict.left) || legacy.has(conflict.right)
            ? ' history-conflict' : '') + '" data-left="' + escape(conflict.left) + '" data-right="'
            + escape(conflict.right) + '" d="M ' + (from.x + nodeWidth / 2) + ' ' + (from.y + nodeHeight)
            + ' Q ' + (Math.max(from.x, to.x) + nodeWidth + 18) + ' ' + ((from.y + to.y) / 2 + nodeHeight)
            + ', ' + (to.x + nodeWidth / 2) + ' ' + (to.y + nodeHeight) + '"><title>'
            + escape(conflict.left + ' ↔ ' + conflict.right) + '</title></path>');
    }
    const nodes = plan.tasks.map(task => {
        const position = positions.get(task.id)!;
        const title = titleLines(compact ? shortTitle(task, lang) : taskTitle(task, lang), nodeWidth - 28);
        return '<g class="task-node ' + escape(task.readiness) + (external.has(task.id) ? ' external' : '')
            + (historyOnly.has(task.id) ? ' history-node' : '') + '" data-task-id="' + escape(task.id)
            + '" data-phase="' + escape(task.phase ?? '') + '" data-x="' + position.x + '" data-y="'
            + position.y + '" role="button" tabindex="0" aria-label="' + escape(taskTitle(task, lang) + ' ' + task.id)
            + '" transform="translate(' + position.x + ',' + position.y + ')"><title>'
            + escape(task.id + '\n' + taskTitle(task, lang)) + '</title><rect width="' + nodeWidth
            + '" height="' + nodeHeight + '" rx="8"/><text class="task-name" x="14" y="25">'
            + escape(title[0]) + '</text>' + (title[1] ? '<text class="task-name" x="14" y="45">'
                + escape(title[1]) + '</text>' : '')
            + (compact ? '' : '<text class="task-id" x="14" y="76">'
                + escape(task.id.length > 39 ? task.id.slice(0, 36) + '…' : task.id) + '</text>')
            + '<text class="task-state" x="14" y="' + (compact ? 63 : 101) + '">'
            + escape((compact ? task.readiness : task.status + ' · ' + task.readiness)
                + (external.has(task.id) ? words(' · 外部前置', ' · external prerequisite', lang) : '')) + '</text></g>';
    });
    return '<svg role="group" aria-label="' + words('开发前置流程图', 'Development dependency diagram', lang)
        + '" data-direction="TB" viewBox="0 0 ' + width + ' ' + height + '" data-width="' + width + '" data-height="' + height
        + '" data-base-width="' + baseWidth + '" data-base-height="' + baseHeight
        + '" data-node-width="' + nodeWidth + '" data-node-height="' + nodeHeight + '"><defs><marker id="arrow-'
        + key + '-' + lang + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">'
        + '<path d="M 0 0 L 10 5 L 0 10 z" fill="#0284c7"/></marker></defs>'
        + edges.join('') + nodes.join('') + '</svg>';
}

function jump(task: Task | undefined, id: string, lang: Language): string {
    return '<button type="button" class="jump" data-jump="' + escape(id) + '">'
        + escape(task ? taskTitle(task, lang) : id) + '<small>' + escape(id) + '</small></button>';
}

function taskDetails(plan: SchedulePlan, lang: Language): string {
    const byId = new Map(plan.tasks.map(task => [task.id, task]));
    const jumps = (ids: string[]): string => ids.length ? '<ul>' + ids.map(id => '<li>'
        + jump(byId.get(id), id, lang) + '</li>').join('') + '</ul>' : '<p class="muted">—</p>';
    return plan.tasks.map(task => {
        const successors = plan.tasks.filter(other => other.depends_on.includes(task.id)).map(other => other.id);
        const blockers = task.blockers.length ? '<ul>' + task.blockers.map(blocker => {
            const match = /^(dependency|conflict):(.+)$/.exec(blocker);
            return '<li>' + (match ? escape(match[1] === 'dependency' ? words('前置未放行', 'Prerequisite pending', lang)
                : words('写入冲突', 'Write conflict', lang)) + jump(byId.get(match[2]), match[2], lang) : escape(blocker)) + '</li>';
        }).join('') + '</ul>' : '<p class="muted">—</p>';
        return '<article data-detail-task="' + escape(task.id) + '" data-language="' + lang + '" hidden><h2>'
            + escape(taskTitle(task, lang)) + '</h2><code>' + escape(task.id) + '</code><p class="muted">'
            + words('登记状态：', 'Recorded state: ', lang)
            + escape(task.status + ' · ' + task.readiness + ' · ' + (task.phase ?? '—') + ' · ' + (task.owner ?? '—'))
            + '</p><p class="muted">' + words('此状态并非产品验收。', 'This state is not product acceptance.', lang)
            + '</p><h3>' + words('阻塞', 'Blockers', lang) + '</h3>' + blockers
            + '<h3>' + words('真实前置', 'Actual prerequisites', lang) + '</h3>' + jumps(task.depends_on)
            + '<h3>' + words('后续', 'Successors', lang) + '</h3>' + jumps(successors.slice(0, 8))
            + (successors.length > 8 ? '<details class="successor-overflow"><summary>'
                + words('其余 ', 'Remaining ', lang) + (successors.length - 8) + '</summary>' + jumps(successors.slice(8)) + '</details>' : '')
            + '<h3>' + words('写入', 'Write paths', lang) + '</h3>' + list(task.files)
            + '<h3>' + words('独占资源', 'Exclusive resources', lang) + '</h3>' + list(task.resources)
            + '<details><summary>' + words('模块', 'Modules', lang) + '</summary>' + list(task.modules) + '</details></article>';
    }).join('');
}

/** 登记清单去重；选中冲突时仍可查全部原始登记值。 */
function packedConflicts(plan: SchedulePlan): {
    sets: string[][]; pairs: { left: string; right: string; modules: number; files: number; resources: number }[];
} {
    const sets: string[][] = [];
    const indices = new Map<string, number>();
    const intern = (values: string[]): number => {
        const key = JSON.stringify(values);
        const hit = indices.get(key);
        if (hit !== undefined) return hit;
        const index = sets.length;
        sets.push(values);
        indices.set(key, index);
        return index;
    };
    return { sets, pairs: plan.conflicts.map(conflict => ({ left: conflict.left, right: conflict.right,
        modules: intern(conflict.modules), files: intern(conflict.files), resources: intern(conflict.resources) })) };
}

function supplementary(plan: SchedulePlan, lang: Language): string {
    const byId = new Map(plan.tasks.map(task => [task.id, task]));
    const diagnostics = [...plan.errors, ...plan.warnings].map(item => '<li><code>' + escape(item.code)
        + '</code> ' + escape(item.message) + '</li>').join('');
    const waves = plan.waves.map((wave, index) => '<li>' + words('波次 ', 'Wave ', lang) + (index + 1)
        + '<ul>' + wave.map(id => '<li>' + jump(byId.get(id), id, lang) + '</li>').join('') + '</ul></li>').join('');
    const conflicts = plan.conflicts.map((conflict, index) => '<li data-conflict-left="' + escape(conflict.left)
        + '" data-conflict-right="' + escape(conflict.right) + '"><button class="jump" type="button" data-conflict-index="'
        + index + '">' + escape(conflict.left + ' ↔ ' + conflict.right) + '</button></li>').join('');
    return '<section class="supplementary" data-language="' + lang + '"><details><summary>'
        + words('排程诊断', 'Schedule diagnostics', lang) + ' (' + (plan.errors.length + plan.warnings.length)
        + ')</summary><ul>' + (diagnostics || '<li>—</li>') + '</ul></details><details><summary>'
        + words('候选波次', 'Candidate waves', lang) + ' (' + plan.waves.length + ')</summary><p class="muted">'
        + words('分叉不代表并行许可。波次不承诺工期。人工核对接口与资源。',
            'Branches do not permit parallel work. Waves are not time commitments. Check interfaces and resources.', lang)
        + '</p><ol>' + (waves || '<li>—</li>') + '</ol></details><details><summary>'
        + words('冲突明细', 'Conflict records', lang) + ' (' + plan.conflicts.length + ')</summary><p class="muted">'
        + words('选任务后过滤相关冲突。点击任务对查看完整登记。',
            'Selection filters related conflicts. Choose a pair for its full recorded claims.', lang)
        + '</p><ul class="conflict-records">' + (conflicts || '<li>—</li>') + '</ul></details><details><summary>'
        + words('全部任务', 'All task records', lang) + ' (' + plan.tasks.length + ')</summary><ul>'
        + plan.tasks.map(task => '<li>' + jump(task, task.id, lang) + '<small>'
            + escape(task.status + ' · ' + task.readiness) + '</small></li>').join('') + '</ul></details></section>';
}

function jsonData(value: unknown): string {
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
        char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** 自包含画布。源数据只作文本，不进入脚本源码。 */
export function renderScheduleTemplate(plan: SchedulePlan, summary: RenderSummary,
    opts: { lang?: string; theme?: string; live?: boolean; contentHash?: string; nonce?: string } = {}): string {
    const lang: Language = opts.lang === 'en' ? 'en' : 'zh';
    const theme = opts.theme === 'dark' ? 'dark' : 'light';
    const allPhases = [...new Set(plan.tasks.map(task => task.phase).filter((phase): phase is string => !!phase))]
        .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const phases = allPhases;
    const overview = overviewPlan(plan);
    const graphPanels = (['zh', 'en'] as Language[]).map(language => {
        const panel = (value: SchedulePlan, key: string, external?: Set<string>): string =>
            '<div class="graph-panel" data-language="' + language + '" data-graph-view="' + key
                + '"' + (language !== lang || key !== 'overview' ? ' hidden' : '') + '>'
                + diagram(value, plan, language, key, external) + '</div>';
        return panel(overview, 'overview') + phases.map((phase, index) => {
            const stage = stagePlan(plan, phase);
            return panel(stage.plan, 'phase-' + index, stage.external);
        }).join('') + panel(plan, 'full');
    }).join('');
    const label = (zh: string, en: string): string => ' data-zh="' + escape(zh) + '" data-en="' + escape(en)
        + '">' + escape(words(zh, en, lang));
    const data = { phases, tasks: plan.tasks.map(task => ({ id: task.id, title: task.title, phase: task.phase })),
        conflicts: packedConflicts(plan) };
    return `<!DOCTYPE html>
<html lang="${lang}" data-theme="${theme}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="normify"><title>${escape(summary.name)} · Normify Schedule</title><style>
:root{--panel:#fff;--text:#16233b;--muted:#5c6b85;--border:#d7dfec;--accent:#0284c7;--warn:#b45309}
[data-theme=dark]{--panel:#111a2c;--text:#e6edf7;--muted:#a0aec3;--border:#34455f;--accent:#38bdf8;--warn:#fbbf24}
*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden}body{background:var(--panel);color:var(--text);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;font-size:12px}
#schedule-shell{height:100dvh;display:flex;flex-direction:column;overflow:hidden}header{flex:none;border-bottom:1px solid var(--border)}.toolbar-row{display:flex;align-items:center;gap:6px;padding:7px 10px;white-space:nowrap;overflow-x:auto}.toolbar-row+ .toolbar-row{border-top:1px solid var(--border);padding-top:5px;padding-bottom:5px}h1{font-size:16px;margin:0 10px 0 0}button,select{font:inherit;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:5px 8px}button{cursor:pointer}button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}label{display:flex;align-items:center;gap:4px}input[type=checkbox]{margin:0}#zoom-percent{width:42px;text-align:center}#locate-select{max-width:270px}#phase-select{max-width:130px}
#workspace{display:flex;flex:1;min-height:0}#graph-canvas{position:relative;flex:1;min-width:0;min-height:0;background:#fff;overflow:hidden;touch-action:none;cursor:grab}#graph-canvas.dragging{cursor:grabbing}.graph-panel{position:absolute;inset:0}.graph-panel svg{width:100%;height:100%;display:block;user-select:none}.graph-message{margin:24px;color:#52627a}.task-node{cursor:pointer}.task-node rect{fill:white;stroke:#b6c1d2;stroke-width:1.5}.task-node.ready rect,.task-node.verified rect{stroke:#059669}.task-node.in_progress rect{stroke:#0284c7}.task-node.blocked rect{stroke:#dc2626}.task-node.unscheduled rect,.task-node.external rect{stroke-dasharray:5 3}.task-node.abandoned rect{stroke-dasharray:3 3;opacity:.65}.task-node.selected rect,.task-node:focus rect{stroke:#0284c7;stroke-width:3;fill:#eef8ff}.task-node:focus{outline:none}.task-name{fill:#16233b;font-size:14px;font-weight:600}.task-id,.task-state{fill:#52627a;font-size:10px}.prerequisite{fill:none;stroke:#0284c7;stroke-width:1.8}.conflict-edge{display:none;fill:none;stroke:#b45309;stroke-width:1.4;stroke-dasharray:6 5;opacity:.65}.history-node{display:none}.show-history .history-node,.show-history .history-conflict,.conflict-edge.selected-conflict:not(.history-conflict){display:block}
#detail-panel{width:310px;flex:0 0 310px;min-height:0;overflow:auto;border-left:1px solid var(--border);padding:10px 12px}.detail-heading{display:flex;align-items:center;justify-content:space-between}.detail-heading h2{margin:0;font-size:14px}.detail-heading button{padding:2px 8px}h2{font-size:15px;margin:12px 0 6px;overflow-wrap:anywhere}h3{font-size:12px;margin:12px 0 5px}p{line-height:1.6}.muted{color:var(--muted)}.notice{color:var(--muted);font-size:11px;line-height:1.65;border-left:2px solid var(--accent);padding-left:8px;margin:8px 0}code,small{font-size:10px;overflow-wrap:anywhere}ul,ol{padding-left:18px;line-height:1.6}li{overflow-wrap:anywhere}.jump{display:block;border:0;text-align:left;padding:3px 0;color:var(--accent);max-width:100%;white-space:normal;overflow-wrap:anywhere}.jump small{display:block;color:var(--muted)}details{margin-top:10px}summary{cursor:pointer;font-weight:600}.supplementary{margin-top:16px;border-top:1px solid var(--border);padding-top:3px}#conflict-detail{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--border);padding:8px;font:10px/1.5 monospace}footer{flex:none;border-top:1px solid var(--border);padding:4px 10px;color:var(--muted);font-size:10px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}[hidden]{display:none!important}
@media(max-width:700px){#workspace{flex-direction:column}#detail-panel{width:100%;height:35%;flex:0 0 35%;border-left:0;border-top:1px solid var(--border)}h1{max-width:150px;text-overflow:ellipsis;overflow:hidden}.toolbar-row{gap:5px}}
</style></head><body><div id="schedule-shell"><header>
<div id="schedule-toolbar-row1" class="toolbar-row"><h1>${escape(summary.name)}</h1>
<button type="button" id="view-overview" data-mode="overview"${label('准入主线', 'Gate overview')}</button>
<button type="button" id="view-phase" data-mode="phase"${label('阶段任务', 'Phase tasks')}</button>
<button type="button" id="view-full" data-mode="full"${label('完整依赖', 'All dependencies')}</button>
<select id="phase-select" aria-label="Phase"${phases.length ? '' : ' disabled'}>${phases.map((phase, index) => '<option value="'
    + index + '">' + escape(phase) + '</option>').join('')}</select>
<label><input id="history-toggle" type="checkbox"><span${label('显示历史占用', 'Historical occupancy')}</span></label></div>
<div id="schedule-toolbar-row2" class="toolbar-row"><button type="button" id="zoom-in" aria-label="Zoom in">+</button>
<button type="button" id="zoom-out" aria-label="Zoom out">−</button><output id="zoom-percent">100%</output>
<button type="button" id="zoom-fit"${label('全图适应', 'Fit')}</button><button type="button" id="zoom-actual">100%</button>
<select id="locate-select" aria-label="Locate task"><option value=""${label('定位节点', 'Locate node')}</option>${plan.tasks.map(task => '<option value="'
    + escape(task.id) + '"' + label(task.title.zh + ' · ' + task.id, (task.title.en || task.title.zh) + ' · ' + task.id)
    + '</option>').join('')}</select><button type="button" id="refresh"${label('刷新', 'Refresh')}</button>
<button type="button" id="toggle-details" aria-pressed="false"${label('详情', 'Details')}</button>
<button type="button" id="theme"${label('主题', 'Theme')}</button><button type="button" id="lang">中文 / EN</button></div></header>
<main id="workspace"><div id="graph-canvas" class="diagram-scroll">${graphPanels}</div>
<aside id="detail-panel" hidden><div class="detail-heading"><h2${label('任务详情', 'Task details')}</h2><button type="button" id="close-details" aria-label="Close details">×</button></div>
<p class="notice" data-language="zh">实时排程，不代表产品验收。登记 verified 不证明产品已验收。实线表示真实前置路径。橙色虚线只表示登记冲突。阶段编号不规定串行顺序。</p>
<p class="notice" data-language="en" hidden>Live schedule, not product acceptance. Recorded verified status is not proof of acceptance. Solid arrows show real prerequisite paths. Orange dashed lines show recorded conflicts only. Phase numbers do not impose serial development.</p>
<p id="detail-empty" class="muted"${label('点击节点查看任务。主线门禁可跳阶段。', 'Select a task. Overview gates open their phase.')}</p>
<div id="detail-content">${taskDetails(plan, 'zh')}${taskDetails(plan, 'en')}</div>${supplementary(plan, 'zh')}${supplementary(plan, 'en')}
<pre id="conflict-detail" hidden></pre></aside></main><footer>实时排程，不代表产品验收。 / Live schedule, not product acceptance. · schema ${plan.schema_version} · content ${escape(opts.contentHash ?? '')} · ${plan.tasks.length} tasks · URL随MCP退出失效；空闲30分钟后关闭。 / URL expires with MCP or after 30 idle minutes.</footer></div>
<script type="application/json" id="schedule-data">${jsonData(data)}</script>
<script${opts.nonce ? ' nonce="' + escape(opts.nonce) + '"' : ''}>(function(){'use strict';
var data=JSON.parse(document.getElementById('schedule-data').textContent),canvas=document.getElementById('graph-canvas');
var language=document.documentElement.lang,mode='overview',phase='0',selection='',scale=1,box=[0,0,1,1],drag=null,suppressClickUntil=0;
function task(id){return data.tasks.find(function(item){return item.id===id})}
function panel(){var key=mode==='phase'?'phase-'+phase:mode;return Array.from(canvas.querySelectorAll('[data-graph-view]')).find(function(item){return item.dataset.language===language&&item.dataset.graphView===key})}
function svg(){var current=panel();return current&&current.querySelector('svg')}
function size(){var rect=canvas.getBoundingClientRect();return [Math.max(1,rect.width),Math.max(1,rect.height)]}
function draw(){var graph=svg();if(graph)graph.setAttribute('viewBox',box.join(' '));document.getElementById('zoom-percent').textContent=Math.round(scale*100)+'%'}
function setScale(value,x,y){var dimensions=size();scale=Math.max(.03,Math.min(5,value));box=[x-dimensions[0]/scale/2,y-dimensions[1]/scale/2,dimensions[0]/scale,dimensions[1]/scale];draw()}
function fit(){var graph=svg();if(!graph)return;var history=document.getElementById('history-toggle').checked,w=Number(history?graph.dataset.width:graph.dataset.baseWidth),h=Number(history?graph.dataset.height:graph.dataset.baseHeight),dimensions=size();setScale(Math.min(dimensions[0]/w,dimensions[1]/h)*.94,w/2,h/2)}
function zoom(factor,px,py){px=px===undefined?.5:px;py=py===undefined?.5:py;var old=scale,next=Math.max(.03,Math.min(5,scale*factor)),nw=box[2]*old/next,nh=box[3]*old/next;box=[box[0]+(box[2]-nw)*px,box[1]+(box[3]-nh)*py,nw,nh];scale=next;draw()}
function updateSelection(){document.querySelectorAll('[data-detail-task]').forEach(function(item){item.hidden=item.dataset.detailTask!==selection||item.dataset.language!==language});document.getElementById('detail-empty').hidden=!!selection;canvas.querySelectorAll('[data-task-id]').forEach(function(node){node.classList.toggle('selected',node.dataset.taskId===selection)});canvas.querySelectorAll('.conflict-edge').forEach(function(edge){edge.classList.toggle('selected-conflict',!!selection&&(edge.dataset.left===selection||edge.dataset.right===selection))});document.querySelectorAll('[data-conflict-left]').forEach(function(item){item.hidden=!!selection&&item.dataset.conflictLeft!==selection&&item.dataset.conflictRight!==selection});document.getElementById('locate-select').value=selection;document.getElementById('conflict-detail').hidden=true}
function show(){var key=mode==='phase'?'phase-'+phase:mode;canvas.querySelectorAll('[data-graph-view]').forEach(function(item){item.hidden=item.dataset.language!==language||item.dataset.graphView!==key});document.querySelectorAll('[data-language]').forEach(function(item){if(!item.hasAttribute('data-graph-view')&&!item.hasAttribute('data-detail-task'))item.hidden=item.dataset.language!==language});document.querySelectorAll('[data-mode]').forEach(function(button){button.setAttribute('aria-pressed',String(button.dataset.mode===mode))});canvas.classList.toggle('show-history',document.getElementById('history-toggle').checked);document.querySelectorAll('[data-zh]').forEach(function(item){item.textContent=item.dataset[language]});updateSelection()}
function view(next){mode=next==='phase'&&!data.phases.length?'full':next;show();fit()}
function details(visible){document.getElementById('detail-panel').hidden=!visible;document.getElementById('toggle-details').setAttribute('aria-pressed',String(visible))}
function select(id){if(!task(id))return;var opened=document.getElementById('detail-panel').hidden;selection=id;details(true);updateSelection();if(opened)fit()}
function center(id){if(!task(id))return;select(id);var graph=svg(),node=graph&&Array.from(graph.querySelectorAll('[data-task-id]')).find(function(item){return item.dataset.taskId===id});if(!node||(node.classList.contains('history-node')&&!document.getElementById('history-toggle').checked)){var selected=task(id),index=selected?data.phases.indexOf(selected.phase):-1;mode=index<0?'full':'phase';if(index>=0){phase=String(index);document.getElementById('phase-select').value=phase}show();graph=svg();node=graph&&Array.from(graph.querySelectorAll('[data-task-id]')).find(function(item){return item.dataset.taskId===id})}if(node&&graph)setScale(Math.max(scale,.8),Number(node.dataset.x)+Number(graph.dataset.nodeWidth)/2,Number(node.dataset.y)+Number(graph.dataset.nodeHeight)/2)}
function activate(id){var selected=task(id);if(!selected)return;var jumped=mode==='overview';if(jumped){var index=data.phases.indexOf(selected.phase);mode=index<0?'full':'phase';if(index>=0){phase=String(index);document.getElementById('phase-select').value=phase}show();fit()}select(id);if(jumped){var graph=svg(),node=graph&&Array.from(graph.querySelectorAll('[data-task-id]')).find(function(item){return item.dataset.taskId===id});if(node&&typeof node.focus==='function')node.focus()}}
document.querySelectorAll('[data-mode]').forEach(function(button){button.addEventListener('click',function(){view(button.dataset.mode)})});
document.getElementById('phase-select').addEventListener('change',function(){phase=this.value;view('phase')});
document.getElementById('history-toggle').addEventListener('change',function(){canvas.classList.toggle('show-history',this.checked);fit()});
document.getElementById('zoom-in').addEventListener('click',function(){zoom(1.25)});document.getElementById('zoom-out').addEventListener('click',function(){zoom(.8)});document.getElementById('zoom-fit').addEventListener('click',fit);document.getElementById('zoom-actual').addEventListener('click',function(){setScale(1,box[0]+box[2]/2,box[1]+box[3]/2)});
document.getElementById('locate-select').addEventListener('change',function(){center(this.value)});document.getElementById('refresh').addEventListener('click',function(){location.reload()});document.getElementById('close-details').addEventListener('click',function(){selection='';updateSelection();details(false);fit()});document.getElementById('toggle-details').addEventListener('click',function(){details(document.getElementById('detail-panel').hidden);fit()});
document.getElementById('lang').addEventListener('click',function(){language=language==='zh'?'en':'zh';document.documentElement.lang=language;show();fit()});document.getElementById('theme').addEventListener('click',function(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light'});
canvas.addEventListener('click',function(event){if(Date.now()<suppressClickUntil){event.preventDefault();return}var node=event.target.closest('[data-task-id]');if(node)activate(node.dataset.taskId)});
canvas.addEventListener('keydown',function(event){if(event.key!=='Enter'&&event.key!==' ')return;var node=event.target.closest('[data-task-id]');if(node){event.preventDefault();activate(node.dataset.taskId)}});
document.getElementById('detail-panel').addEventListener('click',function(event){var link=event.target.closest('[data-jump]');if(link){center(link.dataset.jump);return}var record=event.target.closest('[data-conflict-index]');if(!record)return;var conflict=data.conflicts.pairs[Number(record.dataset.conflictIndex)];if(!conflict)return;var claims={left:conflict.left,right:conflict.right,modules:data.conflicts.sets[conflict.modules],files:data.conflicts.sets[conflict.files],resources:data.conflicts.sets[conflict.resources]},output=document.getElementById('conflict-detail');output.textContent=JSON.stringify(claims,null,2);output.hidden=false});
canvas.addEventListener('wheel',function(event){event.preventDefault();var rect=canvas.getBoundingClientRect();zoom(event.deltaY<0?1.18:.85,(event.clientX-rect.left)/Math.max(1,rect.width),(event.clientY-rect.top)/Math.max(1,rect.height))},{passive:false});
canvas.addEventListener('pointerdown',function(event){if(event.button!==0||!svg())return;var node=event.target.closest('[data-task-id]');drag={id:event.pointerId,x:event.clientX,y:event.clientY,box:box.slice(),scale:scale,moved:false,task:node?node.dataset.taskId:''};canvas.setPointerCapture(event.pointerId)});
canvas.addEventListener('pointermove',function(event){if(!drag||drag.id!==event.pointerId)return;var dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.hypot(dx,dy)>4)drag.moved=true;if(drag.moved){canvas.classList.add('dragging');box=[drag.box[0]-dx/drag.scale,drag.box[1]-dy/drag.scale,drag.box[2],drag.box[3]];draw()}});
function stop(event){if(!drag||drag.id!==event.pointerId)return;var previous=drag;drag=null;canvas.classList.remove('dragging');if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);suppressClickUntil=Date.now()+300;if(!previous.moved&&event.type==='pointerup'&&previous.task)activate(previous.task)}
canvas.addEventListener('pointerup',stop);canvas.addEventListener('pointercancel',stop);canvas.addEventListener('lostpointercapture',function(){if(drag&&drag.moved)suppressClickUntil=Date.now()+300;drag=null;canvas.classList.remove('dragging')});window.addEventListener('resize',fit);show();fit();
})()</script></body></html>\n`;
}
