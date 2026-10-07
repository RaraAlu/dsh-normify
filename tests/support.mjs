import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveCodex } from '../scripts/cli.mjs';

export const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const testCodex = (() => {
  try {
    const cli = resolveCodex(process.env.NORMIFY_TEST_CODEX);
    return cli.args.length ? null : cli.command;
  } catch { return null; }
})();

export async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'normify-codex-test-'));
  t.after(async () => {
    const path = resolve(base);
    const rel = relative(resolve(tmpdir()), path);
    if (isAbsolute(rel) || rel.startsWith('..') || !basename(path).startsWith('normify-codex-test-')) {
      throw new Error('Unsafe test cleanup target.');
    }
    await rm(path, { recursive: true, force: true });
  });
  const root = join(base, 'storage');
  const repo = join(base, 'space 仓库');
  await mkdir(join(repo, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Normify test');
  await writeFile(join(repo, 'src', 'existing.rs'), 'pub fn existing() {}\n');
  git('add', '.');
  git('commit', '-qm', 'test fixture');
  return { base, root, repo, git };
}

export async function connect(t, root, args = []) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(adapterRoot, 'src', 'stdio.mjs'), '--root', root, ...args], stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data; });
  const client = new Client({ name: 'normify-adapter-test', version: '1.0.0' });
  t.after(async () => { await client.close(); });
  try { await client.connect(transport); }
  catch (error) { throw new Error(`${error.message}\n${stderr}`, { cause: error }); }
  return { client, transport, stderr: () => stderr };
}

export const localized = text => ({ zh: text, en: text });
export function unpack(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
