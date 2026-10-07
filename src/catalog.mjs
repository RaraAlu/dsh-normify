import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
export const toolCount = 31;
const { registerTools } = await import('../lib/tools.js');

function normalizeSchema(node) {
  if (!node || typeof node !== 'object') return;
  // 上游执行器允许根 parent 为 null。
  // 修正声明，不改变引擎语义。
  if (node.properties?.parent?.type === 'string') {
    node.properties.parent.type = ['string', 'null'];
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(normalizeSchema);
    else normalizeSchema(child);
  }
}

export function collectTools({ rootDir, requireBilingual = true, readOnly = false }) {
  const registrations = [];
  registerTools({ tools: { register: tool => registrations.push(tool) } },
    { rootDir, requireBilingual });
  if (registrations.length !== toolCount ||
      new Set(registrations.map(tool => tool.name)).size !== toolCount) {
    throw new Error('Unexpected Normify tool catalog. Run npm run build.');
  }
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
  return registrations.filter(tool => !readOnly || tool.readOnly).map(tool => {
    const inputSchema = structuredClone(tool.parameters ?? { type: 'object', properties: {} });
    normalizeSchema(inputSchema);
    return {
      ...tool,
      inputSchema,
      validate: ajv.compile(inputSchema),
      annotations: {
        readOnlyHint: tool.readOnly,
        destructiveHint: tool.destructive,
        idempotentHint: tool.idempotent,
        openWorldHint: false,
      },
    };
  });
}
