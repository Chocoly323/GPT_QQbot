import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startNativeRuntime } from '../src/native-runtime.js';
import { Outputs } from '../src/outputs.js';
import { configFromEnv, createHub, generateReply, sendOutputFile, sendReply } from '../src/server.js';
const who = { self: '100', sender: '200' };
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'qq-output-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { ...configFromEnv({}), dataDir, nativeFiles: true, sendIntervalMs: 25 };
  return { config, outputs: new Outputs(config) };
}
test('native artifacts are isolated, bounded, persisted for self echoes and expired', async t => {
  const { config, outputs } = await setup(t);
  const job = await outputs.create(who);
  await writeFile(join(job.directory, 'scripts/main.py'), '# GPT generated');
  await writeFile(join(job.directory, 'output/report.txt'), 'hello');
  const files = await outputs.collect(who, job);
  assert.equal(files[0].name, 'report.txt');
  const followup = await outputs.create(who);
  assert.equal(await readFile(join(followup.directory, followup.inputFiles[0].path), 'utf8'), 'hello');
  const other = await outputs.create({self:'100',sender:'201'});
  assert.equal(other.inputFiles.length, 0);
  const self = { self: '100', sender: '100' }, selfJob = await outputs.create(self);
  await writeFile(join(selfJob.directory, 'output/report.txt'), 'self');
  const ownFiles = await outputs.collect(self, selfJob);
  const restarted = new Outputs(config);
  assert.equal(await restarted.isEcho({ ...self, attachments: [{ name: ownFiles[0].wireName }] }), true);
  assert.equal(await restarted.isEcho({ ...who, attachments: [{ name: ownFiles[0].wireName }] }), false);
  assert.equal(await restarted.isEcho({ ...self, attachments: [{ name: 'report.txt' }] }), false);
  await outputs.cleanup(Date.now() + 86400001);
  assert.equal((await readdir(join(config.dataDir, 'outputs', '100-200'))).length, 0);
});
test('rejects symlinks, hard-to-route names, oversized files and partial multi-file output', async t => {
  const { outputs } = await setup(t);
  const job = await outputs.create(who);
  const dir = join(job.directory, 'output');
  await symlink('/etc/passwd', join(dir, 'bad.txt'));
  await assert.rejects(outputs.collect(who, job));
  await rm(join(dir, 'bad.txt'));
  await writeFile(join(dir, 'big.txt'), Buffer.alloc(20 * 1024 * 1024 + 1));
  await assert.rejects(outputs.collect(who, job));
  await rm(join(dir, 'big.txt'));
  await writeFile(join(dir, 'bad.exe'), 'bad');
  await assert.rejects(outputs.collect(who, job));
  await rm(join(dir, 'bad.exe'));
  for (let i = 0; i < 4; i++) await writeFile(join(dir, `${i}.txt`), 'data');
  await assert.rejects(outputs.collect(who, job));
});
test('native CLI retains tools, avoids QQ credentials, and waits for exit', async t => {
  const { config, outputs } = await setup(t);
  const job = await outputs.create(who);
  const mock = join(config.dataDir, 'mock-cli');
  await writeFile(mock, `#!/usr/bin/env python3\nimport sys,os,json,time,pathlib\np=pathlib.Path(sys.argv[sys.argv.index('-C')+1])\n(p/'args.json').write_text(json.dumps(sys.argv))\n(p/'env.json').write_text(json.dumps(dict(os.environ)))\n(p/'prompt.txt').write_text(sys.stdin.read())\nprint(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'done'}}),flush=True)\nprint(json.dumps({'type':'turn.completed'}),flush=True)\ntime.sleep(.15)\n(p/'output/result.txt').write_text('finished')\n`);
  await chmod(mock, 0o700);
  process.env.ONEBOT_ACCESS_TOKEN = 'must-not-reach-model';
  try {
    assert.equal(await generateReply({ ...config, codex: mock }, [], '生成文件', { job }, { startRuntime: async () => ({ command: mock, prefix: [], options: ['--ignore-user-config'], close: () => {}, env: { PATH: '/usr/bin:/bin' } }) }), 'done');
  } finally { delete process.env.ONEBOT_ACCESS_TOKEN; }
  const args = JSON.parse(await readFile(join(job.directory, 'args.json')));
  assert.ok(args.includes('shell_tool'));
  assert.equal(args.includes('-s'), false);
  assert.ok(args.includes('--ignore-user-config'));
  const env = JSON.parse(await readFile(join(job.directory, 'env.json')));
  assert.equal(env.ONEBOT_ACCESS_TOKEN, undefined);
  assert.match(await readFile(join(job.directory, 'prompt.txt'), 'utf8'), /原生 Codex/);
  assert.equal((await outputs.collect(who, job)).length, 1);
});
test('file and text share pacing; upload failures are not retried', async t => {
  const { config } = await setup(t);
  const requests = [];
  const api = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    requests.push({ url: req.url, at: Date.now(), body: JSON.parse(raw), auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { file_id: 'abc' } }));
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => api.close(r)));
  config.api = `http://127.0.0.1:${api.address().port}`; config.apiToken = 'test';
  await sendOutputFile(config, '200', { path: '/safe/report.txt', wireName: 'report.txt' });
  await sendReply(config, '200', 'done');
  assert.equal(requests[0].url, '/upload_private_file');
  assert.equal(requests[0].body.user_id, '200');
  assert.equal(requests[0].auth, 'Bearer test');
  assert.ok(requests[1].at - requests[0].at >= 15);
});
test('hub forwards native files before reply and pauses on uncertain upload', async t => {
  const { config } = await setup(t);
  const delivered = [], calls = [];
  let fail = false;
  const hub = createHub(config, {
    generate: async (_c, _h, text, context) => {
      calls.push(context.job);
      await writeFile(join(context.job.directory, 'scripts/create.py'), '# generated by model');
      await writeFile(join(context.job.directory, 'output/report.txt'), text);
      return '文件内容如上。';
    },
    sendFile: async (_c, sender, file) => { if (fail) throw new Error('timeout'); delivered.push(['file', sender, file.name]); },
    send: async (_c, sender, text) => delivered.push(['text', sender, text]), log: () => {},
  });
  await new Promise(r => hub.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await hub.idle(); await new Promise(r => hub.server.close(r)); });
  const url = `http://127.0.0.1:${hub.server.address().port}`;
  const post = async (id) => {
    await fetch(`${url}/api/onebot/event`, { method: 'POST', body: JSON.stringify({ post_type: 'message', message_type: 'private',
      self_id: 100, user_id: 200, message_id: id, message: [{ type: 'text', data: { text: '导出文件' } }] }) });
    await hub.idle();
  };
  await post(1);
  assert.deepEqual(delivered.map(x => x[0]), ['file', 'text']);
  fail = true;
  await post(2);
  assert.equal(delivered.length, 2);
  assert.equal((await (await fetch(`${url}/health`)).json()).sendingPaused, true);
  await post(3);
  assert.equal(calls.length, 2);
});


test('rootless sandbox allows job tools but denies host files, network and control sockets', async t => {
  const { config, outputs } = await setup(t);
  const job = await outputs.create(who);
  const temp = await mkdtemp(join(config.dataDir, 'runtime-'));
  const runtime = await startNativeRuntime(config, job, temp);
  t.after(runtime.close);
  assert.equal(runtime.env.ONEBOT_ACCESS_TOKEN, undefined);
  assert.equal(runtime.env.OPENAI_API_KEY, undefined);
  const script = `import json,pathlib,socket,os
results={}
p=pathlib.Path(${JSON.stringify(job.directory)})/'output'/'test.txt'
p.write_text('works'); results['write']=p.read_text()=='works'
for name,path in [('host','/etc/passwd'),('proc','/proc/self/environ'),('credentials','/home/yili/.codex/auth.json')]:
 try: pathlib.Path(path).read_bytes(); results[name]=False
 except PermissionError: results[name]=True
try: socket.socket(socket.AF_UNIX); results['unix']=False
except PermissionError: results['unix']=True
try:
 s=socket.socket(); s.connect(('127.0.0.1',3001)); results['network']=False
except PermissionError: results['network']=True
print(json.dumps(results))`;
  const prefix = runtime.prefix.slice(0, 2);
  const {stdout} = await promisify(execFile)('/usr/bin/python3', [...prefix, '/usr/bin/python3', '-c', script], { env: runtime.env });
  assert.deepEqual(JSON.parse(stdout), {write:true,host:true,proc:true,credentials:true,unix:true,network:true});
});
