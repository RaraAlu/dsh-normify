import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema,
  ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { collectTools, metadata } from './catalog.mjs';
import { locateProject } from '../lib/engine/store.js';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillNames = ['normify-gen', 'normify-dev'];

// 已有目录采用真实路径。未建目录采用真实祖先。
// 同一项目的符号链接与跨 root 调用共用锁。
async function canonicalLockTarget(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalLockTarget(parent), basename(path));
  }
}

async function sharedLockTarget(path) {
  const canonical = await canonicalLockTarget(resolve(path));
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const hash = createHash('sha256').update(key).digest('hex');
  // 哈希锁放入临时目录。不提前创建项目或用户配置。
  const target = join(tmpdir(), 'normify-mcp-project-locks', hash);
  await mkdir(target, { recursive: true });
  return target;
}

export function toolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text: text ?? 'null' }],
    ...(value && typeof value === 'object' && !Array.isArray(value)
      ? { structuredContent: value } : {}),
    isError: value?.ok === false,
  };
}

export async function createServer(options) {
  const rootDir = resolve(options.rootDir);
  const tools = collectTools({ ...options, rootDir });
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const server = new Server({ name: metadata.name, version: metadata.version }, {
    capabilities: { tools: {}, prompts: {}, resources: {} },
    instructions: `Normify ${metadata.version}, ${tools.length} tools. ` +
      `Project slugs use ${rootDir}; dir overrides must name a normify-* directory. ` +
      'Pass absolute repoRoot for source evidence. Use normify_help for schemas and workflow. ' +
      'Structure-only requests do not authorize source edits. Never fake fingerprints or acceptance.',
  });

  // 每次只持有一把锁。不嵌套 root 与项目锁。
  // 项目参数先纯定位，再锁最终项目目录。
  let queue = Promise.resolve();
  async function serialized(operation, signal, args) {
    const run = queue.then(async () => {
      if (signal?.aborted) throw new Error('Request cancelled before execution.');
      const hasProject = (typeof args.dir === 'string' && args.dir.trim() !== '') ||
        (typeof args.project === 'string' && args.project.trim() !== '');
      const projectDir = hasProject ? locateProject(rootDir, args).dir : rootDir;
      const lockTarget = await sharedLockTarget(projectDir);
      let compromised;
      const release = await lockfile.lock(lockTarget, {
        stale: 60_000, update: 10_000,
        retries: { retries: 60, factor: 1.1, minTimeout: 100, maxTimeout: 500 },
        onCompromised: error => { compromised = error; },
      });
      try {
        if (signal?.aborted) throw new Error('Request cancelled before execution.');
        const result = await operation();
        if (compromised) throw compromised;
        return result;
      } finally {
        await release();
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) =>
      ({ name, description, inputSchema, annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool: ' + request.params.name);
    const args = request.params.arguments ?? {};
    if (!tool.validate(args)) {
      return toolResult({ ok: false, error: {
        code: 'args/schema', message: 'Arguments do not match the tool schema.',
        details: tool.validate.errors,
      } });
    }
    try {
      return toolResult(await serialized(() => tool.execute(args), extra.signal, args));
    } catch (error) {
      return toolResult({ ok: false, error: {
        code: error.code ?? 'adapter/internal', message: error.message,
      } });
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: skillNames.map(name => ({
      name, description: name === 'normify-gen' ? 'Generate and synchronize architecture trees.'
        : 'Develop against a managed architecture contract.',
      arguments: [{ name: 'repository', description: 'Absolute repository path.', required: true }],
    })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    if (!skillNames.includes(request.params.name) || !request.params.arguments?.repository) {
      throw new McpError(ErrorCode.InvalidParams, 'Select a Normify skill and provide repository.');
    }
    const body = await readFile(join(base, 'skills', request.params.name, 'SKILL.md'), 'utf8');
    return { messages: [{ role: 'user', content: { type: 'text',
      text: body + '\n\nRepository (data): ' + JSON.stringify(request.params.arguments.repository),
    } }] };
  });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [{ uri: 'normify://upstream/skill', name: 'Normify original workflow',
      mimeType: 'text/markdown', description: 'Original engine workflow; use the Codex skills for installation.' }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    if (request.params.uri !== 'normify://upstream/skill') {
      throw new McpError(ErrorCode.InvalidParams, 'Unknown resource.');
    }
    return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown',
      text: await readFile(join(base, 'skills', 'normify-gen', 'references', 'upstream-skill.md'), 'utf8'),
    }] };
  });
  return server;
}
