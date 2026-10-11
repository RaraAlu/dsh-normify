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
import { loadSchedulePlan } from '../lib/engine/schedule.js';
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
  assert.match(initial.body, /Live schedule, not (?:Git or )?product acceptance/);
  assert.match(initial.body, /id="graph-canvas"/);
  assert.match(initial.body, /id="view-overview"/);
  assert.match(initial.body, /id="view-phase"/);
  assert.match(initial.body, /id="phase-select"/);
  await save(change('second', { title: localized('P1 Updated gate'), schedule: { phase: 'P1' } }));
  const fresh = await http(result.url);
  assert.match(fresh.body, /P1 Updated gate/);
  assert.notEqual(fresh.body.match(/content ([a-f0-9]{64})/)[1], initial.body.match(/content ([a-f0-9]{64})/)[1]);
  assert.ok((await readdir(directory)).every(name => !name.endsWith('.html')));
  for (const name of ['tree.json', 'receipt.json', 'schedule.json']) await assert.rejects(access(join(directory, name)));
});

test('live viewer escapes data, shows current errors, and never falls back to stale graphs', async t => {
  const { directory, save } = await fixture(t);
  const malicious = '</script><script>alert("schedule")</script><svg onload="alert(1)">&\u2028\u2029';
  await save(change('unsafe', { title: localized(malicious), schedule: { phase: 'P0', owner: '<agent>' } }));
  const result = await openScheduleViewer(directory);
  const page = await http(result.url);
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes(malicious));
  assert.ok(!page.body.includes('<script>alert("schedule")</script>'));
  assert.match(page.body, /&lt;agent&gt;/);
  const rawData = scripts(page.body).find(script => /id="schedule-data"/.test(script.attributes));
  assert.ok(rawData, 'The viewer must carry escaped JSON task data.');
  assert.ok(!/[<>&\u2028\u2029]/.test(rawData.code));
  const payload = JSON.parse(rawData.code);
  assert.equal(tasksOf(payload).find(task => task.id === id('unsafe')).title.zh, malicious);
  const parsed = parseDocument(page.body);
  assert.equal(parsed.querySelectorAll('[onload]').length, 0);
  assert.equal(parsed.querySelectorAll('script').length, 2);
  const state = runViewer(page.body);
  const locate = state.element('locate-select');
  locate.value = id('unsafe'); locate.emit('change');
  const detail = state.element('detail-content').querySelectorAll('[data-detail-task]').find(node => !node.hidden);
  assert.ok(detail.textContent.includes(malicious));
  assert.equal(state.document.querySelectorAll('[onload]').length, 0);
  assert.match(page.headers['content-security-policy'], /script-src 'nonce-/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  await writeFile(join(directory, 'changes', id('broken') + '.json'), '{');
  const broken = await http(result.url);
  assert.equal(broken.status, 200);
  assert.match(broken.body, /Schedule errors prevent a valid dependency graph/);
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

function scripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .map(match => ({ attributes: match[1], code: match[2] }));
}

function tasksOf(payload) { return payload.tasks ?? payload.plan?.tasks ?? []; }

function decode(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
    const names = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    return names[entity] ?? String.fromCodePoint(entity.startsWith('&#x')
      ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1)));
  });
}

function matches(element, selector) {
  selector = selector.trim();
  const negatives = [...selector.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
  selector = selector.replace(/:not\([^)]+\)/g, '').replace(/:scope/g, '').trim();
  if (negatives.some(negative => matches(element, negative))) return false;
  const tag = /^([\w-]+|\*)/.exec(selector)?.[1];
  if (tag && tag !== '*' && tag.toLowerCase() !== element.tagName.toLowerCase()) return false;
  const elementId = /#([\w-]+)/.exec(selector)?.[1];
  if (elementId && element.id !== elementId) return false;
  for (const name of [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]))
    if (!element.classList.contains(name)) return false;
  for (const match of selector.matchAll(/\[([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)) {
    const value = match[2] ?? match[3] ?? match[4];
    if (!element.hasAttribute(match[1]) || value !== undefined && element.getAttribute(match[1]) !== value) return false;
  }
  return true;
}

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName; this.attributes = {}; this.children = []; this.listeners = new Map();
    this.style = {}; this.parentElement = null; this._text = ''; this._value = undefined; this.captured = new Set();
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute('data-' + String(key).replace(/[A-Z]/g, char => '-' + char.toLowerCase())) ?? undefined,
      set: (_, key, value) => { this.setAttribute('data-' + String(key).replace(/[A-Z]/g, char => '-' + char.toLowerCase()), value); return true; },
    });
    this.classList = {
      contains: name => (this.attributes.class ?? '').split(/\s+/).includes(name),
      add: (...names) => { this.attributes.class = [...new Set([...(this.attributes.class ?? '').split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.attributes.class = (this.attributes.class ?? '').split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const add = force === undefined ? !this.classList.contains(name) : force;
        this.classList[add ? 'add' : 'remove'](name); return add;
      },
    };
  }
  get id() { return this.attributes.id ?? ''; }
  set id(value) { this.attributes.id = value; }
  get lang() { return this.attributes.lang ?? ''; }
  set lang(value) { this.attributes.lang = value; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { value ? this.setAttribute('hidden', '') : this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { value ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }
  get checked() { return this.hasAttribute('checked'); }
  set checked(value) { value ? this.setAttribute('checked', '') : this.removeAttribute('checked'); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get value() { return this._value ?? this.attributes.value ?? (this.tagName === 'select' ? this.options[0]?.value ?? '' : ''); }
  set value(value) { this._value = String(value); }
  get options() { return this.children.filter(child => child.tagName === 'option'); }
  get selectedOptions() { return this.options.filter(option => option.value === this.value); }
  get previousElementSibling() {
    const index = this.parentElement?.children.indexOf(this) ?? -1;
    return this.parentElement?.children[index - 1] ?? null;
  }
  get clientWidth() { return this.id === 'graph-canvas' ? 1100 : 1100; }
  get clientHeight() { return this.id === 'graph-canvas' ? 700 : 700; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...children) {
    for (const child of children) {
      if (typeof child === 'string') { this._text += child; continue; }
      child.parentElement = this; this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) ?? []; callbacks.push(callback); this.listeners.set(name, callbacks);
  }
  emit(name, event = {}) {
    event.type ??= name; event.target ??= this; event.isPrimary ??= true;
    event.preventDefault ??= () => { event.defaultPrevented = true; };
    event.stopPropagation ??= () => { event.stopped = true; };
    for (let current = this; current; current = current.parentElement) {
      event.currentTarget = current;
      for (const callback of current.listeners.get(name) ?? []) callback.call(current, event);
      if (event.stopped) break;
    }
    return event;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    const result = [];
    const visit = element => {
      for (const child of element.children) {
        if (selectors.some(value => {
          const parts = value.split(/\s+>\s+|\s+(?=[^\]]*(?:\[|[\w.#]))/).filter(Boolean);
          if (parts.length === 1) return matches(child, value);
          if (!matches(child, parts.at(-1))) return false;
          let ancestor = child.parentElement;
          for (let index = parts.length - 2; index >= 0; index--) {
            while (ancestor && !matches(ancestor, parts[index])) ancestor = ancestor.parentElement;
            if (!ancestor) return false;
            ancestor = ancestor.parentElement;
          }
          return true;
        })) result.push(child);
        visit(child);
      }
    };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node; return null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  getBBox() {
    const [x, y, width, height] = (this.getAttribute('viewBox') ?? '0 0 1100 700').split(' ').map(Number);
    return { x, y, width, height };
  }
  getScreenCTM() {
    const [x, y, width, height] = (this.getAttribute('viewBox') ?? '0 0 1100 700').split(' ').map(Number);
    return { inverse: () => ({ x, y, sx: width / this.clientWidth, sy: height / this.clientHeight }) };
  }
  setPointerCapture(pointer) { this.captured.add(pointer); }
  hasPointerCapture(pointer) { return this.captured.has(pointer); }
  releasePointerCapture(pointer) { this.captured.delete(pointer); }
}

function parseDocument(html) {
  const root = new Element('document');
  const stack = [root];
  const tokens = /<!--[\s\S]*?-->|<![^>]*>|<\/?[\w:-]+\b[^>]*>|[^<]+/g;
  for (let match; (match = tokens.exec(html));) {
    const value = match[0];
    if (value.startsWith('<!')) continue;
    if (value.startsWith('</')) { stack.pop(); continue; }
    if (!value.startsWith('<')) { stack.at(-1)._text += decode(value); continue; }
    const name = /^<([\w:-]+)/.exec(value)[1];
    const element = new Element(name);
    for (const attribute of value.slice(name.length + 1, -1).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
      element.setAttribute(attribute[1], decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));
    stack.at(-1).append(element);
    if (name === 'script' || name === 'style') {
      const end = html.indexOf('</' + name, tokens.lastIndex);
      element._text = html.slice(tokens.lastIndex, end);
      tokens.lastIndex = html.indexOf('>', end) + 1;
    } else if (!/\/\s*>$/.test(value) && !['meta', 'link', 'input', 'br', 'hr', 'img'].includes(name)) stack.push(element);
  }
  root.documentElement = root.querySelector('html');
  root.body = root.querySelector('body');
  root.getElementById = id => root.querySelector('#' + id);
  root.createElement = name => new Element(name);
  root.createElementNS = (_, name) => new Element(name);
  return root;
}

function runViewer(html) {
  const document = parseDocument(html);
  let refreshed = false;
  class Point {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform(matrix) { return { x: matrix.x + this.x * matrix.sx, y: matrix.y + this.y * matrix.sy }; }
  }
  const window = new Element('window');
  const context = {
    document, window, Element, HTMLElement: Element, SVGElement: Element,
    DOMPoint: Point, CSS: { escape: value => String(value) },
    location: { reload() { refreshed = true; } },
    requestAnimationFrame: callback => { callback(); return 1; },
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout, clearTimeout, console,
  };
  Object.assign(window, { document, location: context.location, requestAnimationFrame: context.requestAnimationFrame });
  const executable = scripts(html).filter(script => !/type="application\/json"/.test(script.attributes));
  assert.equal(executable.length, 1);
  runInNewContext(executable[0].code, context, { timeout: 2000 });
  const element = id => { const value = document.getElementById(id); assert.ok(value, 'Missing viewer control: ' + id); return value; };
  const panel = () => element('graph-canvas').querySelectorAll('[data-graph-view]').find(node => !node.hidden);
  const svg = () => { const value = panel()?.querySelector('svg'); assert.ok(value, 'An active SVG is required.'); return value; };
  return { document, element, panel, svg, refreshed: () => refreshed };
}

async function interactiveFixture(t) {
  const f = await fixture(t);
  await f.save(change('history', { title: localized('Historic contract'), status: 'verified', closed_at: at, schedule: undefined }));
  await f.save(change('p0', { title: localized('P0 Scope gate'), status: 'verified', closed_at: at,
    schedule: { phase: 'P0', depends_on: [id('history')] } }));
  await f.save(change('p1', { title: localized('P1 Platform gate'), schedule: { phase: 'P1', depends_on: [id('p0')] } }));
  await f.save(change('work', { title: localized('G01@P1 Delivery'),
    schedule: { phase: 'P1', depends_on: [id('p1'), id('history')], resources: ['gpu'] } }));
  await f.save(change('occupied', { title: localized('Historical GPU occupancy'), status: 'in_progress',
    schedule: { phase: 'P0-历史待续', resources: ['gpu'] } }));
  await f.save(change('custom', { title: localized('Custom stage delivery'),
    schedule: { phase: 'custom-stage', depends_on: [id('p0')] } }));
  const plan = await loadSchedulePlan(f.directory);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  const { url } = await openScheduleViewer(f.directory);
  const html = (await http(url)).body;
  return { ...f, url, html, state: runViewer(html) };
}

test('graph-first layout keeps a full-height white canvas and responsive detail sidebar', async t => {
  const { html, state } = await interactiveFixture(t);
  assert.match(html, /(?:height|min-height)\s*:\s*100dvh/);
  assert.match(html, /310px/);
  assert.match(html, /@media[^{}]*max-width\s*:\s*700px/);
  assert.match(html, /35%/);
  const canvasCss = /#graph-canvas\s*\{([^}]+)\}/.exec(html)?.[1];
  assert.ok(canvasCss, 'The canvas must have its own layout rules.');
  assert.match(canvasCss, /background(?:-color)?\s*:\s*(?:#fff(?:fff)?\b|white\b)/);
  for (const id of ['schedule-shell', 'schedule-toolbar-row1', 'schedule-toolbar-row2',
    'view-overview', 'view-phase', 'view-full', 'phase-select', 'history-toggle',
    'zoom-in', 'zoom-out', 'zoom-percent', 'zoom-fit', 'zoom-actual', 'locate-select',
    'graph-canvas', 'detail-panel', 'detail-content', 'close-details', 'toggle-details']) state.element(id);
  assert.equal(state.element('view-overview').getAttribute('aria-pressed'), 'true');
  assert.equal(state.element('detail-panel').hidden, true);
  assert.equal(state.element('toggle-details').getAttribute('aria-pressed'), 'false');
  const phases = state.element('phase-select').options.map(option => option.textContent);
  assert.ok(phases.includes('P0') && phases.includes('P1'));
  assert.ok(phases.includes('P0-历史待续') && phases.includes('custom-stage'));
  state.element('toggle-details').emit('click');
  assert.equal(state.element('detail-panel').hidden, false);
  assert.equal(state.element('toggle-details').getAttribute('aria-pressed'), 'true');
  state.element('close-details').emit('click');
  assert.equal(state.element('detail-panel').hidden, true);
});

test('phase dropdown preserves arbitrary labels beside standard phases and real prerequisites', async t => {
  const { state } = await interactiveFixture(t);
  const select = state.element('phase-select');
  for (const [label, taskId] of [['custom-stage', id('custom')], ['P0-历史待续', id('occupied')]]) {
    const option = select.options.find(item => item.textContent === label);
    assert.ok(option, 'Missing phase: ' + label);
    select.value = option.value; select.emit('change');
    assert.equal(state.panel().dataset.graphView, 'phase-' + option.value);
    assert.ok(state.svg().querySelector('[data-task-id="' + taskId + '"]'));
    if (label === 'custom-stage') {
      const edges = state.svg().querySelectorAll('.prerequisite').map(edge => edge.querySelector('title')?.textContent);
      assert.ok(edges.includes(id('p0') + ' → ' + id('custom')));
    }
  }
});

test('viewer JavaScript executes zoom, wheel, pointer-drag, full reset, refresh, and all three modes', async t => {
  const { state } = await interactiveFixture(t);
  const width = () => Number(state.svg().getAttribute('viewBox').split(' ')[2]);
  const initial = state.svg().getAttribute('viewBox');
  const fullWidth = width();
  state.element('zoom-in').emit('click');
  assert.ok(width() < fullWidth);
  let prevented = false;
  state.element('graph-canvas').emit('wheel', { deltaY: -1, clientX: 300, clientY: 100,
    preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const before = state.svg().getAttribute('viewBox');
  const canvas = state.element('graph-canvas');
  canvas.emit('pointerdown', { button: 0, pointerId: 1, clientX: 300, clientY: 100 });
  canvas.emit('pointermove', { pointerId: 1, clientX: 350, clientY: 125 });
  assert.notEqual(state.svg().getAttribute('viewBox'), before);
  canvas.emit('pointerup', { pointerId: 1 });
  assert.equal(canvas.hasPointerCapture(1), false);
  state.element('zoom-fit').emit('click');
  assert.equal(state.svg().getAttribute('viewBox'), initial);
  state.element('zoom-actual').emit('click');
  assert.match(state.element('zoom-percent').textContent || state.element('zoom-percent').value, /100/);
  state.element('view-full').emit('click');
  assert.equal(state.panel().dataset.graphView, 'full');
  assert.equal(state.element('view-full').getAttribute('aria-pressed'), 'true');
  state.element('view-phase').emit('click');
  assert.match(state.panel().dataset.graphView, /^phase-/);
  state.element('view-overview').emit('click');
  assert.equal(state.panel().dataset.graphView, 'overview');
  state.element('refresh').emit('click');
  assert.equal(state.refreshed(), true);
  state.element('lang').emit('click');
  assert.equal(state.document.documentElement.lang, 'en');
  assert.equal(state.panel().dataset.language, 'en');
  const theme = state.document.documentElement.dataset.theme;
  state.element('theme').emit('click');
  assert.notEqual(state.document.documentElement.dataset.theme, theme);
});

test('gate activation opens its phase and details while dropdown navigation locates tasks', async t => {
  const { state } = await interactiveFixture(t);
  const gate = state.panel().querySelector('[data-task-id="' + id('p1') + '"]');
  assert.ok(gate);
  gate.emit('click');
  assert.equal(state.element('phase-select').selectedOptions[0].textContent, 'P1');
  assert.match(state.panel().dataset.graphView, /^phase-/);
  assert.equal(state.element('detail-panel').hidden, false);
  const details = state.element('detail-content');
  const visible = () => details.querySelectorAll('[data-detail-task]').filter(node => !node.hidden);
  assert.equal(visible().length, 1);
  assert.equal(visible()[0].dataset.detailTask, id('p1'));
  assert.equal(state.panel().querySelector('[data-task-id="' + id('p1') + '"]').focused, true);
  const locate = state.element('locate-select');
  locate.value = id('work'); locate.emit('change');
  assert.equal(visible()[0].dataset.detailTask, id('work'));
  assert.match(visible()[0].textContent, /P1 Platform gate/);
  assert.match(visible()[0].textContent, /Historical GPU occupancy/);
  assert.match(visible()[0].textContent, /登记状态|Recorded state/);
  assert.match(visible()[0].textContent, /此状态并非产品验收|This state is not product acceptance/);
  assert.match(state.document.textContent, /产品验收|product acceptance/);
  assert.ok(!visible()[0].textContent.includes('已验收'));
  locate.value = id('p0'); locate.emit('change');
  assert.ok(!visible()[0].textContent.includes('已验收'));
  locate.value = id('work'); locate.emit('change');
  state.element('close-details').emit('click');
  assert.equal(state.element('detail-panel').hidden, true);
  assert.equal(visible().length, 0);
  assert.equal(state.element('detail-empty').hidden, false);
  const task = state.panel().querySelector('[data-task-id="' + id('work') + '"]');
  const key = task.emit('keydown', { key: 'Enter' });
  assert.equal(key.defaultPrevented, true);
  assert.equal(state.element('detail-panel').hidden, false);
});

test('historical occupancy visibility never removes explicit prerequisite edges', async t => {
  const { state } = await interactiveFixture(t);
  state.element('view-full').emit('click');
  const svg = state.svg();
  const dependencies = svg.querySelectorAll('.prerequisite');
  assert.ok(dependencies.length >= 4);
  const titles = dependencies.map(edge => edge.querySelector('title')?.textContent ?? '').sort();
  assert.ok(titles.includes(id('history') + ' → ' + id('work')));
  const occupancy = state.element('history-toggle');
  for (const checked of [false, true, false]) {
    occupancy.checked = checked; occupancy.emit('change');
    assert.deepEqual(state.svg().querySelectorAll('.prerequisite').map(edge => edge.querySelector('title')?.textContent ?? '').sort(), titles);
  }
  const locate = state.element('locate-select');
  locate.value = id('work'); locate.emit('change');
  const detail = state.element('detail-content').querySelectorAll('[data-detail-task]').find(node => !node.hidden);
  const historical = detail.querySelector('[data-jump="' + id('history') + '"]');
  assert.ok(historical);
  historical.emit('click');
  assert.equal(state.element('locate-select').value, id('history'));
  assert.equal(state.panel().dataset.graphView, 'full');
});

test('pointer dragging cannot activate a node and cancelled captures stay recoverable', async t => {
  const { state } = await interactiveFixture(t);
  const gate = state.panel().querySelector('[data-task-id="' + id('p1') + '"]');
  const canvas = state.element('graph-canvas');
  gate.emit('pointerdown', { button: 0, pointerId: 7, clientX: 300, clientY: 100 });
  canvas.emit('pointermove', { pointerId: 7, clientX: 365, clientY: 155 });
  gate.emit('pointerup', { pointerId: 7, clientX: 365, clientY: 155 });
  gate.emit('click');
  assert.equal(state.panel().dataset.graphView, 'overview');
  assert.equal(state.element('detail-content').querySelectorAll('[data-detail-task]').filter(node => !node.hidden).length, 0);
  canvas.emit('pointerdown', { button: 0, pointerId: 8, clientX: 100, clientY: 100 });
  canvas.emit('pointercancel', { pointerId: 8 });
  assert.equal(canvas.hasPointerCapture(8), false);
  gate.emit('keydown', { key: ' ' });
  assert.match(state.panel().dataset.graphView, /^phase-/);
});

test('admission overview retains seventeen real gate nodes without adding phase-order edges', async t => {
  const { directory, save } = await fixture(t);
  const anchors = ['P0-CONTRACT', 'P0', 'P1', 'P2-HOST', 'P3-BASE', 'P2-UPLOAD',
    'P3', 'P4', 'P5', 'P6', 'P7', 'P8-ENTRY', 'P8-BASE', 'P8', 'P9', 'P10', 'P11'];
  for (let index = 0; index < anchors.length; index++) {
    const key = anchors[index];
    await save(change('gate-' + index, { title: localized(key + ' Gate'),
      schedule: { phase: key.split('-')[0], depends_on: index === 0 ? [] : [id('gate-' + (index - 1))] } }));
  }
  const { url } = await openScheduleViewer(directory);
  const state = runViewer((await http(url)).body);
  assert.equal(state.panel().dataset.graphView, 'overview');
  const nodes = state.svg().querySelectorAll('[data-task-id]');
  assert.equal(nodes.length, 17);
  const edges = state.svg().querySelectorAll('.prerequisite');
  assert.equal(edges.length, 16);
  const edgeTitles = edges.map(edge => edge.querySelector('title')?.textContent ?? '');
  for (let index = 1; index < anchors.length; index++)
    assert.ok(edgeTitles.includes(id('gate-' + (index - 1)) + ' → ' + id('gate-' + index)));
  const p11 = nodes.find(node => node.dataset.taskId === id('gate-16'));
  assert.equal(p11.getAttribute('role'), 'button');
  assert.equal(p11.getAttribute('tabindex'), '0');
});

test('stage graph retains external prerequisites without inventing phase dependencies', async t => {
  const { directory, save } = await fixture(t);
  await save(change('early', { title: localized('P8 Early work'), schedule: { phase: 'P8' } }));
  await save(change('late', { title: localized('P2 Dependent work'),
    schedule: { phase: 'P2', depends_on: [id('early')] } }));
  const { url } = await openScheduleViewer(directory);
  const page = (await http(url)).body;
  assert.match(page, /external prerequisite/);
  assert.match(page, /Phase numbers do not impose serial development/);
  assert.ok(page.includes(id('early') + ' → ' + id('late')));
  assert.ok(!page.includes(id('late') + ' → ' + id('early')));
});
