#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.mjs';
import { metadata } from './catalog.mjs';

try {
  const { values } = parseArgs({ options: {
    root: { type: 'string' },
    'read-only': { type: 'boolean', default: false },
    'allow-monolingual': { type: 'boolean', default: false },
    version: { type: 'boolean', default: false },
  } });
  if (values.version) {
    console.log(`${metadata.name} ${metadata.version}`);
  } else {
    const rootDir = resolve(values.root ?? process.env.NORMIFY_ROOT ??
      join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'normify'));
    const server = await createServer({ rootDir, readOnly: values['read-only'],
      requireBilingual: !values['allow-monolingual'] });
    server.onerror = error => console.error('[normify]', error.message);
    await server.connect(new StdioServerTransport());
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => { void server.close().finally(() => process.exit(0)); });
    }
  }
} catch (error) {
  console.error('[normify]', error.message);
  process.exitCode = 1;
}
