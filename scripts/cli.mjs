import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, extname, join, resolve } from 'node:path';

const targets = {
  'win32-x64': ['win32-x64', 'x86_64-pc-windows-msvc'],
  'win32-arm64': ['win32-arm64', 'aarch64-pc-windows-msvc'],
  'linux-x64': ['linux-x64', 'x86_64-unknown-linux-musl'],
  'linux-arm64': ['linux-arm64', 'aarch64-unknown-linux-musl'],
  'darwin-x64': ['darwin-x64', 'x86_64-apple-darwin'],
  'darwin-arm64': ['darwin-arm64', 'aarch64-apple-darwin'],
};

function file(path) {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function codexEntry(path) {
  path = realpathSync(path);
  if (['.cmd', '.ps1', '.bat'].includes(extname(path).toLowerCase())) {
    const script = join(dirname(path), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!file(script)) throw new Error('Unsupported Codex wrapper. Pass --codex-executable with the native binary.');
    path = realpathSync(script);
  }
  if (extname(path) === '.js' || extname(path) === '.mjs') {
    const target = targets[`${process.platform}-${process.arch}`];
    if (target) {
      const [name, triple] = target;
      const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
      const bases = [join(dirname(path), '..', 'vendor')];
      try {
        const packagePath = createRequire(path).resolve(`@openai/codex-${name}/package.json`);
        bases.unshift(join(dirname(packagePath), 'vendor'));
      } catch { /* 旧版CLI把原生程序放在自身vendor目录。 */ }
      for (const base of bases) {
        const executable = join(base, triple, 'bin', binary);
        if (file(executable)) return { command: realpathSync(executable), args: [] };
      }
    }
    return { command: process.execPath, args: [path] };
  }
  accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  return { command: path, args: [] };
}

export function resolveCodex(executable, env = process.env) {
  executable ??= env.CODEX_CLI_PATH;
  if (executable) {
    if (!file(resolve(executable))) throw new Error(`Codex executable not found: ${executable}`);
    return codexEntry(resolve(executable));
  }
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.ps1'] : ['codex'];
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory.replace(/^"|"$/g, ''), name);
      if (file(candidate)) return codexEntry(candidate);
    }
  }
  throw new Error('Codex not found. Install Codex CLI or pass --codex-executable.');
}

export function execCodex(executable, args, options = {}) {
  const cli = resolveCodex(executable, options.env ?? process.env);
  return execFileSync(cli.command, [...cli.args, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
}

export function spawnCodex(executable, args, options = {}) {
  const cli = resolveCodex(executable, options.env ?? process.env);
  return spawn(cli.command, [...cli.args, ...args], { windowsHide: true, ...options });
}

export function resolveNpm(env = process.env) {
  const candidates = [env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    const launcher = join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (existsSync(launcher)) {
      const actual = realpathSync(launcher);
      candidates.push(actual.endsWith('.js') ? actual : join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  }
  const path = candidates.find(candidate => candidate && candidate.endsWith('.js') && file(candidate));
  if (!path) throw new Error('npm not found. Install Node.js with npm.');
  return { command: process.execPath, args: [realpathSync(path)] };
}
