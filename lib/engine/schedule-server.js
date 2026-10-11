import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { loadSchedulePlan } from './schedule.js';
import { renderScheduleTemplate } from './schedule-template.js';
import { sha256Text } from './store.js';
const IDLE_MS = 30 * 60 * 1000;
let viewer;
const lockfile = createRequire(import.meta.url)('proper-lockfile');
async function lockedPage(entry) {
    const key = process.platform === 'win32' ? entry.projectDir.toLowerCase() : entry.projectDir;
    // 与MCP共享同一项目锁。HTTP只读也不能穿过批量写入。
    const target = join(tmpdir(), 'normify-mcp-project-locks', sha256Text(key));
    await mkdir(target, { recursive: true });
    let compromised;
    const release = await lockfile.lock(target, { stale: 60_000, update: 10_000,
        retries: { retries: 60, factor: 1.1, minTimeout: 100, maxTimeout: 500 },
        onCompromised: error => { compromised = error; } });
    try {
        const page = await currentPage(entry);
        if (compromised)
            throw compromised;
        return page;
    }
    finally {
        await release();
    }
}
/** 每次读取当前排程。不把内容指纹当Git或产品验收。 */
async function currentPage(entry) {
    const plan = await loadSchedulePlan(entry.projectDir);
    const contentHash = sha256Text(JSON.stringify(plan));
    const name = basename(entry.projectDir).replace(/^normify-/, '') || 'project';
    const stats = {
        tasks: plan.tasks.length, ready: plan.ready.length, running: plan.running.length,
        blocked: plan.blocked.length, errors: plan.errors.length, warnings: plan.warnings.length,
    };
    const nonce = randomBytes(24).toString('base64url');
    const html = renderScheduleTemplate(plan, { name, stats, compiledAt: '', treeSha12: '' }, { ...entry.options, live: true, contentHash, nonce });
    return { html, nonce, summary: { name, stats, view: 'schedule', live: true,
            schemaVersion: plan.schema_version, planOk: plan.ok, contentHash } };
}
function headers(response, nonce) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; "
        + (nonce ? "script-src 'nonce-" + nonce + "'; " : "script-src 'none'; ")
        + "frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}
function reject(response, status, message) {
    headers(response);
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(message);
}
function touch(state) {
    if (state.idle)
        clearTimeout(state.idle);
    state.idle = setTimeout(() => { void closeScheduleViewer(); }, IDLE_MS);
    state.idle.unref();
}
async function startViewer() {
    const entries = new Map();
    const projects = new Map();
    let state;
    const server = createServer((request, response) => {
        void (async () => {
            const address = request.socket.remoteAddress;
            if (address !== '127.0.0.1' && address !== '::ffff:127.0.0.1')
                return reject(response, 403, 'Loopback requests only.');
            // 拒绝DNS重绑定与跨源读取。能力URL不提供任意文件路由。
            if (request.headers.host !== new URL(state.origin).host)
                return reject(response, 403, 'Invalid Host.');
            if (request.headers.origin !== undefined && request.headers.origin !== state.origin)
                return reject(response, 403, 'Cross-origin requests are not allowed.');
            if (request.headers['sec-fetch-site'] === 'cross-site'
                && request.headers['sec-fetch-mode'] !== 'navigate')
                return reject(response, 403, 'Cross-site reads are not allowed.');
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                response.setHeader('Allow', 'GET, HEAD');
                return reject(response, 405, 'Read-only viewer.');
            }
            const url = new URL(request.url ?? '/', state.origin);
            if (url.origin !== state.origin || url.search !== '')
                return reject(response, 404, 'Unknown viewer.');
            const match = /^\/schedule\/([A-Za-z0-9_-]{32})\/$/.exec(url.pathname);
            const entry = match ? entries.get(match[1]) : undefined;
            if (!entry)
                return reject(response, 404, 'Unknown viewer.');
            touch(state);
            const page = await lockedPage(entry);
            headers(response, page.nonce);
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(request.method === 'HEAD' ? undefined : page.html);
        })().catch(() => {
            if (!response.headersSent)
                reject(response, 503, 'Unable to read the current schedule.');
            else
                response.destroy();
        });
    });
    await new Promise((accept, fail) => {
        server.once('error', fail);
        // 只绑定IPv4回环。端口交给系统选择，不探测或占用固定端口。
        server.listen(0, '127.0.0.1', () => { server.off('error', fail); accept(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Viewer did not receive a TCP port.');
    state = { server, origin: 'http://127.0.0.1:' + address.port, entries, projects };
    // 查看器随MCP退出。它不维持后台进程，也不启动浏览器。
    server.unref();
    touch(state);
    return state;
}
/** 同一进程与真实项目路径复用URL；响应始终重读源数据。 */
export async function openScheduleViewer(projectDir, options = {}) {
    const actual = await realpath(projectDir);
    const key = process.platform === 'win32' ? actual.toLowerCase() : actual;
    const state = await (viewer ??= startViewer().catch(error => { viewer = undefined; throw error; }));
    let entry = state.projects.get(key);
    if (!entry) {
        entry = { projectDir: actual, token: randomBytes(24).toString('base64url'), options };
        state.projects.set(key, entry);
        state.entries.set(entry.token, entry);
    }
    else
        entry.options = options;
    touch(state);
    // normify_render已持有项目锁；此处不嵌套锁，避免死锁。
    const page = await currentPage(entry);
    return { url: state.origin + '/schedule/' + entry.token + '/', bytes: Buffer.byteLength(page.html),
        sha256: null, summary: page.summary };
}
/** 供进程收尾与测试使用；不增加MCP工具。 */
export async function closeScheduleViewer() {
    const current = viewer;
    viewer = undefined;
    if (!current)
        return;
    const state = await current;
    if (state.idle)
        clearTimeout(state.idle);
    await new Promise((accept, fail) => {
        state.server.close(error => error ? fail(error) : accept());
        state.server.closeAllConnections();
    });
}
//# sourceMappingURL=schedule-server.js.map