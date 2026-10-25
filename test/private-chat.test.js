import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { configFromEnv, createHub, privateMessage, generateReply, sendReply } from '../src/server.js';

const event = (sender, text, id) => ({ post_type: 'message', message_type: 'private',
  self_id: 10001, user_id: sender, message_id: id, message: [{ type: 'text', data: { text } }] });

async function setup(t, overrides = {}, generate, send) {
  const dataDir = await mkdtemp(join(tmpdir(), 'qq-test-'));
  const sent = [], calls = [], errors = [];
  const config = { ...configFromEnv({}), dataDir, ...overrides };
  const hub = createHub(config, {
    generate: generate || (async (_config, history, text) => {
      calls.push({ history: structuredClone(history), text }); return `reply:${text}`;
    }),
    send: send || (async (_config, sender, text) => { sent.push({ sender, text }); }),
    log: error => errors.push(error),
  });
  await new Promise(resolve => hub.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await hub.idle();
    await new Promise(resolve => hub.server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${hub.server.address().port}`;
  const post = (body, token = '') => fetch(`${url}/api/onebot/event`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { ...hub, sent, calls, errors, config, post, url };
}

test('ignores groups, own messages, other accounts and media-only messages', () => {
  const base = event(20001, 'hello', 1);
  assert.equal(privateMessage({ ...base, message_type: 'group' }), null);
  assert.equal(privateMessage({ ...base, user_id: 10001 }), null);
  assert.equal(privateMessage(base, '99999'), null);
  assert.equal(privateMessage({ ...base, post_type: 'message_sent' }), null);
  assert.equal(privateMessage({ ...base, message: [{ type: 'image', data: {} }] }), null);
  assert.equal(privateMessage({ ...base, message: '你好[CQ:image,file=x]' }).text, '你好');
});

test('ordered private replies, deduplication, isolated history and persistence', async t => {
  const h = await setup(t);
  await h.post(event(20001, 'A secret', 1));
  await h.post(event(20002, 'B hello', 2));
  await h.post(event(20001, 'A followup', 3));
  assert.equal((await (await h.post(event(20001, 'A secret', 1))).json()).duplicate, true);
  await h.idle();
  assert.equal(h.sent.length, 3);
  assert.deepEqual(h.calls[1].history, []);
  assert.equal(h.calls[2].history[0].user, 'A secret');
  assert.equal(h.calls[2].history.length, 1);
  const file = join(h.config.dataDir, 'conversations', '10001-20001.json');
  assert.equal(JSON.parse(await readFile(file)).length, 2);
  // Reload from disk, not an in-memory conversation cache.
  await writeFile(file, JSON.stringify([{ user: 'persisted', assistant: 'answer' }]));
  await h.post(event(20001, 'next', 4));
  await h.idle();
  assert.equal(h.calls[3].history[0].user, 'persisted');
  await h.post(event(20001, '/清除记忆', 5));
  await h.idle();
  assert.deepEqual(JSON.parse(await readFile(file)), []);
  const other = join(h.config.dataDir, 'conversations', '10001-20002.json');
  assert.equal(JSON.parse(await readFile(other)).length, 1);
});

test('acknowledges before generation, bounds queue and authenticates events', async t => {
  let finish;
  const h = await setup(t, { eventToken: 'secret', queueLimit: 1 }, () => new Promise(resolve => { finish = resolve; }));
  assert.equal((await h.post(event(20001, 'a', 1))).status, 401);
  assert.equal((await h.post(event(20001, 'a', 1), 'secret')).status, 200);
  assert.equal((await h.post(event(20001, 'b', 2), 'secret')).status, 503);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish('done');
  await h.idle();
  assert.equal((await (await fetch(`${h.url}/health`)).json()).pending, 0);
});

test('a failed generation does not poison later messages or expose errors', async t => {
  let count = 0;
  const h = await setup(t, {}, async () => { if (!count++) throw new Error('private error'); return 'OK'; });
  await h.post(event(20001, 'first', 1));
  await h.post(event(20001, 'second', 2));
  await h.idle();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].text, 'OK');
  assert.ok(!h.sent[0].text.includes('private error'));
  assert.equal(h.errors.filter(line => !line.includes('reply_timing')).length, 1);
});

test('CLI subprocess receives prompt, returns output and cleans temporary files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'fake-codex');
  await writeFile(executable, `#!/usr/bin/env node\nconst fs=require('fs');const args=process.argv.slice(2);let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>fs.writeFileSync(args[args.indexOf('-o')+1],s.includes('hello')&&args.includes('gpt-5.6-luna')&&args.includes('model_reasoning_effort=\"medium\"')&&args.includes('service_tier=\"priority\"')?'OK':'BAD'));\n`);
  await chmod(executable, 0o700);
  const config = { ...configFromEnv({}), dataDir: dir, codex: executable, model: 'gpt-5.6-luna', reasoningEffort: 'medium', serviceTier: 'priority' };
  assert.equal(await generateReply(config, [], 'hello'), 'OK');
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('reply-')));
  await writeFile(executable, '#!/usr/bin/env node\nsetInterval(()=>{},1000);\n');
  await assert.rejects(generateReply({ ...config, timeout: 50 }, [], 'hello'), /timed out/);
});

test('OneBot uses bearer token, text segments and splits without truncation', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push({ at: Date.now(), url: req.url, auth: req.headers.authorization, body: JSON.parse(text) });
    res.end(JSON.stringify({ status: 'ok', retcode: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const text = '你😀'.repeat(2100);
  await sendReply({ api: `http://127.0.0.1:${server.address().port}`, apiToken: 'secret', sendIntervalMs: 30 }, '20001', text);
  assert.equal(requests.length, 3);
  assert.ok(requests[1].at - requests[0].at >= 20);
  assert.ok(requests[2].at - requests[1].at >= 20);
  assert.equal(requests[0].auth, 'Bearer secret');
  assert.equal(requests[0].url, '/send_private_msg');
  assert.equal(requests[0].body.user_id, 20001);
  assert.equal(requests.map(r => r.body.message[0].data.text).join(''), text);
});

test('accepts NapCat HMAC callbacks and rejects tampering', async t => {
  const { createHmac } = await import('node:crypto');
  const h = await setup(t, { eventToken: 'callback-secret' });
  const body = JSON.stringify(event(20001, '签名测试', 1));
  const signature = 'sha1=' + createHmac('sha1', 'callback-secret').update(body).digest('hex');
  const post = value => fetch(`${h.url}/api/onebot/event`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': signature }, body: value });
  assert.equal((await post(body.replace('签名测试', 'tampered'))).status, 401);
  assert.equal((await post(body)).status, 200);
  await h.idle();
  assert.equal(h.sent.length, 1);
});

test('contact quota blocks reply loops without blocking other contacts', async t => {
  const h = await setup(t, { contactMaxReplies: 2 });
  await h.post(event(20001, 'first', 1));
  await h.post(event(20001, 'second', 2));
  const limited = await (await h.post(event(20001, 'third', 3))).json();
  assert.equal(limited.reason, 'Contact reply limit reached');
  await h.post(event(20002, 'other person', 4));
  await h.idle();
  assert.equal(h.sent.length, 3);
  assert.equal(h.calls.length, 3);
  assert.equal(h.sent.at(-1).sender, '20002');
});

test('send failure pauses queued and future messages without follow-up sends', async t => {
  let sends = 0;
  const h = await setup(t, {}, undefined, async () => { sends++; throw new Error('delivery uncertain'); });
  await h.post(event(20001, 'first', 1));
  await h.post(event(20002, 'queued', 2));
  await h.idle();
  assert.equal(sends, 1);
  assert.equal(h.calls.length, 1);
  assert.equal((await (await fetch(`${h.url}/health`)).json()).sendingPaused, true);
  const ignored = await (await h.post(event(20001, 'later', 3))).json();
  assert.equal(ignored.ignored, true);
  const file = join(h.config.dataDir, 'sending-paused.json');
  assert.ok(JSON.parse(await readFile(file)).at);
  // A fresh hub using the same data directory must retain the pause.
  const restarted = createHub(h.config, { send: async () => { sends++; } });
  await new Promise(resolve => restarted.server.listen(0, '127.0.0.1', resolve));
  try {
    const state = await (await fetch(`http://127.0.0.1:${restarted.server.address().port}/health`)).json();
    assert.equal(state.sendingPaused, true);
  } finally { await new Promise(resolve => restarted.server.close(resolve)); }
  assert.equal(sends, 1);
});

test('failed long-message segment stops remaining segments without retry', async t => {
  let sends = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    sends++;
    res.end(JSON.stringify(sends === 1 ? { status: 'ok', retcode: 0 } : { status: 'failed', retcode: 1200 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(sendReply({ api: `http://127.0.0.1:${server.address().port}`, sendIntervalMs: 1 }, '20001', 'a'.repeat(6000)), /send failed/);
  assert.equal(sends, 2);
});

test('only bound self-to-self messages are accepted; Codex echoes are ignored', () => {
  const self = { ...event(10001, '你好', 42), post_type: 'message_sent', target_id: 10001 };
  assert.equal(privateMessage(self, '10001').text, '你好');
  assert.equal(privateMessage({ ...self, post_type: 'message' }, '10001').text, '你好');
  assert.equal(privateMessage({ ...self, target_id: 20001 }, '10001'), null);
  assert.equal(privateMessage({ ...self, target_id: undefined }, '10001'), null);
  assert.equal(privateMessage(self), null);
  assert.equal(privateMessage({ ...self, message: '[Codex] 你好' }, '10001'), null);
});

test('self-chat reply segments are marked and never trigger another model call', async t => {
  const h = await setup(t, { account: '10001' });
  const self = { ...event(10001, 'question', 1), target_id: 10001, post_type: 'message_sent' };
  await h.post(self);
  await h.idle();
  assert.equal(h.calls.length, 1);
  const messages = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    messages.push(body.message[0].data.text);
    // Echo before the send request returns, as a real bridge may do.
    await h.post({ ...self, message_id: messages.length + 100, message: body.message });
    res.end(JSON.stringify({ status: 'ok', retcode: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await sendReply({ api: `http://127.0.0.1:${server.address().port}`, account: '10001', sendIntervalMs: 1 }, '10001', 'a'.repeat(2100));
  await h.idle();
  assert.equal(messages.length, 2);
  assert.ok(messages.every(text => text.startsWith('[Codex] ')));
  assert.equal(h.calls.length, 1);
});

test('style edits apply to the next CLI call; empty or missing files use base prompt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-style-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'fake-codex');
  await writeFile(executable, `#!/usr/bin/env node\nconst fs=require('fs');const args=process.argv.slice(2);let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>fs.writeFileSync(args[args.indexOf('-o')+1],s));\n`);
  await chmod(executable, 0o700);
  const stylePath = join(dir, 'style.md');
  const config = { ...configFromEnv({}), dataDir: dir, codex: executable, stylePath };
  await writeFile(stylePath, '风格甲：轻松自然');
  const first = await generateReply(config, [], 'hello');
  assert.ok(first.includes('风格甲：轻松自然'));
  await writeFile(stylePath, '风格乙：正式克制');
  const second = await generateReply(config, [], 'hello');
  assert.ok(second.includes('风格乙：正式克制'));
  assert.ok(!second.includes('风格甲'));
  assert.ok(second.includes('不要冒充 QQ 账号主人'));
  assert.ok(second.includes('"message":"hello"'));
  await writeFile(stylePath, '   \n');
  const empty = await generateReply(config, [], 'hello');
  assert.ok(!empty.includes('以下风格偏好'));
  await rm(stylePath);
  const missing = await generateReply(config, [], 'hello');
  assert.equal(missing, empty);
});

test('completed JSON turn returns before CLI shutdown and later cleans output', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-stream-'));
  const executable = join(dir, 'fake-codex');
  const closed = join(dir, 'closed');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('fs');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready'}})+'\\n');
  process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');
  setTimeout(() => { fs.writeFileSync(${JSON.stringify(closed)}, 'yes'); }, 400);
});
`);
  await chmod(executable, 0o700);
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await rm(dir, {recursive:true,force:true});
  });
  const config = {...configFromEnv({}), dataDir:dir, codex:executable};
  assert.equal(await generateReply(config, [], 'hello'), 'ready');
  await assert.rejects(readFile(closed), {code:'ENOENT'});
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await readFile(closed, 'utf8'), 'yes');
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('reply-')));
});

test('failed JSON turn never returns an intermediate agent message', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-failed-turn-'));
  const executable = join(dir, 'fake-codex');
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.resume();process.stdin.on('end',()=>{
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'intermediate'}}));
 console.log(JSON.stringify({type:'turn.failed',error:{message:'failure'}}));
});
`);
  await chmod(executable, 0o700);
  t.after(async()=>{ await new Promise(resolve=>setTimeout(resolve,50));await rm(dir,{recursive:true,force:true}); });
  await assert.rejects(generateReply({...configFromEnv({}),dataDir:dir,codex:executable}, [], 'hello'), /turn failed/);
});

test('bubble protocol preserves paragraphs and code, ignores empty bubbles without capping count', async () => {
  const {splitReplyBubbles} = await import('../src/server.js');
  assert.deepEqual(splitReplyBubbles('第一段\n\n第二段'), ['第一段\n\n第二段']);
  assert.deepEqual(splitReplyBubbles('[[QQ_BUBBLE]]\n你好\n[[QQ_BUBBLE]]\n\n[[QQ_BUBBLE]]\n再见\n[[QQ_BUBBLE]]'), ['你好', '再见']);
  const code = '```text\n[[QQ_BUBBLE]]\n```';
  assert.deepEqual(splitReplyBubbles(code+'\n[[QQ_BUBBLE]]\n解释'), [code,'解释']);
  const tilde = '~~~\n[[QQ_BUBBLE]]\n~~~';
  assert.deepEqual(splitReplyBubbles(tilde), [tilde]);
  assert.deepEqual(splitReplyBubbles(['1','2','3','4','5','6'].join('\n[[QQ_BUBBLE]]\n')), ['1','2','3','4','5','6']);
});

test('separate bubbles use separate paced OneBot requests with self-chat prefixes', async t => {
  const messages = [], times = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    messages.push(JSON.parse(body).message[0].data.text);times.push(Date.now());
    res.end(JSON.stringify({status:'ok',retcode:0}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await sendReply({api:`http://127.0.0.1:${server.address().port}`,account:'10001',sendIntervalMs:30},'10001','收到\n[[QQ_BUBBLE]]\n这是第一段\n\n这是同一气泡的第二段\n[[QQ_BUBBLE]]\n结束');
  assert.deepEqual(messages,['[Codex] 收到','[Codex] 这是第一段\n\n这是同一气泡的第二段','[Codex] 结束']);
  assert.ok(times[1]-times[0]>=20);
  assert.ok(times[2]-times[1]>=20);
});

test('native faces are allowlisted and code examples remain literal', async () => {
  const {parseQqFaces} = await import('../src/server.js');
  assert.deepEqual(parseQqFaces('你好[[QQ_FACE:微笑]]😀[[QQ_FACE:惊讶]]'), [
    {type:'text',data:{text:'你好'}},{type:'face',data:{id:'14'}},
    {type:'text',data:{text:'😀'}},{type:'face',data:{id:'0'}}]);
  for (const text of ['[[QQ_FACE:不存在]]', '[微笑]', '[CQ:face,id=14]', '`[[QQ_FACE:微笑]]`', '```text\n[[QQ_FACE:微笑]]\n```', '~~~\n[[QQ_FACE:微笑]]\n~~~']) {
    assert.deepEqual(parseQqFaces(text), [{type:'text',data:{text}}]);
  }
});

test('face tokens survive length boundaries and pure-face self echoes are ignored', async () => {
  const {buildQqMessages} = await import('../src/server.js');
  const messages = buildQqMessages('a'.repeat(1999)+'[[QQ_FACE:微笑]]'+'b'.repeat(2)+'\n[[QQ_BUBBLE]]\n[[QQ_FACE:赞]]',true);
  assert.equal(messages.length,3);
  assert.equal(messages[0][1].type,'face');
  assert.equal(messages[0][1].data.id,'14');
  assert.equal(messages[1][0].data.text,'[Codex] bb');
  assert.deepEqual(messages[2],[{type:'text',data:{text:'[Codex] '}},{type:'face',data:{id:'76'}}]);
  for (const message of messages) assert.equal(privateMessage({...event(10001,'',1),target_id:10001,post_type:'message_sent',message},'10001'),null);
});

test('OneBot receives real face segments mixed with text in each bubble', async t => {
  const messages=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req) body+=chunk;
    messages.push(JSON.parse(body).message);
    res.end(JSON.stringify({status:'ok',retcode:0}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  await sendReply({api:`http://127.0.0.1:${server.address().port}`,sendIntervalMs:1},'20001','哈哈[[QQ_FACE:呲牙]]\n[[QQ_BUBBLE]]\n[[QQ_FACE:握手]]');
  assert.deepEqual(messages,[
    [{type:'text',data:{text:'哈哈'}},{type:'face',data:{id:'13'}}],
    [{type:'face',data:{id:'78'}}]
  ]);
});

test('long unmarked paragraphs and lists get fallback bubbles without losing content', async () => {
  const {splitReplyBubbles,buildQqMessages}=await import('../src/server.js');
  const text='下面介绍几位诗人：\n\n'+Array.from({length:6},(_,i)=>`诗人${i}：这是生平和作品的简要介绍，可以根据兴趣进一步了解其风格与代表作品。`).join('\n')+'\n\n可以先从其中两位开始了解。';
  const bubbles=splitReplyBubbles(text);
  assert.ok(bubbles.length>=2);
  assert.equal(bubbles.join('').replace(/\s/g,''),text.replace(/\s/g,''));
  assert.equal(buildQqMessages(text).length,bubbles.length);
  const paragraph='这是一个完整的句子，包含需要说明的内容。'.repeat(12);
  assert.ok(splitReplyBubbles(paragraph).length>1);
  assert.equal(splitReplyBubbles(paragraph).join('').replace(/\s/g,''),paragraph);
});

test('fallback preserves fenced and inline code and short replies', async () => {
  const {splitReplyBubbles}=await import('../src/server.js');
  const code='```js\n'+"console.log('完整代码，不应被句号拆分。');\n".repeat(8)+'```';
  const bubbles=splitReplyBubbles('说明\n\n'+code+'\n\n执行后查看输出。');
  assert.ok(bubbles.some(b=>b.includes(code)));
  const inline='`'+ 'a.b();'.repeat(30)+'`';
  assert.deepEqual(splitReplyBubbles(inline),[inline]);
  assert.deepEqual(splitReplyBubbles('你好呀！\n\n最近怎么样？'),['你好呀！\n\n最近怎么样？']);
});


test('fallback keeps more than five bubbles when long replies need them', async () => {
  const {splitReplyBubbles}=await import('../src/server.js');
  const paragraphs=Array.from({length:8},(_,i)=>`第${i}段：`+'说明内容'.repeat(10)+'。');
  assert.deepEqual(splitReplyBubbles(paragraphs.join('\n\n')),paragraphs);
});
