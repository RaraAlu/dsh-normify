import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema,
  ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { collectTools, metadata } from './catalog.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillNames = ['normify-gen', 'normify-dev'];

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

  // 排队并跨进程加锁。
  // 避免读写交错破坏结构数据。
  let queue = Promise.resolve();
  async function serialized(operation, signal) {
    const run = queue.then(async () => {
      if (signal?.aborted) throw new Error('Request cancelled before execution.');
      await mkdir(rootDir, { recursive: true });
      let compromised;
      const release = await lockfile.lock(rootDir, {
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
      return toolResult(await serialized(() => tool.execute(args), extra.signal));
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
