import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import test from 'node:test';
import { renderProject } from '../lib/engine/render.js';
import { closeScheduleViewer, openScheduleViewer } from '../lib/engine/schedule-server.js';

const at = '2026-10-12T00:00:00.000Z';
const id = name => '2026-10-12-' + name;
const localized = text => ({ zh: text, en: text });

function change(name, extra = {}) {
  return { schema_version: 1, id: id(name), title: localized(name), intent: localized('Schedule'),
    status: 'proposed', modules: {}, acceptance: ['Check'], schedule: { phase: 'P0' },
    revision: { before: null, after: null }, created_at: at, updated_at: at, ...extra };
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'normify-viewer-test-'));
  const directory = join(base, 'normify-demo');
  await mkdir(join(directory, 'modules'), { recursive: true });
  await mkdir(join(directory, 'changes'));
  t.after(async () => {
    await closeScheduleViewer();
    const target = resolve(base), rel = relative(resolve(tmpdir()), target);
    if (isAbsolute(rel) || rel.startsWith('..') || !basename(target).startsWith('normify-viewer-test-'))
      throw new Error('Unsafe viewer-test cleanup target.');
    await rm(target, { recursive: true, force: true });
  });
  const save = value => writeFile(join(directory, 'changes', value.id + '.json'), JSON.stringify(value));
  return { base, directory, save };
}

function http(url, options = {}) {
  return new Promise((accept, fail) => {
    const outgoing = request(url, options, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', value => { body += value; });
      response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body }));
    });
    outgoing.on('error', fail);
    outgoing.end();
  });
}

test('schedule render returns only a reusable live loopback URL without build artifacts', async t => {
  const { directory, save } = await fixture(t);
  await save(change('first', { title: localized('P0 Initial gate') }));
  const result = await renderProject(directory, { view: 'schedule' });
  assert.equal(result.ok, true);
  assert.equal(result.htmlPath, null);
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/schedule\/[A-Za-z0-9_-]{32}\/$/);
  assert.equal(result.summary.live, true);
  assert.equal(result.summary.planOk, true);
  assert.match(result.summary.contentHash, /^[a-f0-9]{64}$/);
  const again = await renderProject(directory, { view: 'schedule' });
  assert.equal(again.url, result.url);
  const initial = await http(result.url);
  assert.equal(initial.status, 200);
  assert.match(initial.body, /schema 1 · content [a-f0-9]{64}/);
  assert.match(initial.body, /Live schedule, not Git or product acceptance/);
  assert.match(initial.body, /data-graph-view="overview"/);
  assert.match(initial.body, /data-view="phase-0"/);
  await save(change('second', { title: localized('P1 Updated gate'), schedule: { phase: 'P1' } }));
  const fresh = await http(result.url);
  assert.match(fresh.body, /P1 Updated gate/);
  assert.notEqual(fresh.body.match(/content ([a-f0-9]{64})/)[1], initial.body.match(/content ([a-f0-9]{64})/)[1]);
  assert.ok((await readdir(directory)).every(name => !name.endsWith('.html')));
  for (const name of ['tree.json', 'receipt.json', 'schedule.json']) await assert.rejects(access(join(directory, name)));
});

test('live viewer escapes data, shows current errors, and never falls back to stale graphs', async t => {
  const { directory, save } = await fixture(t);
  const malicious = '</script><script>alert("schedule")</script><svg onload="alert(1)">';
  await save(change('unsafe', { title: localized(malicious), schedule: { phase: 'P0', owner: '<agent>' } }));
  const result = await openScheduleViewer(directory);
  const page = await http(result.url);
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes(malicious));
  assert.ok(!page.body.includes('<script>alert("schedule")</script>'));
  assert.match(page.body, /&lt;agent&gt;/);
  assert.match(page.headers['content-security-policy'], /script-src 'nonce-/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  await writeFile(join(directory, 'changes', id('broken') + '.json'), '{');
  const broken = await http(result.url);
  assert.equal(broken.status, 200);
  assert.match(broken.body, /Schedule errors prevent a valid dependency diagram/);
  assert.match(broken.body, /change\/json-parse/);
  assert.ok(!broken.body.includes('class="task-node'));
});

test('viewer rejects rebinding, cross-origin reads, mutating methods, and arbitrary paths', async t => {
  const { directory } = await fixture(t);
  const { url } = await openScheduleViewer(directory);
  const origin = new URL(url).origin;
  for (const headers of [{ Host: 'attacker.example' }, { Origin: 'https://attacker.example' },
    { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' }]) {
    assert.equal((await http(url, { headers })).status, 403);
  }
  assert.equal((await http(url, { headers: { Origin: origin } })).status, 200);
  assert.equal((await http(url, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } })).status, 200);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await http(url, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD');
    assert.ok(!response.headers['access-control-allow-origin']);
  }
  const head = await http(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  for (const path of ['/', '/tree.json', '/schedule/unknown/', '/schedule/../../package.json',
    new URL(url).pathname + '?file=package.json']) {
    assert.equal((await http(origin + path)).status, 404);
  }
});

test('real project aliases reuse a capability while different projects stay isolated', async t => {
  const { directory, base, save } = await fixture(t);
  await save(change('secret'));
  const first = await openScheduleViewer(directory);
  const alias = join(base, 'alias');
  try {
    await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('The platform does not permit project aliases.');
      return;
    }
    throw error;
  }
  assert.equal((await openScheduleViewer(alias)).url, first.url);
  const other = join(base, 'normify-other');
  await mkdir(join(other, 'modules'), { recursive: true });
  await mkdir(join(other, 'changes'));
  const second = await openScheduleViewer(other);
  assert.equal(new URL(first.url).origin, new URL(second.url).origin);
  assert.notEqual(first.url, second.url);
  assert.ok(!(await http(second.url)).body.includes(id('secret')));
});

test('HTTP reads wait for the same project lock used by MCP writes', async t => {
  const { directory, save } = await fixture(t);
  await save(change('before'));
  const { url } = await openScheduleViewer(directory);
  const actual = await realpath(directory), key = process.platform === 'win32' ? actual.toLowerCase() : actual;
  const target = join(tmpdir(), 'normify-mcp-project-locks', createHash('sha256').update(key).digest('hex'));
  await mkdir(target, { recursive: true });
  const release = await lockfile.lock(target);
  let finished = false;
  const response = http(url).then(value => { finished = true; return value; });
  try {
    await new Promise(accept => setTimeout(accept, 40));
    assert.equal(finished, false);
    await save(change('after'));
  } finally { await release(); }
  const page = await response;
  assert.equal(page.status, 200);
  assert.match(page.body, /2026-10-12-after/);
});

test('schedule rejects every explicit output filename while architecture stays compatible', async t => {
  const { directory } = await fixture(t);
  for (const out of ['', 'schedule.html', 'safe.html', '../outside.html']) {
    const rejected = await renderProject(directory, { view: 'schedule', out });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.errors[0].code, 'render/schedule-file-output');
  }
  await writeFile(join(directory, 'tree.json'), JSON.stringify({ project: { name: 'Demo', stats: {} }, modules: [] }));
  const architecture = await renderProject(directory, {});
  assert.equal(architecture.ok, true);
  assert.equal(architecture.htmlPath, join(directory, 'normify.html'));
  assert.equal(architecture.url, undefined);
  await assert.rejects(access(join(directory, 'schedule.html')));
});

class Element {
  constructor(dataset = {}) { this.dataset = dataset; this.listeners = new Map(); this.attributes = {}; this.hidden = false; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this.attributes[name] = value; }
  emit(name, event = {}) { this.listeners.get(name)?.call(this, event); }
}

function dom() {
  const elements = Object.fromEntries(['search', 'refresh', 'lang', 'theme'].map(id => [id, new Element()]));
  const canvas = new Element(), svg = new Element({ width: '1000', height: '500' });
  svg.attributes.viewBox = '0 0 1000 500';
  svg.getScreenCTM = () => ({ inverse() {
    const [x, y, w, h] = svg.attributes.viewBox.split(' ').map(Number);
    return { x, y, sx: w / 1000, sy: h / 500 };
  } });
  canvas.querySelector = () => svg;
  const classes = new Set();
  canvas.classList = { add: name => classes.add(name), remove: name => classes.delete(name),
    contains: name => classes.has(name), toggle(name) { classes.has(name) ? classes.delete(name) : classes.add(name); } };
  let captured;
  canvas.setPointerCapture = id => { captured = id; };
  canvas.hasPointerCapture = id => captured === id;
  canvas.releasePointerCapture = () => { captured = undefined; };
  const zoom = ['in', 'out', 'fit'].map(value => new Element({ zoom: value })), conflicts = new Element();
  canvas.previousElementSibling = { querySelectorAll: () => zoom, querySelector: () => conflicts };
  const buttons = ['overview', 'phase-0', 'full'].map(value => new Element({ view: value }));
  const graphs = ['overview', 'phase-0', 'full'].map(value => new Element({ graphView: value }));
  const zh = new Element({ language: 'zh' }), en = new Element({ language: 'en' });
  for (const section of [zh, en]) section.querySelectorAll = selector => selector === '[data-view]' ? buttons
    : selector === '[data-graph-view]' ? graphs : section === zh ? [canvas] : [];
  const document = { documentElement: { lang: 'zh', dataset: { theme: 'dark' } },
    getElementById: id => elements[id], querySelectorAll: selector => selector === '[data-language]' ? [zh, en] : [] };
  return { document, elements, canvas, svg, zoom, buttons, graphs, classes };
}

test('viewer JavaScript executes zoom, wheel, pointer-drag, reset, refresh, and view controls', async t => {
  const { directory, save } = await fixture(t);
  await save(change('interactive', { title: localized('P0 Interaction gate') }));
  const { url } = await openScheduleViewer(directory);
  const html = (await http(url)).body;
  const script = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/.exec(html)[1];
  const state = dom();
  let refreshed = false;
  class Point {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform(matrix) { return { x: matrix.x + this.x * matrix.sx, y: matrix.y + this.y * matrix.sy }; }
  }
  runInNewContext(script, { document: state.document, DOMPoint: Point, location: { reload() { refreshed = true; } } });
  const width = () => Number(state.svg.attributes.viewBox.split(' ')[2]);
  state.zoom[0].emit('click');
  assert.ok(width() < 1000);
  let prevented = false;
  state.canvas.emit('wheel', { deltaY: -1, clientX: 300, clientY: 100, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(width() < 800);
  const before = state.svg.attributes.viewBox;
  state.canvas.emit('pointerdown', { button: 0, pointerId: 1, clientX: 300, clientY: 100 });
  assert.ok(state.classes.has('dragging'));
  state.canvas.emit('pointermove', { pointerId: 1, clientX: 350, clientY: 125 });
  assert.notEqual(state.svg.attributes.viewBox, before);
  state.canvas.emit('pointerup', { pointerId: 1 });
  assert.ok(!state.classes.has('dragging'));
  state.zoom[2].emit('click');
  assert.equal(state.svg.attributes.viewBox, '0 0 1000 500');
  state.buttons[2].emit('click');
  assert.equal(state.graphs[0].hidden, true);
  assert.equal(state.graphs[2].hidden, false);
  assert.equal(state.buttons[2].attributes['aria-pressed'], 'true');
  state.elements.refresh.emit('click');
  assert.equal(refreshed, true);
});

test('stage graph retains external prerequisites without inventing phase dependencies', async t => {
  const { directory, save } = await fixture(t);
  await save(change('early', { title: localized('P8 Early work'), schedule: { phase: 'P8' } }));
  await save(change('late', { title: localized('P2 Dependent work'),
    schedule: { phase: 'P2', depends_on: [id('early')] } }));
  const { url } = await openScheduleViewer(directory);
  const page = (await http(url)).body;
  assert.match(page, /external prerequisite/);
  assert.match(page, /Phase labels do not impose sequential development/);
  assert.ok(page.includes(id('early') + ' → ' + id('late')));
  assert.ok(!page.includes(id('late') + ' → ' + id('early')));
});
