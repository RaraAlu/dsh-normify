import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { installProgressHook } from '../scripts/install-progress-hook.mjs';
import { connectCodex } from '../scripts/codex-rpc.mjs';
import { collectTools } from '../src/catalog.mjs';
import { fixture, localized, testCodex } from './support.mjs';
import { mockModel, modelCatalog } from './mock-model.mjs';

async function contents(root) {
  const result = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path, name + '/');
      else result.push([name, createHash('sha256').update(await readFile(path)).digest('hex')]);
    }
  }
  await visit(root);
  return result.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

// 只转发本机响应夹具，记录实际模型输入。
async function captureModel(upstream) {
  assert.equal(new URL(upstream).hostname, '127.0.0.1');
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push(JSON.parse(body));
      const result = await fetch(new URL(request.url, upstream), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body });
      response.writeHead(result.status, { 'content-type': 'text/event-stream' });
      response.end(await result.text());
    } catch (error) {
      response.writeHead(500);
      response.end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

async function setup(t) {
  let cleanupFixture;
  const ctx = await fixture({ after: cleanup => { cleanupFixture = cleanup; } });
  let model, capture, rpc;
  t.after(async () => {
    await rpc?.close();
    await capture?.close();
    await model?.close();
    await cleanupFixture();
  });
  const repo = join(ctx.base, 'demo');
  assert.equal(dirname(ctx.repo), ctx.base);
  assert.equal(dirname(repo), ctx.base);
  await rename(ctx.repo, repo);
  const codexHome = join(ctx.base, 'progress-runtime-home');
  await mkdir(codexHome);
  const root = join(codexHome, 'normify');
  const tools = collectTools({ rootDir: root });
  const call = async (name, args) => {
    const result = await tools.find(tool => tool.name === name).execute({ project: 'demo', ...args });
    assert.notEqual(result.ok, false, JSON.stringify(result));
    return result;
  };
  await call('normify_project_init', { root: { id: 'demo', name: localized('演示'), description: localized('测试') } });
  await call('normify_change_open', { id: '2026-10-12-runtime-first', title: localized('第一步'),
    intent: localized('隔离测试'), modules: {}, acceptance: ['实际目标验收'],
    schedule: { phase: 'P0', files: ['src/existing.rs'] } });
  await installProgressHook({ executable: testCodex, codexHome, cwd: repo, trustInstalled: true });
  model = await mockModel(0);
  capture = await captureModel(model.url);
  const catalog = join(ctx.base, 'progress-model-catalog.json');
  await writeFile(catalog, JSON.stringify(modelCatalog));
  rpc = await connectCodex(testCodex, { cwd: repo, codexHome, captureDiagnostics: true, extraConfig: [
    'model="normify-fixture"', 'model_provider="normify_test"', `model_catalog_json=${JSON.stringify(catalog)}`,
    `model_providers.normify_test={name="Normify fixture",base_url=${JSON.stringify(capture.url)},wire_api="responses",requires_openai_auth=false}`,
  ] });
  const started = await rpc.request('thread/start', { cwd: repo, ephemeral: true,
    approvalPolicy: 'never', sandbox: 'danger-full-access' });
  return { repo, directory: join(root, 'normify-demo'), rpc, threadId: started.thread.id, model, capture };
}

async function turn(ctx, prompt) {
  const offset = ctx.rpc.notifications.length;
  const requestOffset = ctx.capture.requests.length;
  await ctx.rpc.request('turn/start', { threadId: ctx.threadId, input: [{ type: 'text', text: prompt }] });
  const deadline = Date.now() + 30_000;
  while (!ctx.rpc.notifications.slice(offset).some(event => event.method === 'turn/completed') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const events = ctx.rpc.notifications.slice(offset);
  assert.ok(events.some(event => event.method === 'turn/completed'), JSON.stringify(events));
  assert.ok(!events.some(event => event.method === 'error'), JSON.stringify(events));
  const completed = events.filter(event => event.method === 'hook/completed' && event.params.run.eventName === 'userPromptSubmit');
  assert.equal(completed.length, 1, JSON.stringify(events));
  assert.equal(completed[0].params.run.status, 'completed', JSON.stringify(completed));
  const contexts = completed.flatMap(event => event.params.run.entries).filter(entry => entry.kind === 'context');
  return { contexts, requests: ctx.capture.requests.slice(requestOffset) };
}

function modelInput(requests) {
  return requests.flatMap(request => request.input ?? []).flatMap(item => {
    if (typeof item.content === 'string') return [item.content];
    return (item.content ?? []).map(part => part.text ?? '');
  }).join('\n');
}

test('native UserPromptSubmit injects current progress JSON without edits or browser requests',
  { skip: !testCodex, timeout: 60_000 }, async t => {
    const ctx = await setup(t);
    const before = { repo: await contents(ctx.repo), project: await contents(ctx.directory) };
    const { contexts, requests } = await turn(ctx, '汇报当前开发进度');
    assert.equal(contexts.length, 1);
    const text = contexts[0].text;
    const json = text.split('\n').find(line => line.startsWith('{'));
    assert.ok(json, text);
    const report = JSON.parse(json);
    assert.equal(report.read_only, true);
    assert.equal(report.consistent, true);
    assert.equal(report.project, 'demo');
    assert.equal(report.repository, ctx.repo);
    assert.equal(report.tasks[0].id, '2026-10-12-runtime-first');
    assert.equal(report.tasks[0].task_status, 'proposed');
    assert.equal(report.tasks[0].acceptance.status, 'not_verified');
    assert.match(text, /不要调用渲染或打开网页/);
    assert.ok(!text.includes('调用normify_render'));
    assert.match(modelInput(requests), /只读进展流程/);
    assert.ok(modelInput(requests).includes(report.snapshot_id));
    assert.ok(modelInput(requests).includes('2026-10-12-runtime-first'));
    assert.equal(ctx.model.calls(), 1);
    assert.deepEqual(ctx.model.toolResults, []);
    assert.deepEqual({ repo: await contents(ctx.repo), project: await contents(ctx.directory) }, before);
  });

test('irrelevant and negative prompts emit no progress context on the native lifecycle',
  { skip: !testCodex, timeout: 60_000 }, async t => {
    const ctx = await setup(t);
    const before = { repo: await contents(ctx.repo), project: await contents(ctx.directory) };
    for (const prompt of ['请解释Rust借用规则', '不要汇报当前开发进度']) {
      const { contexts, requests } = await turn(ctx, prompt);
      assert.deepEqual(contexts, []);
      assert.ok(!modelInput(requests).includes('只读进展流程'));
      assert.ok(!modelInput(requests).includes('snapshot_id'));
      assert.ok(!modelInput(requests).includes('调用normify_render'));
    }
    assert.equal(ctx.model.calls(), 2);
    assert.deepEqual(ctx.model.toolResults, []);
    assert.deepEqual({ repo: await contents(ctx.repo), project: await contents(ctx.directory) }, before);
  });
