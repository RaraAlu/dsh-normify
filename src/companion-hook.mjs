import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import lockfile from 'proper-lockfile';

export const writeMatcher = '^(apply_patch|Edit|Write|write|edit|str_replace_editor|patch|multi_edit|create_file|insert|fs_write)$';
const writes = new RegExp(writeMatcher);
const digest = value => createHash('sha256').update(value).digest('hex');

function failed(response) {
  if (typeof response === 'string') return /^(error|failed|apply_patch verification failed)\b/i.test(response.trim());
  return !!response && (response.isError === true || response.error != null ||
    (typeof response.exit_code === 'number' && response.exit_code !== 0));
}

export async function companionReminder(input, { stateRoot, threshold = 8 }) {
  if (input?.hook_event_name !== 'PostToolUse' || !writes.test(input.tool_name ?? '') ||
      typeof input.session_id !== 'string' || !input.session_id ||
      typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || failed(input.tool_response)) return null;
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error('Invalid reminder threshold.');
  if (input.tool_name === 'apply_patch' && typeof input.tool_input?.command === 'string' &&
      !/\*\*\* (Add|Update|Delete) File: /.test(input.tool_input.command)) return null;

  const cwd = resolve(input.cwd);
  const key = digest(JSON.stringify([input.session_id, process.platform === 'win32' ? cwd.toLowerCase() : cwd]));
  const directory = join(resolve(stateRoot), key);
  await mkdir(directory, { recursive: true });
  const release = await lockfile.lock(directory, { realpath: false, retries: { retries: 30, minTimeout: 20, maxTimeout: 100 } });
  let due = false;
  try {
    const path = join(directory, 'counter.json');
    let state = { writes: 0, recentCalls: [] };
    try { state = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Number.isSafeInteger(state.writes) || state.writes < 0 || !Array.isArray(state.recentCalls)) {
      throw new Error('Invalid reminder state.');
    }
    const call = typeof input.tool_use_id === 'string' && input.tool_use_id ? digest(input.tool_use_id) : null;
    if (call && state.recentCalls.includes(call)) return null;
    state.writes++;
    due = state.writes >= threshold;
    if (due) state.writes = 0;
    if (call) state.recentCalls = [...state.recentCalls, call].slice(-64);
    state.updatedAt = new Date().toISOString();
    const temp = path + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(state) + '\n');
    await rename(temp, path);
  } finally { await release(); }
  if (!due) return null;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: [
    `[normify] 已完成${threshold}次编辑。`,
    '请核对源码与架构漂移。',
    '已有结构时调用normify_sync。',
    '随后按normify-dev收尾。',
    '用真实repoRoot定位源码。',
    '无结构时先确认生成需求。',
    '不要自动改写架构。',
    '不要扩大源码修改范围。',
    '不要伪造测试与验收。',
  ].join('\n') } };
}

async function main() {
  const { values } = parseArgs({ options: {
    'state-root': { type: 'string' }, threshold: { type: 'string', default: '8' },
    'expected-sha256': { type: 'string' },
  } });
  if (!values['state-root'] || !isAbsolute(values['state-root'])) throw new Error('Pass an absolute --state-root.');
  if (!values['expected-sha256'] || digest(await readFile(fileURLToPath(import.meta.url))) !== values['expected-sha256']) {
    throw new Error('Hook source changed; review and reinstall the hook.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Hook input exceeds 8 MiB.');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const output = await companionReminder(input, { stateRoot: values['state-root'], threshold: Number(values.threshold) });
  if (output) process.stdout.write(JSON.stringify(output) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // 提醒失败不阻断产品开发。
    process.stdout.write(JSON.stringify({ systemMessage: '[normify] 提醒钩子出错。请检查安装与状态。' }) + '\n');
    process.exitCode = 1;
  });
}
