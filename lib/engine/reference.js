/**
 * normify_help 的分主题参考文本（0.5.3 新增）：
 * 0.5.2 及以前 normify_help 只有一份固定速查、且完全忽略入参；实测中 AI 为了拿到
 * change_open / layout_upsert / change_close 的准确参数名，只能去读插件源码。
 * 现在按主题返回，未知主题会直接报错并列出可用主题（不再静默忽略）。
 */
import { fieldReference } from './frontmatter.js';
import { policyReference } from './policy.js';
import { DEP_KINDS } from './types.js';
export const HELP_TOPICS = ['fields', 'deps', 'renders', 'flow', 'schedule', 'tools', 'policy', 'errors', 'all'];
const DEPS_REFERENCE = [
    'deps（出向箭头，只存源端）条目：',
    '  { kind: ' + DEP_KINDS.join(' | ') + ', to: 目标模块 id（可跨树）, from_api?, to_api?, label?{zh,en} }',
    '**API 直连（0.5.3 强调）**：两端都声明了 API 时，请补 from_api / to_api —— 箭头才会钉在具体 API 行上；',
    '  不锚定则箭头只能落在框边，层级越深越看不清"谁调用了谁的哪个接口"。',
    '  · from_api 只能是**本模块** apis 里的键；to_api 只能是**目标模块自身** apis 里的键。',
    '  · API 键形式：http 为 "METHOD path"（如 GET /api/boards/:id）；其它 protocol 为 "protocol:path"。',
    '  · L2 validate 会给出聚合 warning `dep/unanchored`（列出可锚定却未锚定的箭头总数与前几条示例）。',
    '  · 未接箭头的 API 完全合法，不要为了消 warning 删 API。',
].join('\n');
const RENDERS_REFERENCE = [
    '渲染数据（renders/<id 点号换斜杠>.json，只有容器模块需要）：用 normify_layout_upsert 写，字段：',
    '  · mode: auto | layers | groups | grid（默认 auto：有 groups 用 groups，兄弟边多走 layers，否则 grid）',
    '  · max_columns: 1..6（grid / layers 模式的列数）',
    '  · max_api_rows: 0..48，**0 = 全部展开（缺省即 0）**；叶子 API 默认一行不折叠',
    '  · reading{zh,en}: 本层阅读导语（图上方显示，说明阅读顺序与分组逻辑）——建议每层都写',
    '  · order[]: 直接子模块的阅读顺序（建议覆盖全部子模块；未列出的按启发式追加并记 warning）',
    '  · groups[{id,title{zh,en},children[]}]: 分组（子模块不能重复分组；mode=groups 时至少要有一组）',
    '  · edge_hints[{from,to,kind?,lane?,style?,bundle?,priority?}]: 兄弟边的车道/样式/捆扎提示；from/to 必须是直接子模块且该兄弟边真实存在',
    '写入时机：骨架阶段就写第一版（order + reading 为主），实现过程中按实际复杂度复核。',
    'normify_render { view: "schedule" } 另渲染开发排程；默认 architecture 保留架构视图。',
].join('\n');
const SCHEDULE_REFERENCE = [
    '开发排程独立于架构调用。',
    'layout.order 只定义阅读顺序。',
    'schedule.depends_on 才定义前置。',
    'normify_change_open 可传可选 schedule 对象：',
    '  · depends_on?: string[]，前置变更 id；启动前须全部 verified。',
    '  · phase?: string，阶段标签；标签不自动增加前置。',
    '  · owner?: string，任务负责人；负责人不充当资源锁。',
    '  · files?: string[]，需独占修改的仓库相对文件路径。',
    '  · resources?: string[]，需独占的资源名，例如 gpu:0。',
    '  · priority?: number，候选优先级；不绕过前置与冲突。',
    '排程变更默认 proposed。',
    '旧无排程变更仍默认 in_progress。',
    '启动：normify_change_update { id, patch: { status: "in_progress" } }。',
    '启动前检查前置与隔离冲突。',
    'patch.schedule 整体替换排程。',
    '更新时不能删除既有排程。',
    '排程变更只能通过 change_close 标记 verified。',
    '架构收尾不代替产品测试。',
    '查询：normify_change_list { project, view: "schedule" }。',
    '该视图忽略 id/status 过滤。',
    '它保留完整前置集合。',
    '返回 tasks、ready、running、blocked、unscheduled、completed、waves、conflicts、errors、warnings、mermaid。',
    '任务 readiness 区分 ready / blocked / in_progress / verified / abandoned / unscheduled。',
    'normify_brief { project, include_schedule: true } 在 schedule 字段附完整排程。',
    'normify_render { project, view: "schedule" } 只返回本机交互 URL。',
    '排程不支持 out，不输出 HTML 文件。',
    '页面刷新读取实时输入，无需 build。',
    '仅用户明确要图时打开 URL。',
    '服务随 MCP 进程退出；失效时重新 render。',
    '候选波次不承诺时间或工期。',
    '并行任务必须隔离修改模块、文件与独占资源。',
    'GPU性能测试须独占资源。',
    '未登记的资源不保证隔离。',
    '未排程变更不进入候选波次。',
].join('\n');
const FLOW_REFERENCE = [
    '伴随开发主流程（先建图、后编码；每一步都可单独调用）：',
    '0) normify_project_init            初始化结构数据目录 + 默认架构规则（可选一步建"计划态根模块"）',
    '1) normify_change_open             开变更：意图 + 涉及模块(create/modify) + 验收标准(≥1)；写工具会自动建项目目录',
    '   可选 schedule 登记开发前置与隔离资源；排程默认 proposed，启动前查询 change_list { view: "schedule" }。',
    '2) normify_brief / normify_check   开发指引与设计预检（写代码前先跑，暴露缺模块/违规依赖）',
    '3) normify_module_batch            state=planned + fingerprint=pending 建**计划态**骨架（原子；叶子必须先声明 apis 契约）',
    '4) normify_layout_upsert           每个容器一层渲染数据（order + reading 起步）',
    '5) 排程任务先 update { patch: { status: "in_progress" } }，检查通过后实现；候选波次不承诺工期',
    '6) normify_module_refresh          ids=[...] + activate=true：落地模块转 active、重算 fingerprint/revision',
    '7) normify_validate                全项目 L2（要求 0 error；warning 尽量清零）',
    '8) normify_build → normify_render  冻结回执 + 单文件交互式 HTML',
    '9) normify_change_close            收尾（0 error 强制）：刷新 → 校验 → 编译 → 标记 verified',
    '常见坑：change_open 只接受**已存在**的模块 id；计划态叶子也要写 apis（可为 []）；批量写入是原子的，',
    '  一条 L1 失败会整批不落盘，连带错误用 dep/target-dropped 指出根因。',
].join('\n');
const ERRORS_REFERENCE = [
    '常见诊断码与修法（节选，完整表见 skills/normify-gen/SKILL.md）：',
    '  structure/uid-format             uid 必须是 8 位小写 hex（不要用 slug 派生）',
    '  structure/id-format              id 为小写点分路径，段名 ^[a-z][a-z0-9-]*$，深度不限',
    '  structure/parent-mismatch        parent 必须等于 id 去掉最后一段；根模块 parent=null',
    '  structure/label-too-long         name/description/label 的 zh ≤ 30 / en ≤ 30（description ≤ 500）',
    '  structure/fingerprint-invalid    fingerprint 用 normify_fingerprint 重算；planned 或空 source 才能填 pending',
    '  api/non-leaf                     只有叶子能声明 apis；容器/根要把 API 下放到叶子（晋升时会自动摘除并 warning）',
    '  api/leaf-missing                 叶子必须写 apis（可为空数组，会记 warning）',
    '  dep/target-missing               箭头 to 不存在（且**不是**因本批 L1 失败被丢弃）',
    '  dep/target-dropped               箭头 to 因本批 L1 失败被移出批次：根因见 evidence.root_cause_code（0.5.3）',
    '  dep/from-api-invalid             from_api 不在本模块 apis 里；to_api 同理必须在目标模块 apis 里',
    '  dep/unanchored                   两端都有 API 却未锚定：补 from_api/to_api（0.5.3，warning）',
    '  layout/order-child               order 只能列直接子模块 id（move 之后由工具自动重写）',
    '  layout/id-mismatch               渲染数据的 id 必须等于对应模块 id',
    '  evidence/source-missing          source 指向的文件在仓库里不存在（路径相对 repoRoot）',
    '  evidence/fingerprint-drift       结构数据过期：改完代码跑 normify_module_refresh 或 normify_change_close',
].join('\n');
export function topicReference(topic, catalog = []) {
    switch (topic) {
        case 'fields':
            return { title: '模块字段速查', text: fieldReference() };
        case 'deps':
            return { title: '依赖箭头与 API 直连', text: DEPS_REFERENCE };
        case 'renders':
            return { title: '渲染数据字段', text: RENDERS_REFERENCE };
        case 'flow':
            return { title: '伴随开发主流程', text: FLOW_REFERENCE };
        case 'schedule':
            return { title: '开发顺序与并行隔离', text: SCHEDULE_REFERENCE };
        case 'policy':
            return { title: '架构规则 policy.yml', text: policyReference() };
        case 'errors':
            return { title: '常见诊断码与修法', text: ERRORS_REFERENCE };
        case 'tools':
            return {
                title: '工具清单（' + catalog.length + ' 个）',
                text: [
                    catalog.map(t => {
                        const schema = (t.parameters ?? {});
                        const req = Array.isArray(schema.required) ? schema.required : [];
                        const props = Object.keys(schema.properties ?? {});
                        const opt = props.filter(x => !req.includes(x));
                        return t.name + ' [' + t.behavior + '] ' + t.description
                            + (props.length > 0 ? '\n      必填: ' + (req.length > 0 ? req.join(', ') : '（无）') + ' | 可选: ' + (opt.length > 0 ? opt.join(', ') : '（无）') : '');
                    }).join('\n'),
                    '',
                    '想看某个工具的完整参数树（类型/描述/必填）：normify_help { topic: "tool:<工具名>" }，例如 "tool:normify_module_batch"。',
                ].join('\n'),
            };
        case 'all':
            return {
                title: '全部参考',
                text: [
                    '=== fields ===', fieldReference(), '',
                    '=== deps ===', DEPS_REFERENCE, '',
                    '=== renders ===', RENDERS_REFERENCE, '',
                    '=== flow ===', FLOW_REFERENCE, '',
                    '=== schedule ===', SCHEDULE_REFERENCE, '',
                    '=== policy ===', policyReference(), '',
                    '=== errors ===', ERRORS_REFERENCE, '',
                    '=== tools ===', topicReference('tools', catalog).text,
                ].join('\n'),
            };
    }
}
/** 单个工具的完整参数树（help 的 `tool:<name>` 主题）。 */
export function toolReference(entry) {
    if (entry === undefined)
        return { title: '未知工具', text: '' };
    const schema = (entry.parameters ?? {});
    const props = schema.properties ?? {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const lines = [
        entry.name + '  [' + entry.behavior + ']',
        entry.description,
        '',
        '参数（* = 必填）：',
    ];
    const keys = Object.keys(props);
    if (keys.length === 0)
        lines.push('  （无参数）');
    for (const k of keys) {
        const prop = props[k] ?? {};
        lines.push('  ' + (required.has(k) ? '* ' : '  ') + k + ': ' + (prop.type ?? 'any') + (prop.description !== undefined ? ' — ' + prop.description : ''));
    }
    lines.push('', '提示：参数树由插件注册表实时生成，与运行时校验同源。');
    return { title: entry.name + ' 参数树', text: lines.join('\n') };
}
//# sourceMappingURL=reference.js.map