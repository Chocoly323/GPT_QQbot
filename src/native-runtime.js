import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ProxyAgent, request } from 'undici';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { outputRuntime } from './outputs.js';
const project = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = join(homedir(), '.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl');
const binary = join(packageRoot, 'bin/codex');

export async function startNativeRuntime(config, job, temp) {
  const authHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const capability = randomUUID();
  const proxyUrl = process.env.CODEX_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:17897';
  const dispatcher = new ProxyAgent(proxyUrl);
  const controllers = new Set();
  const proxy = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses' || req.headers['x-qq-run-token'] !== capability) {
      res.writeHead(403).end(); return;
    }
    const abort = new AbortController(); controllers.add(abort);
    const timer = setTimeout(() => abort.abort(), config.nativeTimeout);
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
      const auth = JSON.parse(await readFile(join(authHome, 'auth.json'), 'utf8'));
      const token = auth.tokens?.access_token || auth.OPENAI_API_KEY;
      if (!token) throw new Error('Missing model credentials');
      const upstream = auth.tokens?.access_token ? 'https://chatgpt.com/backend-api/codex/responses' : 'https://api.openai.com/v1/responses';
      const response = await request(upstream, { dispatcher, method: 'POST', signal: abort.signal,
        headersTimeout: 300000, bodyTimeout: 300000,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          ...(auth.tokens?.account_id ? { 'chatgpt-account-id': auth.tokens.account_id } : {}),
          'openai-beta': 'responses=experimental', originator: 'codex_cli_rs' },
        body: Buffer.concat(chunks), maxRedirections: 0 });
      res.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] || 'text/event-stream' });
      for await (const chunk of response.body) {
        if (!res.write(chunk)) await new Promise(r => { res.once('drain', r); res.once('close', r); });
      }
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    } finally { clearTimeout(timer); controllers.delete(abort); }
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const port = proxy.address().port;
  const close = () => { for (const c of controllers) c.abort(); proxy.closeAllConnections(); proxy.close(); dispatcher.close().catch(() => {}); };
  try {
    const home = join(job.directory, 'tmp/home'), codexHome = join(home, '.codex');
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    // Only model metadata is copied. Never copy auth.json, account config or history.
    const sourceHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    try { await writeFile(join(codexHome, 'models_cache.json'), await readFile(join(sourceHome, 'models_cache.json')), { mode: 0o600 }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const paths = ['/usr', '/lib', '/lib64', '/etc/fonts', '/etc/ld.so.cache', '/dev/null', '/dev/urandom', packageRoot, outputRuntime].map(p => [p, false]);
    paths.push([job.directory, true], [temp, true]);
    // Proxy startup metadata is harmless, but is not an exposed credential file.
    const policy = JSON.stringify({ paths, port });
    const options = ['--dangerously-bypass-approvals-and-sandbox', '--ignore-user-config', '--ignore-rules',
      '--disable', 'code_mode_host', '--disable', 'shell_snapshot',
      '-c', 'model_provider="qq_local"',
      '-c', 'model_providers.qq_local.name="QQ local credential proxy"',
      '-c', `model_providers.qq_local.base_url="http://127.0.0.1:${port}/v1"`,
      '-c', 'model_providers.qq_local.wire_api="responses"',
      '-c', 'model_providers.qq_local.requires_openai_auth=false',
      '-c', 'model_providers.qq_local.request_max_retries=0',
      '-c', 'model_providers.qq_local.stream_max_retries=0',
      '-c', 'model_providers.qq_local.supports_websockets=false'];
    options.push('-c', `model_providers.qq_local.http_headers={"X-QQ-Run-Token"=${JSON.stringify(capability)}}`);
    return { command: '/usr/bin/python3', prefix: [join(project, 'scripts/native_sandbox.py'), policy, binary], options, close,
      env: { HOME: home, CODEX_HOME: codexHome, TMPDIR: join(job.directory, 'tmp'), LANG: 'C.UTF-8',
        PATH: `${outputRuntime}/bin:/usr/bin:/bin`, NO_PROXY: '*', no_proxy: '*', PYTHONDONTWRITEBYTECODE: '1' } };
  } catch (e) { close(); throw e; }
}
