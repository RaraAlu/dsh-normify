import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { collectTools } from '../src/catalog.mjs';
import { toolResult } from '../src/server.mjs';
import { adapterRoot } from './support.mjs';

test('all 31 original tools retain schemas and annotations', async () => {
  const source = await readFile(join(adapterRoot, 'lib', 'tools.js'), 'utf8');
  const names = [...source.matchAll(/register\('([^']+)'/g)].map(match => match[1]);
  const tools = collectTools({ rootDir: adapterRoot });
  assert.deepEqual(tools.map(tool => tool.name), names);
  assert.equal(tools.length, 31);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.annotations.readOnlyHint, tool.behavior === 'read');
    assert.equal(tool.annotations.destructiveHint, tool.behavior === 'destroy');
    assert.ok(!JSON.stringify(tool.inputSchema).includes('"required":true'));
  }
});

test('root parent allows null while nested required fields survive', () => {
  const tool = collectTools({ rootDir: adapterRoot }).find(tool => tool.name === 'normify_module_upsert');
  assert.deepEqual(tool.inputSchema.properties.frontmatter.properties.parent.type, ['string', 'null']);
  assert.ok(tool.inputSchema.properties.frontmatter.required.includes('parent'));
  assert.ok(tool.inputSchema.properties.frontmatter.required.includes('uid'));
  assert.equal(tool.validate({ frontmatter: {} }), false);
  assert.equal(tool.validate({ frontmatter: {}, unexpected: true }), false);
});

test('read-only mode exposes only read tools', () => {
  const tools = collectTools({ rootDir: adapterRoot, readOnly: true });
  assert.ok(tools.length > 0 && tools.length < 31);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
  assert.ok(!tools.some(tool => tool.name === 'normify_project_init'));
});

test('business failures keep details and set MCP isError', () => {
  const value = { ok: false, error: { code: 'test', message: 'details' } };
  const result = toolResult(value);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, value);
  assert.deepEqual(JSON.parse(result.content[0].text), value);
  assert.equal(toolResult('text').content[0].text, 'text');
  assert.equal(toolResult({ ok: true }).isError, false);
});
