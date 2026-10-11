import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { readCodegraphEvidence } from '../src/progress-codegraph.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
let sqlite;
try { sqlite = await import('node:sqlite'); } catch { /* 旧Node仅跳过SQLite夹具。 */ }
const sqlTest = (name, fn) => test(name, { skip: !sqlite }, fn);

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'normify-codegraph-test-'));
  const repo = join(base, 'repo');
  await mkdir(repo);
  t.after(async () => {
    const absolute = resolve(base);
    const rel = relative(resolve(tmpdir()), absolute);
    assert(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'));
    assert(basename(absolute).startsWith('normify-codegraph-test-'));
    await rm(absolute, { recursive: true, force: true });
  });
  return { base, repo, dbPath: join(repo, '.codegraph', 'codegraph.db') };
}

async function database(f, records = [], options = {}) {
  await mkdir(join(f.repo, '.codegraph'));
  const db = new sqlite.DatabaseSync(f.dbPath);
  db.exec(`
    CREATE TABLE schema_versions (version INTEGER PRIMARY KEY);
    INSERT INTO schema_versions VALUES (5);
    CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE files (path TEXT PRIMARY KEY, content_hash TEXT, indexed_at INTEGER);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, qualified_name TEXT, kind TEXT,
      file_path TEXT, start_line INTEGER, end_line INTEGER);
  `);
  const meta = db.prepare('INSERT INTO project_metadata VALUES (?, ?)');
  if (!options.noMetadata) {
    meta.run('indexed_with_version', '1.0.1');
    meta.run('indexed_with_extraction_version', String(options.extractionVersion ?? 24));
  }
  for (const record of records) {
    const bytes = typeof record.content === 'string' ? Buffer.from(record.content) : record.content;
    await mkdir(join(f.repo, record.path, '..'), { recursive: true });
    if (!record.missing) await writeFile(join(f.repo, record.path), bytes);
    db.prepare('INSERT INTO files VALUES (?, ?, ?)')
      .run(record.path, record.hash ?? hash(bytes.toString('utf8')), 1_800_000_000_000);
    for (let index = 0; index < (record.symbols ?? 2); index++) {
      db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        `${record.path}:${index}`, `symbol${index}`, `scope.symbol${index}`, 'function', record.path, index + 1, index + 2);
    }
  }
  db.close();
}

function hasDiagnostic(result, code) {
  return result.diagnostics.some(diagnostic => diagnostic.code === code);
}

async function graphSnapshot(dbPath) {
  const directory = join(dbPath, '..');
  const snapshot = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const stat = await lstat(path);
    snapshot.push({ name, size: stat.size, mtimeMs: stat.mtimeMs, hash: hash(await readFile(path)) });
  }
  return snapshot;
}

test('missing graph stays unknown and never creates an index', async t => {
  const f = await fixture(t);
  const before = await readdir(f.repo);
  const result = await readCodegraphEvidence(f.repo, ['src/example.mjs']);
  assert.equal(result.available, false);
  assert.equal(result.index.freshness, 'unknown');
  assert.equal(result.read_only, true);
  assert(hasDiagnostic(result, 'codegraph/missing-db'));
  assert.deepEqual(await readdir(f.repo), before);
});

test('invalid input degrades without throwing or indexing', async () => {
  for (const [root, paths] of [['relative/path', []], [null, []], [resolve(tmpdir()), null]]) {
    const result = await readCodegraphEvidence(root, paths);
    assert.equal(result.index.freshness, 'unknown');
    assert(hasDiagnostic(result, 'codegraph/invalid-input'));
  }
});

sqlTest('scoped hashes and symbol evidence stay deterministic and read-only', async t => {
  const f = await fixture(t);
  await database(f, [{ path: 'src/a.mjs', content: 'export function a() {}\n' }]);
  const before = hash(await readFile(f.dbPath));
  const entries = await readdir(join(f.repo, '.codegraph'));
  const first = await readCodegraphEvidence(f.repo, ['src/a.mjs']);
  const second = await readCodegraphEvidence(f.repo, ['src/a.mjs']);
  assert.deepEqual(second, first);
  assert.equal(first.available, true);
  assert.equal(first.index.freshness, 'fresh');
  assert.equal(first.index.scope, 'requested_files');
  assert.equal(first.index.global_freshness, 'unknown');
  assert.equal(first.index.extractor_freshness, 'unknown');
  assert.equal(first.files[0].freshness, 'fresh');
  assert.equal(first.files[0].symbols.length, 2);
  assert.equal(first.files[0].symbols[0].start_line, 1);
  assert.equal(first.files[0].raw_sha256, hash(await readFile(join(f.repo, 'src/a.mjs'))));
  assert.equal(hash(await readFile(f.dbPath)), before);
  assert.deepEqual(await readdir(join(f.repo, '.codegraph')), entries);
  for (const key of ['progress', 'percentage', 'completion_percent']) assert(!Object.hasOwn(first, key));
});

sqlTest('content drift marks symbols stale without refreshing the graph', async t => {
  const f = await fixture(t);
  await database(f, [{ path: 'src/a.mjs', content: 'old\n' }]);
  const before = hash(await readFile(f.dbPath));
  await writeFile(join(f.repo, 'src/a.mjs'), 'new\n');
  const result = await readCodegraphEvidence(f.repo, ['src/a.mjs']);
  assert.equal(result.index.freshness, 'stale');
  assert.equal(result.files[0].freshness, 'stale');
  assert.notEqual(result.files[0].current_hash, result.files[0].indexed_hash);
  assert.equal(result.files[0].symbols.length, 2);
  assert.equal(hash(await readFile(f.dbPath)), before);
});

sqlTest('CodeGraph UTF-8 content hashes differ from raw byte hashes', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0xff, 0x61, 0x0a]);
  await database(f, [{ path: 'src/a.mjs', content: bytes }]);
  const result = await readCodegraphEvidence(f.repo, ['src/a.mjs']);
  assert.equal(result.files[0].freshness, 'fresh');
  assert.equal(result.files[0].current_hash, hash(bytes.toString('utf8')));
  assert.equal(result.files[0].raw_sha256, hash(bytes));
  assert.notEqual(result.files[0].raw_sha256, result.files[0].current_hash);
});

sqlTest('old schemas remain unknown without migration writes', async t => {
  const f = await fixture(t);
  await mkdir(join(f.repo, '.codegraph'));
  const db = new sqlite.DatabaseSync(f.dbPath);
  db.exec('CREATE TABLE files (path TEXT PRIMARY KEY, content_hash TEXT, indexed_at INTEGER)');
  db.close();
  const before = hash(await readFile(f.dbPath));
  const result = await readCodegraphEvidence(f.repo, ['src/a.mjs']);
  assert.equal(result.index.freshness, 'unknown');
  assert(hasDiagnostic(result, 'codegraph/unsupported-schema'));
  assert.equal(hash(await readFile(f.dbPath)), before);
});

sqlTest('missing SQLite support does not block or repair the graph', async t => {
  const f = await fixture(t);
  await database(f);
  const before = hash(await readFile(f.dbPath));
  const result = await readCodegraphEvidence(f.repo, [], { sqlite: null });
  assert.equal(result.available, false);
  assert.equal(result.index.freshness, 'unknown');
  assert(hasDiagnostic(result, 'codegraph/sqlite-unavailable'));
  assert.equal(hash(await readFile(f.dbPath)), before);
});

sqlTest('directory prefixes are bounded and never imply complete coverage', async t => {
  const f = await fixture(t);
  await database(f, [
    { path: 'src/a.mjs', content: 'a' }, { path: 'src/b.mjs', content: 'b' },
    { path: 'srcx/other.mjs', content: 'outside prefix' },
  ]);
  await writeFile(join(f.repo, 'src/unindexed.mjs'), 'not indexed');
  const limited = await readCodegraphEvidence(f.repo, ['src/'], { maxFiles: 1 });
  assert.deepEqual(limited.files.map(file => file.path), ['src/a.mjs']);
  assert.equal(limited.index.freshness, 'unknown');
  assert.equal(limited.index.limited, true);
  assert(hasDiagnostic(limited, 'codegraph/file-limit'));
  const expanded = await readCodegraphEvidence(f.repo, ['src']);
  assert.deepEqual(expanded.files.map(file => file.path), ['src/a.mjs', 'src/b.mjs']);
  assert(expanded.files.every(file => file.freshness === 'fresh'));
  assert.equal(expanded.index.freshness, 'unknown');
  assert(hasDiagnostic(expanded, 'codegraph/directory-partial'));
});

sqlTest('unsafe requested and indexed paths never read outside the repository', async t => {
  const f = await fixture(t);
  await database(f);
  const result = await readCodegraphEvidence(f.repo, ['../outside', '/absolute', 'C:/outside', 'src/*', 'src/../file']);
  assert.equal(result.index.freshness, 'unknown');
  assert.equal(result.files.length, 0);
  assert.equal(result.diagnostics.filter(diagnostic => diagnostic.code === 'codegraph/unsafe-path').length, 5);
});

sqlTest('missing index rows are unknown while deleted indexed files are stale', async t => {
  const f = await fixture(t);
  await database(f, [{ path: 'src/deleted.mjs', content: 'old', missing: true }]);
  const unindexed = await readCodegraphEvidence(f.repo, ['src/new.mjs']);
  assert.equal(unindexed.files[0].freshness, 'unknown');
  assert(hasDiagnostic(unindexed, 'codegraph/unindexed-file'));
  const deleted = await readCodegraphEvidence(f.repo, ['src/deleted.mjs']);
  assert.equal(deleted.files[0].freshness, 'stale');
  assert.equal(deleted.index.freshness, 'stale');
});

sqlTest('symbol and source size caps preserve unknown and limited evidence', async t => {
  const f = await fixture(t);
  await database(f, [{ path: 'src/a.mjs', content: '0123456789', symbols: 25 }]);
  const capped = await readCodegraphEvidence(f.repo, ['src/a.mjs']);
  assert.equal(capped.files[0].symbols.length, 20);
  assert.equal(capped.files[0].symbols_limited, true);
  const oversized = await readCodegraphEvidence(f.repo, ['src/a.mjs'], { maxFileBytes: 4 });
  assert.equal(oversized.index.freshness, 'unknown');
  assert.equal(oversized.files[0].current_hash, null);
  assert(hasDiagnostic(oversized, 'codegraph/source-size-limit'));
});

sqlTest('missing provenance or an old extractor cannot claim freshness', async t => {
  const f = await fixture(t);
  await database(f, [{ path: 'src/a.mjs', content: 'a' }], { noMetadata: true });
  const result = await readCodegraphEvidence(f.repo, ['src/a.mjs']);
  assert.equal(result.files[0].freshness, 'fresh');
  assert.equal(result.index.freshness, 'unknown');
  assert(hasDiagnostic(result, 'codegraph/missing-provenance'));
  const other = await fixture(t);
  await database(other, [{ path: 'src/a.mjs', content: 'a' }], { extractionVersion: 23 });
  const stale = await readCodegraphEvidence(other.repo, ['src/a.mjs'], { expectedExtractionVersion: 24 });
  assert.equal(stale.index.extractor_freshness, 'stale');
  assert.equal(stale.index.freshness, 'stale');
});

sqlTest('corrupt databases and missing WAL shared files remain unknown', async t => {
  const f = await fixture(t);
  await mkdir(join(f.repo, '.codegraph'));
  await writeFile(f.dbPath, 'not sqlite');
  const before = hash(await readFile(f.dbPath));
  const corrupt = await readCodegraphEvidence(f.repo, ['src/a.mjs']);
  assert.equal(corrupt.index.freshness, 'unknown');
  assert(hasDiagnostic(corrupt, 'codegraph/read-failed'));
  assert.equal(hash(await readFile(f.dbPath)), before);
  const other = await fixture(t);
  await database(other);
  await writeFile(other.dbPath + '-wal', 'pending');
  const snapshot = await graphSnapshot(other.dbPath);
  const wal = await readCodegraphEvidence(other.repo, []);
  assert.equal(wal.index.freshness, 'unknown');
  assert(hasDiagnostic(wal, 'codegraph/wal-unavailable'));
  assert.deepEqual(await readdir(join(other.repo, '.codegraph')), ['codegraph.db', 'codegraph.db-wal']);
  assert.deepEqual(await graphSnapshot(other.dbPath), snapshot);
});

sqlTest('active WAL stays unopened and preserves database and sidecar bytes and mtimes', async t => {
  const f = await fixture(t);
  await database(f, [{ path: 'src/a.mjs', content: 'a' }]);
  const writer = new sqlite.DatabaseSync(f.dbPath);
  try {
    writer.exec("PRAGMA journal_mode=WAL; UPDATE project_metadata SET value='1.0.2' WHERE key='indexed_with_version'");
    const snapshot = await graphSnapshot(f.dbPath);
    assert.deepEqual(snapshot.map(file => file.name), ['codegraph.db', 'codegraph.db-shm', 'codegraph.db-wal']);
    let opens = 0;
    const result = await readCodegraphEvidence(f.repo, ['src/a.mjs'], {
      sqlite: { DatabaseSync: class { constructor() { opens++; throw new Error('must not open'); } } },
    });
    assert.equal(opens, 0);
    assert.equal(result.available, false);
    assert.equal(result.index.freshness, 'unknown');
    assert(hasDiagnostic(result, 'codegraph/wal-unavailable'));
    assert.deepEqual(await graphSnapshot(f.dbPath), snapshot);
  } finally { writer.close(); }
});

sqlTest('idle WAL mode without sidecars stays unopened and never creates them', async t => {
  const f = await fixture(t);
  await database(f);
  const writer = new sqlite.DatabaseSync(f.dbPath);
  writer.exec("PRAGMA journal_mode=WAL; UPDATE project_metadata SET value='1.0.2' WHERE key='indexed_with_version'");
  writer.close();
  const snapshot = await graphSnapshot(f.dbPath);
  assert.deepEqual(snapshot.map(file => file.name), ['codegraph.db']);
  let opens = 0;
  const result = await readCodegraphEvidence(f.repo, [], {
    sqlite: { DatabaseSync: class { constructor() { opens++; throw new Error('must not open'); } } },
  });
  assert.equal(opens, 0);
  assert.equal(result.index.freshness, 'unknown');
  assert(hasDiagnostic(result, 'codegraph/wal-unavailable'));
  assert.deepEqual(await graphSnapshot(f.dbPath), snapshot);
});

sqlTest('orphan shared memory also stays unopened and preserves bytes and mtimes', async t => {
  const f = await fixture(t);
  await database(f);
  await writeFile(f.dbPath + '-shm', 'orphan shared memory');
  const snapshot = await graphSnapshot(f.dbPath);
  let opens = 0;
  const result = await readCodegraphEvidence(f.repo, [], {
    sqlite: { DatabaseSync: class { constructor() { opens++; throw new Error('must not open'); } } },
  });
  assert.equal(opens, 0);
  assert.equal(result.index.freshness, 'unknown');
  assert(hasDiagnostic(result, 'codegraph/wal-unavailable'));
  assert.deepEqual(await graphSnapshot(f.dbPath), snapshot);
});

sqlTest('external graph junctions remain unknown without opening the external database', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  await database(other);
  try {
    await symlink(await realpath(join(other.repo, '.codegraph')), join(f.repo, '.codegraph'),
      process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Directory links unavailable');
    throw error;
  }
  const before = await graphSnapshot(other.dbPath);
  const result = await readCodegraphEvidence(f.repo, []);
  assert.equal(result.available, false);
  assert.equal(result.index.freshness, 'unknown');
  assert(hasDiagnostic(result, 'codegraph/unsafe-db'));
  assert.deepEqual(await graphSnapshot(other.dbPath), before);
});

sqlTest('internal graph directory junctions also stay unopened and unknown', async t => {
  const f = await fixture(t);
  const internal = { repo: join(f.repo, 'internal'), dbPath: join(f.repo, 'internal', '.codegraph', 'codegraph.db') };
  await mkdir(internal.repo);
  await database(internal);
  try {
    await symlink(await realpath(join(internal.repo, '.codegraph')), join(f.repo, '.codegraph'),
      process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Directory links unavailable');
    throw error;
  }
  const snapshot = await graphSnapshot(internal.dbPath);
  let opens = 0;
  const result = await readCodegraphEvidence(f.repo, [], {
    sqlite: { DatabaseSync: class { constructor() { opens++; throw new Error('must not open'); } } },
  });
  assert.equal(opens, 0);
  assert.equal(result.available, false);
  assert.equal(result.index.freshness, 'unknown');
  assert(hasDiagnostic(result, 'codegraph/unsafe-db'));
  assert.deepEqual(await graphSnapshot(internal.dbPath), snapshot);
});
