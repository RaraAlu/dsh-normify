import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { sha256Text } from './store.js';
import { renderTemplate } from './template.js';
import { openScheduleViewer } from './schedule-server.js';
import { diag } from './diag.js';
/** 输出只写项目内文件。真实父路径和符号链接也须守住该边界。 */
async function safeOutputPath(projectDir, filename) {
    if (isAbsolute(filename) || win32.isAbsolute(filename) || /[:\x00-\x1f]/.test(filename))
        throw new Error('out 必须为项目内相对路径');
    const root = resolve(projectDir);
    const out = resolve(root, filename.replace(/\\/g, '/'));
    const rel = relative(root, out);
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
        throw new Error('out 不得逃出结构目录');
    const actualRoot = await realpath(root);
    const actualParent = await realpath(dirname(out));
    const parentRel = relative(actualRoot, actualParent);
    if (parentRel === '..' || parentRel.startsWith('..' + sep) || isAbsolute(parentRel))
        throw new Error('out 父目录不得指向结构目录外');
    try {
        if ((await lstat(out)).isSymbolicLink())
            throw new Error('out 不得覆盖符号链接');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    return out;
}
/** 架构保留文件输出；实时排程只返回本地能力URL。 */
export async function renderProject(projectDir, opts) {
    const errors = [];
    const warnings = [];
    if (opts.view !== undefined && opts.view !== 'architecture' && opts.view !== 'schedule') {
        return { ok: false, htmlPath: null, bytes: 0, sha256: null, summary: null,
            errors: [diag('error', 'render/view', 'view 必须为 architecture 或 schedule', {}, {}, [])], warnings };
    }
    if (opts.view === 'schedule') {
        if (opts.out !== undefined)
            return { ok: false, htmlPath: null, bytes: 0, sha256: null, summary: null,
                errors: [diag('error', 'render/schedule-file-output', '排程只提供本地URL，不接受out文件输出', {}, {}, [])], warnings };
        try {
            const result = await openScheduleViewer(projectDir, opts);
            return { ok: true, htmlPath: null, ...result, errors, warnings };
        }
        catch (error) {
            return { ok: false, htmlPath: null, bytes: 0, sha256: null, summary: null,
                errors: [diag('error', 'render/viewer-failed', '本地排程服务启动失败：' + String(error), {}, {}, [])], warnings };
        }
    }
    let treeText;
    try {
        treeText = await readFile(join(projectDir, 'tree.json'), 'utf8');
    }
    catch {
        return {
            ok: false,
            htmlPath: null,
            bytes: 0,
            sha256: null,
            summary: null,
            errors: [diag('error', 'render/no-build', '缺少 tree.json 编译产物', {}, {}, ['先运行 normify_build'])],
            warnings,
        };
    }
    let tree;
    try {
        tree = JSON.parse(treeText);
    }
    catch (error) {
        return {
            ok: false,
            htmlPath: null,
            bytes: 0,
            sha256: null,
            summary: null,
            errors: [diag('error', 'render/bad-tree', 'tree.json 解析失败：' + String(error), {}, {}, ['重新运行 normify_build'])],
            warnings,
        };
    }
    const project = (tree.project ?? {});
    const stats = (project.stats ?? {});
    const name = String(project.name ?? 'project');
    const summary = {
        name,
        stats,
        compiledAt: String(project.compiled_at ?? ''),
        treeSha12: sha256Text(treeText).slice(0, 12),
        lang: opts.lang ?? '',
        theme: opts.theme ?? '',
    };
    const html = renderTemplate(treeText, { name, stats, compiledAt: summary.compiledAt, treeSha12: summary.treeSha12 });
    let out;
    try {
        out = await safeOutputPath(projectDir, opts.out && opts.out.trim() !== ''
            ? opts.out : 'normify.html');
    }
    catch (error) {
        return { ok: false, htmlPath: null, bytes: 0, sha256: null, summary,
            errors: [diag('error', 'render/unsafe-out', '输出路径不安全：' + String(error), {}, {}, ['使用结构目录内相对文件名'])], warnings };
    }
    try {
        await writeFile(out, html, 'utf8');
    }
    catch (error) {
        return {
            ok: false,
            htmlPath: null,
            bytes: 0,
            sha256: null,
            summary,
            errors: [diag('error', 'render/write-failed', 'HTML 写入失败：' + String(error), { out }, {}, [])],
            warnings,
        };
    }
    return { ok: true, htmlPath: out, bytes: Buffer.byteLength(html, 'utf8'), sha256: sha256Text(html), summary, errors, warnings };
}
//# sourceMappingURL=render.js.map