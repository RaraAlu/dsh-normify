import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (entry.name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', path]);
  }
}
for (const dir of ['src', 'scripts', 'tests']) await check(join(root, dir));
console.log('JavaScript syntax checks passed.');
