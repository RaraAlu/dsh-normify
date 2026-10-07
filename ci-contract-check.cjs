const assert = require('node:assert/strict');
const fs = require('node:fs');
const p = require('./package.json');
assert.equal(p.name, 'normify-codex');
assert.ok(p.bin['normify-mcp']);
assert.ok(p.bin['normify-install']);
assert.equal(p.peerDependencies, undefined, 'Codex must not depend on a DSH host');
for (const entry of Object.values(p.bin)) assert.ok(fs.existsSync(entry), 'Missing entry: ' + entry);
const source = fs.readFileSync('lib/tools.js', 'utf8');
const names = [...source.matchAll(/register\('([^']+)'/g)].map(match => match[1]);
assert.equal(names.length, 31);
assert.equal(new Set(names).size, 31);
for (const name of names) assert.match(name, /^[a-zA-Z0-9_-]+$/);
for (const name of ['normify_project_init', 'normify_help', 'normify_module_batch']) {
  assert.ok(names.includes(name), 'Missing tool: ' + name);
}
for (const name of ['normify-gen', 'normify-dev']) {
  const skill = fs.readFileSync(`skills/${name}/SKILL.md`, 'utf8');
  assert.ok(skill.startsWith('---'));
  assert.ok(skill.includes('name: ' + name));
  assert.ok(fs.existsSync(`skills/${name}/agents/openai.yaml`));
}
console.log('Codex package and 31-tool contract passed.');
