import { execCodex, spawnCodex } from './cli.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export async function connectCodex(executable, { cwd, codexHome, extraConfig = [], enableNormify = false,
  captureDiagnostics = false }) {
  const env = { ...process.env, CODEX_HOME: codexHome };
  const servers = JSON.parse(execCodex(executable, ['mcp', 'list', '--json'],
    { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  const overrides = servers.filter(server => !enableNormify || server.name !== 'normify').flatMap(server => ['-c', `mcp_servers.${JSON.stringify(server.name)}=${server.transport.type === 'stdio'
    ? `{command=${JSON.stringify(server.transport.command)},args=${JSON.stringify(server.transport.args)},enabled=false}`
    : `{url=${JSON.stringify(server.transport.url)},enabled=false}`}`]);
  let config = '';
  try { config = await readFile(join(codexHome, 'config.toml'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const match of config.matchAll(/^\[plugins\."([^"]+)"\]/gm)) {
    overrides.push('-c', `plugins.${JSON.stringify(match[1])}.enabled=false`);
  }
  overrides.push('-c', 'features.apps=false', '-c', 'features.plugins=false');
  for (const config of extraConfig) overrides.push('-c', config);
  const child = spawnCodex(executable, [...overrides, 'app-server', '--stdio'],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const exited = new Promise(resolveExit => child.once('close', resolveExit));
  const pending = new Map();
  const notifications = [];
  let serial = 0;
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method?.startsWith('hook/') || ['error', 'turn/completed'].includes(message.method)) notifications.push(message);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  // 不输出其他服务的诊断与配置。
  let diagnostics = '';
  child.stderr.on('data', bytes => {
    if (captureDiagnostics) diagnostics = (diagnostics + bytes.toString()).slice(-4000);
  });
  const fail = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Codex app server exited.' + (captureDiagnostics ? '\n' + diagnostics : ''))));
  function request(method, params) {
    return new Promise((resolveRequest, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out: ' + method)); }, 60_000);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  const close = async () => { lines.close(); child.stdin.end(); child.kill(); await exited; };
  try {
    await request('initialize', { clientInfo: { name: 'normify-hook-installer', version: '0.1.0' },
      capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return { request, close, notifications };
  } catch (error) { await close(); throw error; }
}
