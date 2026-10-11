#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { collectProgressReport } from '../src/progress-report.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, project: { type: 'string' },
  dir: { type: 'string' }, 'repo-root': { type: 'string' }, evidence: { type: 'string', multiple: true } } });
try {
  const report = await collectProgressReport({ rootDir: values.root, project: values.project, dir: values.dir,
    repoRoot: values['repo-root'], evidencePaths: values.evidence ?? [] });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.consistent) process.exitCode = 1;
} catch (error) {
  process.stderr.write('[normify progress] ' + error.message + '\n');
  process.exitCode = 1;
}
