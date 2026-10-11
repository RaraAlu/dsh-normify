function escape(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function lines(value) {
    return Array.isArray(value) ? value.map(item => String(item)) : [];
}
function taskTitle(task, lang) {
    return task.title[lang] || task.title.zh;
}
function words(zh, en, lang) {
    return lang === 'zh' ? zh : en;
}
function list(values) {
    const valuesList = lines(values);
    return valuesList.length > 0 ? valuesList.map(escape).join('<br>') : '<span class="muted">—</span>';
}
function titleLines(title) {
    const rows = [''];
    let width = 0;
    for (const char of title) {
        const charWidth = (char.codePointAt(0) ?? 0) > 0x2e80 ? 14 : 8;
        if (width + charWidth > 248) {
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
/** 总览只投影真实可达边。阶段名称不产生任何前置。 */
function overviewPlan(plan) {
    const selected = plan.tasks.filter(task => {
        if (!task.phase)
            return false;
        const prefix = task.title.zh.slice(0, task.phase.length);
        const suffix = task.title.zh.slice(task.phase.length);
        return prefix === task.phase && /^(?:-(?:CONTRACT|HOST|BASE|UPLOAD|ENTRY))?(?:\s|$)/i.test(suffix);
    });
    const tasks = selected.length > 1 ? selected : plan.tasks.length <= 12 ? plan.tasks : selected;
    const byId = new Map(plan.tasks.map(task => [task.id, task]));
    const ancestors = new Map();
    for (const task of tasks) {
        const found = new Set();
        const visit = (id) => {
            if (found.has(id))
                return;
            found.add(id);
            byId.get(id)?.depends_on.forEach(visit);
        };
        task.depends_on.forEach(visit);
        ancestors.set(task.id, found);
    }
    return { ...plan, tasks: tasks.map(task => {
            const predecessors = tasks.filter(other => ancestors.get(task.id)?.has(other.id));
            return { ...task, depends_on: predecessors.filter(predecessor => !predecessors.some(other => other.id !== predecessor.id && ancestors.get(other.id)?.has(predecessor.id))).map(other => other.id) };
        }) };
}
function stagePlan(plan, phase) {
    const members = plan.tasks.filter(task => task.phase === phase);
    const ids = new Set(members.map(task => task.id));
    const external = new Set(members.flatMap(task => task.depends_on).filter(id => !ids.has(id)));
    const tasks = plan.tasks.filter(task => ids.has(task.id) || external.has(task.id));
    const included = new Set(tasks.map(task => task.id));
    return { plan: { ...plan, tasks: tasks.map(task => ({ ...task,
                depends_on: task.depends_on.filter(id => included.has(id)) })) }, external };
}
/** 图中前置边只读取显式 depends_on，不引用架构边或阅读顺序。 */
function diagram(plan, lang, key, external = new Set()) {
    const tasks = plan.tasks;
    if (tasks.length === 0)
        return '<p class="muted">' + words('尚无登记任务。', 'No registered tasks.', lang) + '</p>';
    const byId = new Map(tasks.map(task => [task.id, task]));
    const ranks = new Map();
    const visiting = new Set();
    const rank = (id) => {
        const hit = ranks.get(id);
        if (hit !== undefined)
            return hit;
        if (visiting.has(id))
            return 0;
        visiting.add(id);
        let value = 0;
        for (const predecessor of lines(byId.get(id)?.depends_on)) {
            if (byId.has(predecessor))
                value = Math.max(value, rank(predecessor) + 1);
        }
        visiting.delete(id);
        ranks.set(id, value);
        return value;
    };
    tasks.forEach(task => rank(task.id));
    const columns = new Map();
    for (const task of tasks) {
        const level = ranks.get(task.id) ?? 0;
        columns.set(level, [...(columns.get(level) ?? []), task]);
    }
    const nodeWidth = 286;
    const nodeHeight = 126;
    const xStep = 350;
    const yStep = 162;
    const positions = new Map();
    for (const [level, members] of columns) {
        members.forEach((task, index) => positions.set(task.id, { x: 26 + level * xStep, y: 58 + index * yStep }));
    }
    const width = Math.max(720, columns.size * xStep + 20);
    const height = Math.max(220, ...[...columns.values()].map(members => 72 + members.length * yStep));
    const edges = [];
    for (const task of tasks) {
        const to = positions.get(task.id);
        for (const predecessor of lines(task.depends_on)) {
            const from = positions.get(predecessor);
            if (from === undefined)
                continue;
            const x1 = from.x + nodeWidth;
            const x2 = to.x;
            const y1 = from.y + nodeHeight / 2;
            const y2 = to.y + nodeHeight / 2;
            edges.push('<path class="prerequisite" marker-end="url(#arrow-' + key + '-' + lang + ')" d="M '
                + x1 + ' ' + y1 + ' C ' + (x1 + 36) + ' ' + y1 + ', ' + (x2 - 36) + ' ' + y2
                + ', ' + x2 + ' ' + y2 + '"><title>' + escape(predecessor + ' → ' + task.id) + '</title></path>');
        }
    }
    for (const conflict of plan.conflicts) {
        const from = positions.get(conflict.left);
        const to = positions.get(conflict.right);
        if (from === undefined || to === undefined)
            continue;
        const reason = [...lines(conflict.modules), ...lines(conflict.files), ...lines(conflict.resources)].join(', ');
        edges.push('<path class="conflict-edge" d="M ' + (from.x + nodeWidth / 2) + ' ' + (from.y + nodeHeight)
            + ' Q ' + (Math.max(from.x, to.x) + nodeWidth + 18) + ' ' + ((from.y + to.y) / 2 + nodeHeight)
            + ', ' + (to.x + nodeWidth / 2) + ' ' + (to.y + nodeHeight) + '"><title>'
            + escape(reason) + '</title></path>');
    }
    const headings = [...columns.keys()].map(level => '<text class="level-label" x="' + (26 + level * xStep)
        + '" y="30">' + words('前置层 ', 'Dependency level ', lang) + level + '</text>');
    const nodes = tasks.map(task => {
        const position = positions.get(task.id);
        const title = titleLines(taskTitle(task, lang));
        return '<g class="task-node ' + escape(task.readiness) + (external.has(task.id) ? ' external' : '')
            + '" data-task-id="' + escape(task.id) + '" transform="translate(' + position.x + ',' + position.y + ')">'
            + '<title>' + escape(task.id + '\n' + taskTitle(task, lang) + '\n' + lines(task.blockers).join('\n')) + '</title>'
            + '<rect width="' + nodeWidth + '" height="' + nodeHeight + '" rx="10"/>'
            + '<text class="task-name" x="14" y="28">' + escape(title[0]) + '</text>'
            + (title[1] ? '<text class="task-name" x="14" y="49">' + escape(title[1]) + '</text>' : '')
            + '<text class="task-id" x="14" y="76">' + escape(task.id.length > 39 ? task.id.slice(0, 36) + '…' : task.id) + '</text>'
            + '<text class="task-state" x="14" y="101">' + escape(task.status + ' · ' + task.readiness
            + (external.has(task.id) ? words(' · 外部前置', ' · external prerequisite', lang) : '')) + '</text>'
            + '</g>';
    });
    return '<div class="diagram-controls"><button type="button" data-zoom="in">+</button>'
        + '<button type="button" data-zoom="out">−</button><button type="button" data-zoom="fit">'
        + words('适应画布', 'Fit', lang) + '</button><button type="button" data-conflicts>'
        + words('显示冲突', 'Show conflicts', lang) + '</button><span class="muted">'
        + words('滚轮缩放，拖动画布。', 'Wheel to zoom; drag to pan.', lang) + '</span></div>'
        + '<div class="diagram-scroll"><svg role="img" aria-label="' + words('开发前置流程图', 'Development dependency diagram', lang)
        + '" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height
        + '" data-width="' + width + '" data-height="' + height + '"><defs><marker id="arrow-' + key + '-' + lang
        + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
        + '<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)"/></marker></defs>'
        + headings.join('') + edges.join('') + nodes.join('') + '</svg></div>';
}
function content(plan, lang) {
    const named = new Map(plan.tasks.map(task => [task.id, taskTitle(task, lang)]));
    const taskNames = (ids) => lines(ids).map(id => escape(named.get(id) ?? id)).join(' · ') || '—';
    const cards = [
        [words('就绪', 'Ready', lang), plan.ready, 'ready'],
        [words('运行', 'Running', lang), plan.running, 'running'],
        [words('阻断', 'Blocked', lang), plan.blocked, 'blocked'],
        [words('未登记', 'Unscheduled', lang), plan.unscheduled, 'unscheduled'],
        [words('已完成', 'Completed', lang), plan.completed, 'completed'],
    ].map(([label, values, css]) => '<div class="card ' + css + '"><h2>' + label + ' <span>'
        + lines(values).length + '</span></h2><p>' + taskNames(values) + '</p></div>').join('');
    const waves = plan.waves.map((wave, index) => '<li><strong>' + words('波次 ', 'Wave ', lang) + (index + 1)
        + '</strong><p>' + taskNames(wave) + '</p></li>').join('');
    const conflicts = plan.conflicts.map(conflict => '<tr><td>' + escape(conflict.left) + '<br>' + escape(conflict.right)
        + '</td><td>' + list(conflict.modules) + '</td><td>' + list(conflict.files) + '</td><td>' + list(conflict.resources) + '</td></tr>').join('');
    const tasks = plan.tasks.map(task => '<tr data-task="' + escape(task.id + ' ' + taskTitle(task, lang)) + '">'
        + '<td><strong>' + escape(taskTitle(task, lang)) + '</strong><br><code>' + escape(task.id) + '</code></td>'
        + '<td>' + escape(task.status) + '<br>' + escape(task.readiness) + '</td>'
        + '<td>' + escape(task.phase ?? '—') + '<br>' + escape(task.owner ?? '—') + '</td>'
        + '<td>' + list(task.depends_on) + '</td><td>' + list(task.blockers) + '</td>'
        + '<td>' + list(task.modules) + '</td><td>' + list(task.files) + '</td><td>' + list(task.resources) + '</td></tr>').join('');
    const phases = [...new Set(plan.tasks.map(task => task.phase).filter((phase) => !!phase))]
        .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const views = ['<button type="button" data-view="overview">' + words('阶段总览', 'Overview', lang) + '</button>',
        ...phases.map((phase, index) => '<button type="button" data-view="phase-' + index + '">' + escape(phase) + '</button>'),
        '<button type="button" data-view="full">' + words('完整任务图', 'All tasks', lang) + '</button>'].join('');
    const graph = (value, key, external) => plan.ok
        ? diagram(value, lang, key, external) : '<p class="notice">'
        + words('排程含错误。修复后再读依赖图。', 'Schedule errors prevent a valid dependency diagram.', lang) + '</p>';
    const graphs = '<div data-graph-view="overview">' + graph(overviewPlan(plan), 'overview') + '</div>'
        + phases.map((phase, index) => {
            const stage = stagePlan(plan, phase);
            return '<div data-graph-view="phase-' + index + '" hidden>' + graph(stage.plan, 'phase-' + index, stage.external) + '</div>';
        }).join('') + '<div data-graph-view="full" hidden>' + graph(plan, 'full') + '</div>';
    const diagnostics = [...plan.errors, ...plan.warnings].map(item => '<li><code>' + escape(item.code)
        + '</code> ' + escape(item.message) + '</li>').join('');
    return '<section data-language="' + lang + '"><p class="notice">'
        + words('实时只读排程。刷新读取当前模块与变更。任务状态不等于产品验收。实线表示前置；总览实线表示真实依赖路径。橙色虚线只表示写入或资源冲突，不代表开发前置。', 'Live read-only schedule; refresh reads current modules and changes. Task states do not prove product acceptance. Solid arrows show prerequisites; overview arrows project real dependency paths. Orange dashed lines only show write/resource conflicts, not prerequisites.', lang)
        + '</p><div class="cards">' + cards + '</div><h2>' + words('任务前置图', 'Prerequisite graph', lang) + '</h2>'
        + '<p class="muted">' + words('总览省略独立任务。阶段标签不规定串行顺序。阶段细图保留外部前置；其余前置见任务表。架构deps与阅读order不参与排程。', 'Overview omits independent tasks. Phase labels do not impose sequential development. Stage graphs retain external prerequisites; the task table shows all dependencies. Architecture deps and reading order never determine scheduling.', lang)
        + '</p><nav class="view-controls">' + views + '</nav>' + graphs
        + '<h2>' + words('排程诊断', 'Schedule diagnostics', lang) + '</h2><ul>' + (diagnostics || '<li>—</li>') + '</ul>'
        + '<h2>' + words('预测串行波次', 'Predicted sequential waves', lang) + '</h2><p class="muted">'
        + words('同波仅表示无登记冲突。仍须人工确认资源与接口。依次集成各波成果。不承诺工期或自动执行。', 'Tasks in one wave have no registered conflict; confirm interfaces and resources manually. Integrate waves in order. Waves are not calendar estimates or automatic execution.', lang)
        + '</p><ol class="waves">' + (waves || '<li>—</li>') + '</ol><h2>' + words('并行冲突', 'Parallel conflicts', lang) + '</h2>'
        + '<div class="table-scroll"><table><thead><tr><th>' + words('任务对', 'Task pair', lang) + '</th><th>' + words('模块', 'Modules', lang)
        + '</th><th>' + words('写入路径', 'Write paths', lang) + '</th><th>' + words('独占资源', 'Exclusive resources', lang)
        + '</th></tr></thead><tbody>' + (conflicts || '<tr><td colspan="4">—</td></tr>') + '</tbody></table></div>'
        + '<h2>' + words('任务明细', 'Task details', lang) + '</h2><div class="table-scroll"><table class="task-table"><thead><tr>'
        + [words('任务', 'Task', lang), words('状态', 'Status', lang), words('阶段 / 负责人', 'Phase / owner', lang),
            words('前置', 'Prerequisites', lang), words('阻断原因', 'Blockers', lang), words('模块', 'Modules', lang),
            words('写入路径', 'Write paths', lang), words('独占资源', 'Exclusive resources', lang)]
            .map(label => '<th>' + label + '</th>').join('')
        + '</tr></thead><tbody>' + tasks + '</tbody></table></div></section>';
}
/** 自包含排程查看器；不加载脚本包，也不执行源数据。 */
export function renderScheduleTemplate(plan, summary, opts = {}) {
    const lang = opts.lang === 'en' ? 'en' : 'zh';
    const theme = opts.theme === 'light' ? 'light' : 'dark';
    return `<!DOCTYPE html>
<html lang="${lang}" data-theme="${theme}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="normify"><title>${escape(summary.name)} · Normify Schedule</title>
<style>
:root{--bg:#0b1220;--panel:#111a2c;--text:#e6edf7;--muted:#93a4bf;--border:#24344f;--accent:#38bdf8;--warn:#fbbf24;--good:#34d399;--danger:#f87171}
[data-theme=light]{--bg:#f6f8fc;--panel:#fff;--text:#16233b;--muted:#5c6b85;--border:#d7dfec;--accent:#0284c7;--warn:#b45309;--good:#059669;--danger:#dc2626}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
header{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:16px 24px;background:var(--panel);border-bottom:1px solid var(--border)}
header h1{margin:0;font-size:20px;color:var(--accent)}.controls{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
button,input{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 10px}button{cursor:pointer}
main{max-width:1440px;margin:auto;padding:24px}h2{font-size:18px}.notice{padding:14px;border-left:3px solid var(--accent);background:var(--panel);line-height:1.8}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px;overflow-wrap:anywhere}
.card h2{font-size:16px;margin:0}.card h2 span{float:right;color:var(--accent)}.card p{font-size:13px;line-height:1.6}.muted{color:var(--muted)}
.diagram-scroll,.table-scroll{overflow:auto;border:1px solid var(--border);border-radius:10px;background:var(--panel)}.diagram-scroll{height:65vh;min-height:280px;overflow:hidden;touch-action:none;cursor:grab}.diagram-scroll.dragging{cursor:grabbing}.diagram-scroll svg{width:100%;height:100%;user-select:none}.diagram-controls,.view-controls{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.view-controls button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
svg{display:block}.level-label{fill:var(--muted);font-size:14px}.prerequisite{fill:none;stroke:var(--accent);stroke-width:2}.conflict-edge{display:none;fill:none;stroke:var(--warn);stroke-width:1.5;stroke-dasharray:6 5;opacity:.65}.show-conflicts .conflict-edge{display:block}.task-node.external rect{stroke-dasharray:8 4}
.task-node rect{fill:var(--panel);stroke:var(--border);stroke-width:2}.task-node.ready rect,.task-node.verified rect{stroke:var(--good)}.task-node.in_progress rect{stroke:var(--accent)}.task-node.blocked rect{stroke:var(--danger)}.task-node.unscheduled rect{stroke-dasharray:5 4}.task-node.abandoned rect{opacity:.6;stroke-dasharray:3 3}
.task-name{fill:var(--text);font-size:14px;font-weight:600}.task-id,.task-state{fill:var(--muted);font-size:11px}.waves{display:flex;gap:12px;flex-wrap:wrap;padding-left:24px}.waves li{background:var(--panel);padding:12px;min-width:180px;max-width:320px;overflow-wrap:anywhere}.waves p{font-size:13px;line-height:1.6}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:10px;vertical-align:top;text-align:left;border-bottom:1px solid var(--border);overflow-wrap:anywhere}th{color:var(--muted)}code{font-size:11px}.task-table{min-width:1050px}
footer{text-align:center;padding:20px;color:var(--muted);font-size:12px}[hidden]{display:none!important}
@media print{.controls{display:none}.diagram-scroll{max-height:none}.table-scroll{overflow:visible}body{background:white;color:black}}
</style></head><body><header><h1>${escape(summary.name)} · Normify Schedule</h1><div class="controls">
<input id="search" placeholder="搜索任务 / Filter tasks" aria-label="Filter tasks"><button id="refresh">刷新 / Refresh</button><button id="lang">中文 / EN</button><button id="theme">主题 / Theme</button>
</div></header><main>${content(plan, 'zh')}${content(plan, 'en')}</main>
<footer>schema ${plan.schema_version} · content ${escape(opts.contentHash ?? '')} · ${plan.tasks.length} tasks<br>
实时排程，不是Git或产品验收。URL随MCP退出失效。空闲30分钟后服务关闭。<br>Live schedule, not Git or product acceptance. URL expires with MCP or after 30 idle minutes.</footer>
<script${opts.nonce ? ' nonce="' + escape(opts.nonce) + '"' : ''}>(function(){'use strict';var language=document.documentElement.lang;function show(){document.querySelectorAll('[data-language]').forEach(function(section){section.hidden=section.dataset.language!==language})}show();
document.getElementById('lang').addEventListener('click',function(){language=language==='zh'?'en':'zh';document.documentElement.lang=language;show()});
document.getElementById('theme').addEventListener('click',function(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light'});
document.getElementById('search').addEventListener('input',function(event){var query=event.target.value.toLowerCase();document.querySelectorAll('[data-task]').forEach(function(row){row.hidden=row.dataset.task.toLowerCase().indexOf(query)<0})});
document.getElementById('refresh').addEventListener('click',function(){location.reload()});
document.querySelectorAll('[data-language]').forEach(function(section){section.querySelectorAll('[data-view]').forEach(function(button){button.setAttribute('aria-pressed',String(button.dataset.view==='overview'));button.addEventListener('click',function(){section.querySelectorAll('[data-graph-view]').forEach(function(graph){graph.hidden=graph.dataset.graphView!==button.dataset.view});section.querySelectorAll('[data-view]').forEach(function(other){other.setAttribute('aria-pressed',String(other===button))})})});
section.querySelectorAll('.diagram-scroll').forEach(function(canvas){var svg=canvas.querySelector('svg'),controls=canvas.previousElementSibling,w=Number(svg.dataset.width),h=Number(svg.dataset.height),box=[0,0,w,h],drag=null;function draw(){svg.setAttribute('viewBox',box.join(' '))}function zoom(factor,x,y){var scale=Math.max(.05,Math.min(8,box[2]/w*factor)),nw=w*scale,nh=h*scale,px=x===undefined?.5:x,py=y===undefined?.5:y;box=[box[0]+(box[2]-nw)*px,box[1]+(box[3]-nh)*py,nw,nh];draw()}function coordinates(event){var matrix=svg.getScreenCTM();if(!matrix)return null;return new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse())}
controls.querySelectorAll('[data-zoom]').forEach(function(button){button.addEventListener('click',function(){if(button.dataset.zoom==='fit'){box=[0,0,w,h];draw()}else zoom(button.dataset.zoom==='in'?.8:1.25)})});controls.querySelector('[data-conflicts]').addEventListener('click',function(){canvas.classList.toggle('show-conflicts');this.setAttribute('aria-pressed',String(canvas.classList.contains('show-conflicts')))});
canvas.addEventListener('wheel',function(event){event.preventDefault();var point=coordinates(event);if(point)zoom(event.deltaY<0?.85:1.18,(point.x-box[0])/box[2],(point.y-box[1])/box[3])},{passive:false});
canvas.addEventListener('pointerdown',function(event){if(event.button!==0)return;var point=coordinates(event);if(!point)return;drag={id:event.pointerId,x:point.x,y:point.y};canvas.setPointerCapture(event.pointerId);canvas.classList.add('dragging')});canvas.addEventListener('pointermove',function(event){if(!drag||drag.id!==event.pointerId)return;var point=coordinates(event);if(!point)return;box[0]+=drag.x-point.x;box[1]+=drag.y-point.y;draw()});function stop(event){if(!drag||drag.id!==event.pointerId)return;drag=null;canvas.classList.remove('dragging');if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId)}canvas.addEventListener('pointerup',stop);canvas.addEventListener('pointercancel',stop);canvas.addEventListener('lostpointercapture',function(){drag=null;canvas.classList.remove('dragging')});
})});
})()</script></body></html>\n`;
}
//# sourceMappingURL=schedule-template.js.map