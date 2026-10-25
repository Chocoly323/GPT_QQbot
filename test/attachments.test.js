import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Attachments, MAX_BYTES, TTL } from '../src/attachments.js';
import { configFromEnv, createHub, privateMessage, generateReply } from '../src/server.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'attachments-'));
  const source = join(root, 'qq');
  await mkdir(source);
  const calls = [];
  const api = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { file } = JSON.parse(raw); calls.push(file);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { file: join(source, file) } }));
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const config = { ...configFromEnv({}), dataDir: join(root, 'data'), attachmentSourceRoots: [source], api: `http://127.0.0.1:${api.address().port}` };
  t.after(async () => { await new Promise(r => api.close(r)); await rm(root, { recursive: true, force: true }); });
  return { root, source, config, calls, store: new Attachments(config) };
}
const event = { self: '100', sender: '200' };
const descriptor = (name, size = 10, kind = 'file') => ({ name, id: name, size, kind });

test('attachments persist per contact, reject unsafe/oversize/unsupported inputs and expire', async t => {
  const h = await fixture(t);
  await writeFile(join(h.source, 'sample.txt'), 'secret');
  assert.equal(await h.store.receive({ ...event, attachments: [descriptor('sample.txt')] }), '');
  const store = new Attachments(h.config);
  assert.equal((await store.context(event)).documents[0].text, 'secret');
  assert.deepEqual((await store.context({ ...event, sender: '201' })).documents, []);
  for (const item of [descriptor('big.txt', MAX_BYTES + 1), descriptor('bad.exe'), descriptor('../sample.txt')]) {
    assert.match(await store.receive({ ...event, attachments: [item] }), /接收失败/);
  }
  assert.equal(h.calls.length, 1);
  await writeFile(join(h.source, 'large.txt'), Buffer.alloc(MAX_BYTES + 1));
  assert.match(await store.receive({ ...event, attachments: [descriptor('large.txt')] }), /超过/);
  await store.cleanup(Date.now() + TTL + 1);
  assert.deepEqual(await store.list(event), []);
});

test('real extractors handle DOCX, XLSX, PDF, images, text and malformed documents', async t => {
  const h = await fixture(t);
  execFileSync('/usr/bin/python3', ['-c', `
import pathlib,sys,zipfile
from PIL import Image
p=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(p/'sample.docx','w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word内容</w:t></w:r></w:p></w:body></w:document>')
with zipfile.ZipFile(p/'sample.xlsx','w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1" name="统计"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="inlineStr"><is><t>销售额</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>')
Image.new('RGB',(30,20),'red').save(p/'photo.png')
(p/'sample.pdf').write_bytes(b'%PDF-1.1\\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\\n4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\\n5 0 obj<</Length 44>>stream\\nBT /F1 12 Tf 10 200 Td (PDF sample) Tj ET\\nendstream endobj\\ntrailer<</Root 1 0 R>>\\n%%EOF')
`, h.source]);
  for (const name of ['sample.docx', 'sample.xlsx', 'sample.pdf', 'photo.png']) {
    assert.equal(await h.store.receive({ ...event, attachments: [descriptor(name, 10, name.endsWith('png') ? 'image' : 'file')] }), '');
  }
  const ctx = await h.store.context(event);
  assert.match(ctx.documents[0].text, /Word内容/);
  assert.match(ctx.documents[1].text, /B1=42/);
  assert.match(ctx.documents[2].text, /PDF sample/);
  assert.equal(ctx.imagePaths.length, 1);
  assert.equal((await readFile(ctx.imagePaths[0]))[0], 137);
  await writeFile(join(h.source, 'bad.docx'), 'invalid');
  await h.store.receive({ ...event, attachments: [descriptor('bad.docx')] });
  assert.match((await h.store.context(event)).documents.at(-1).error, /无法解析/);
});

test('hub silently stores media without generating; next question gets only that contact attachments', async t => {
  const h = await fixture(t);
  await writeFile(join(h.source, 'sample.md'), '# 预算\n42元');
  const sent = [], calls = [];
  const hub = createHub(h.config, { send: async (_c, s, text) => sent.push(text),
    generate: async (_c, _h, text, attachments) => { calls.push({ text, attachments }); return '42元'; }, log: () => {} });
  await new Promise(r => hub.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await hub.idle(); await new Promise(r => hub.server.close(r)); });
  const post = async (message, id, sender = 200) => {
    await fetch(`http://127.0.0.1:${hub.server.address().port}/api/onebot/event`, { method: 'POST', body: JSON.stringify({
      post_type: 'message', message_type: 'private', self_id: 100, user_id: sender, message_id: id, message }) });
    await hub.idle();
  };
  await post([{ type: 'file', data: { file: 'sample.md', file_id: 'sample.md', file_size: 12 } }], 1);
  assert.equal(calls.length, 0); assert.equal(sent.length, 0);
  await post([{ type: 'text', data: { text: '预算是多少' } }], 2);
  assert.match(calls[0].attachments.documents[0].text, /42元/);
  await post([{ type: 'text', data: { text: 'hello' } }], 3, 201);
  assert.equal(calls[1].attachments.documents.length, 0);
  await post([{ type: 'text', data: { text: '/清除附件' } }], 4);
  assert.deepEqual(await h.store.list(event), []);
  await post([{ type: 'file', data: { file: 'bad.exe', file_id: 'bad.exe' } }], 5);
  assert.match(sent.at(-1), /接收失败/);
  assert.equal(calls.length, 2);
});


test('rejects cached paths outside QQ root, bounds document text and handles CSV encodings', async t => {
  const h = await fixture(t);
  await writeFile(join(h.root, 'private.txt'), 'not an attachment');
  await symlink(join(h.root, 'private.txt'), join(h.source, 'linked.txt'));
  assert.match(await h.store.receive({ ...event, attachments: [descriptor('linked.txt')] }), /接收失败/);
  await writeFile(join(h.source, 'long.txt'), 'A'.repeat(60001));
  await h.store.receive({ ...event, attachments: [descriptor('long.txt')] });
  let ctx = await h.store.context(event);
  assert.equal(ctx.documents[0].text.length, 60000);
  assert.equal(ctx.documents[0].truncated, true);
  await h.store.clear(event);
  execFileSync('/usr/bin/python3', ['-c', "import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes('项目,金额\\n测试,42'.encode('gb18030'))", join(h.source, 'table.csv')]);
  await h.store.receive({ ...event, attachments: [descriptor('table.csv')] });
  ctx = await h.store.context(event);
  assert.match(ctx.documents[0].text, /测试,42/);
});
