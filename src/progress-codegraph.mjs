import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const bounded = (value, fallback, maximum) => Number.isInteger(value) && value > 0
  ? Math.min(value, maximum) : fallback;
const inside = (root, path) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
};
function cleanPath(value) {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  const path = value.replaceAll('\\', '/').replace(/\/$/, '');
  if (!path || isAbsolute(path) || /^[a-z]:/i.test(path) || /[:*?\[\]{}\x00-\x1f]/.test(path)) return null;
  return path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ? null : path;
}

/**
 * 只读适配现有 SQLite 表。
 * 文件新鲜度只覆盖请求范围。
 * 目录仅展开索引中的路径。
 * 本模块不判断任务完成率。
 */
export async function readCodegraphEvidence(repoRoot, paths = [], options = {}) {
  if (!options || typeof options !== 'object') options = {};
  const result = {
    schema_version: 1,
    read_only: true,
    available: false,
    repo_root: typeof repoRoot === 'string' ? resolve(repoRoot) : null,
    db_path: null,
    index: {
      freshness: 'unknown', scope: 'requested_files', global_freshness: 'unknown',
      schema_version: null, last_indexed_at: null, built_with_version: null,
      extraction_version: null, extractor_freshness: 'unknown', content_fingerprint: null,
      hash_algorithm: 'sha256:utf8-decoded-reencoded', limited: false,
    },
    files: [],
    diagnostics: [],
  };
  const report = (code, message, path) => result.diagnostics.push({ code, message, ...(path ? { path } : {}) });
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot) || !Array.isArray(paths)) {
    report('codegraph/invalid-input', '要求绝对仓库路径与文件数组');
    return result;
  }
  const maxFiles = bounded(options.maxFiles, 100, 1000);
  const maxSymbols = bounded(options.maxSymbolsPerFile, 20, 200);
  const maxBytes = bounded(options.maxFileBytes, 2 * 1024 * 1024, 32 * 1024 * 1024);
  let db;
  let transaction = false;
  try {
    const root = await realpath(repoRoot);
    result.repo_root = root;
    const dbPath = join(root, '.codegraph', 'codegraph.db');
    result.db_path = dbPath;
    const databaseStat = await lstat(dbPath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!databaseStat) {
      report('codegraph/missing-db', '图谱不存在；不自动初始化');
      return result;
    }
    const graphStat = await lstat(join(root, '.codegraph'));
    const actualDb = await realpath(dbPath);
    if (!graphStat.isDirectory() || graphStat.isSymbolicLink() || !databaseStat.isFile() || !inside(root, actualDb)) {
      report('codegraph/unsafe-db', '拒绝图谱目录链接或异常文件');
      return result;
    }
    // 只读连接仍可能改写既有 SHM。
    // 保守跳过全部 WAL，不打开数据库。
    const sidecars = await Promise.all(['-wal', '-shm'].map(suffix => lstat(dbPath + suffix).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })));
    if (sidecars.some(Boolean)) {
      report('codegraph/wal-unavailable', 'WAL只读边界不明；保留未知');
      return result;
    }
    // 关闭连接后，WAL 模式仍留在主文件头。
    // 只读前二十字节，不让 SQLite 创建旁文件。
    const file = await open(actualDb, 'r');
    let header;
    try {
      header = Buffer.alloc(20);
      await file.read(header, 0, header.length, 0);
    } finally { await file.close(); }
    if (header.subarray(0, 16).toString('latin1') === 'SQLite format 3\0'
      && (header[18] === 2 || header[19] === 2)) {
      report('codegraph/wal-unavailable', '图谱保留WAL模式；不打开SQLite');
      return result;
    }
    let sqlite;
    try {
      sqlite = options.sqlite === undefined ? await import('node:sqlite') : options.sqlite;
      if (typeof sqlite?.DatabaseSync !== 'function') throw new Error('DatabaseSync unavailable');
    } catch {
      report('codegraph/sqlite-unavailable', '当前运行时不支持只读SQLite');
      return result;
    }
    db = new sqlite.DatabaseSync(actualDb, { readOnly: true, enableExtensions: false });
    db.exec('BEGIN');
    transaction = true;
    result.available = true;
    const expected = {
      files: ['path', 'content_hash', 'indexed_at'],
      nodes: ['id', 'name', 'qualified_name', 'kind', 'file_path', 'start_line', 'end_line'],
      project_metadata: ['key', 'value'],
      schema_versions: ['version'],
    };
    for (const [table, columns] of Object.entries(expected)) {
      const actual = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
      if (!columns.every(column => actual.has(column))) {
        report('codegraph/unsupported-schema', '旧图谱缺少必要表或字段', table);
        return result;
      }
    }
    const version = db.prepare('SELECT MAX(version) AS version FROM schema_versions').get()?.version;
    result.index.schema_version = Number.isInteger(version) ? version : null;
    if (!Number.isInteger(version) || version < 1 || version > 5) {
      report('codegraph/unsupported-schema-version', '图谱版本超出已核实范围');
      return result;
    }
    const metadata = db.prepare('SELECT key, value FROM project_metadata ORDER BY key').all();
    const meta = new Map(metadata.map(row => [row.key, row.value]));
    result.index.built_with_version = meta.get('indexed_with_version') ?? null;
    const extraction = meta.get('indexed_with_extraction_version');
    result.index.extraction_version = /^\d+$/.test(extraction ?? '') ? Number(extraction) : null;
    const currentExtraction = options.expectedExtractionVersion;
    if (Number.isInteger(currentExtraction) && result.index.extraction_version !== null) {
      result.index.extractor_freshness = result.index.extraction_version < currentExtraction ? 'stale'
        : result.index.extraction_version === currentExtraction ? 'fresh' : 'unknown';
    }
    let uncertain = !result.index.built_with_version || result.index.extraction_version === null;
    if (uncertain) report('codegraph/missing-provenance', '图谱缺少提取器版本证据');
    const latest = db.prepare('SELECT MAX(indexed_at) AS indexed_at FROM files').get()?.indexed_at;
    if (Number.isFinite(latest) && !Number.isNaN(new Date(latest).valueOf())) {
      result.index.last_indexed_at = new Date(latest).toISOString();
    }
    const requests = [...new Set(paths.map(cleanPath).filter(path => path !== null))].sort();
    for (const path of paths.filter(path => cleanPath(path) === null)) {
      uncertain = true;
      report('codegraph/unsafe-path', '拒绝不安全的声明路径', String(path));
    }
    const selected = new Map();
    for (const path of requests) {
      if (selected.size >= maxFiles) {
        result.index.limited = true;
        uncertain = true;
        report('codegraph/file-limit', '文件证据超过读取上限');
        break;
      }
      const target = resolve(root, path);
      const stat = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      const actual = stat ? await realpath(target) : target;
      if (!inside(root, actual)) {
        uncertain = true;
        report('codegraph/path-escape', '拒绝仓库外声明路径', path);
        continue;
      }
      if (stat?.isDirectory()) {
        // 只读排序查询，避免遍历整库文档。
        const prefix = path + '/';
        const remaining = maxFiles - selected.size;
        const rows = db.prepare('SELECT path, content_hash, indexed_at FROM files WHERE path >= ? AND path < ? ORDER BY path LIMIT ?')
          .all(prefix, path + '0', remaining + 1);
        uncertain = true;
        report('codegraph/directory-partial', '目录仅展开已有索引文件', path);
        if (rows.length > remaining) {
          result.index.limited = true;
          report('codegraph/file-limit', '目录索引展开达到上限', path);
        }
        for (const row of rows.slice(0, remaining)) selected.set(row.path, row);
        if (!rows.length) report('codegraph/unindexed-directory', '目录没有可查询的索引文件', path);
      } else {
        const row = db.prepare('SELECT path, content_hash, indexed_at FROM files WHERE path = ?').get(path);
        selected.set(path, row ?? null);
      }
    }
    const symbolQuery = db.prepare('SELECT id, name, qualified_name, kind, start_line, end_line FROM nodes WHERE file_path = ? ORDER BY start_line, end_line, id LIMIT ?');
    for (const [path, row] of [...selected.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const evidence = {
        path, freshness: 'unknown', indexed_hash: row?.content_hash ?? null,
        current_hash: null, raw_sha256: null, indexed_at: row?.indexed_at ?? null,
        symbols: [], symbols_limited: false,
      };
      result.files.push(evidence);
      if (cleanPath(path) !== path) {
        uncertain = true;
        report('codegraph/unsafe-index-path', '拒绝不安全的图谱文件路径', path);
        continue;
      }
      if (!row) {
        uncertain = true;
        report('codegraph/unindexed-file', '文件没有索引记录', path);
        continue;
      }
      const symbols = symbolQuery.all(path, maxSymbols + 1);
      evidence.symbols = symbols.slice(0, maxSymbols).map(symbol => ({ ...symbol }));
      evidence.symbols_limited = symbols.length > maxSymbols;
      if (!/^[a-f0-9]{64}$/i.test(row.content_hash)) {
        uncertain = true;
        report('codegraph/unknown-hash', '图谱哈希不符合已核实算法', path);
        continue;
      }
      const target = resolve(root, path);
      const before = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!before) {
        evidence.freshness = 'stale';
        report('codegraph/missing-source', '索引源码已经缺失', path);
        continue;
      }
      const actual = await realpath(target);
      const actualStat = await lstat(actual);
      if (!inside(root, actual) || !actualStat.isFile()) {
        uncertain = true;
        report('codegraph/path-escape', '拒绝仓库外或非普通源码', path);
        continue;
      }
      if (actualStat.size > maxBytes) {
        uncertain = true;
        report('codegraph/source-size-limit', '源码超过哈希读取上限', path);
        continue;
      }
      const bytes = await readFile(actual);
      if (bytes.length > maxBytes) {
        uncertain = true;
        report('codegraph/source-size-limit', '源码读取超过上限', path);
        continue;
      }
      const after = await lstat(target);
      const actualAfter = await lstat(actual);
      const actualPathAfter = await realpath(target);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino
        || actualStat.size !== actualAfter.size || actualStat.mtimeMs !== actualAfter.mtimeMs
        || actualStat.ino !== actualAfter.ino || actualPathAfter !== actual) {
        uncertain = true;
        report('codegraph/source-raced', '读取期间源码发生变化', path);
        continue;
      }
      evidence.raw_sha256 = sha256(bytes);
      evidence.current_hash = sha256(bytes.toString('utf8'));
      evidence.freshness = evidence.current_hash.toLowerCase() === row.content_hash.toLowerCase() ? 'fresh' : 'stale';
    }
    if (!requests.length || !result.files.length) uncertain = true;
    const stale = result.files.some(file => file.freshness === 'stale') || result.index.extractor_freshness === 'stale';
    result.index.freshness = stale ? 'stale'
      : uncertain || result.files.some(file => file.freshness === 'unknown') ? 'unknown' : 'fresh';
    result.index.content_fingerprint = sha256(JSON.stringify({
      schema_version: result.index.schema_version, metadata, files: result.files,
    }));
    return result;
  } catch (error) {
    result.index.freshness = 'unknown';
    report('codegraph/read-failed', String(error.message ?? error).slice(0, 300));
    return result;
  } finally {
    if (db) {
      try { if (transaction) db.exec('ROLLBACK'); } catch { /* 保留原读取诊断。 */ }
      try { db.close(); } catch { /* 关闭失败不触发修复写入。 */ }
    }
  }
}
