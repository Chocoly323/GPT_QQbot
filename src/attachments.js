import { mkdir, readdir, readFile, writeFile, rm, realpath, open } from 'node:fs/promises';
import { join, basename, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const extractor = fileURLToPath(new URL('../scripts/read_attachment.py', import.meta.url));
export const MAX_BYTES = 20 * 1024 * 1024;
export const TTL = 24 * 60 * 60 * 1000;
const supported = new Set(['.jpg', '.jpeg', '.png', '.webp', '.docx', '.pdf', '.txt', '.md', '.xlsx', '.csv']);
const images = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export function attachmentSegments(message) {
  if (!Array.isArray(message)) return [];
  return message.filter(s => ['image', 'file'].includes(s.type) && (s.data?.file_id || s.data?.file))
    .map(s => ({ kind: s.type, id: String(s.data.file_id || s.data.file),
      name: basename(String(s.data.name || s.data.file || '附件')), size: Number(s.data.file_size || s.data.size || 0) }));
}

export class Attachments {
  constructor(config) {
    this.config = config;
    this.root = join(config.dataDir, 'attachments');
    this.roots = config.attachmentSourceRoots || [join(homedir(), '.config/QQ'), join(homedir(), '.local/share/codex-qq-bridge')];
  }
  dir(event) { return join(this.root, `${event.self}-${event.sender}`); }
  async entries(directory) {
    try { return await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async cleanup(now = Date.now()) {
    for (const contact of await this.entries(this.root)) {
      if (!contact.isDirectory()) continue;
      const directory = join(this.root, contact.name);
      for (const item of await this.entries(directory)) {
        if (!item.isDirectory()) continue;
        const path = join(directory, item.name);
        let meta;
        try { meta = JSON.parse(await readFile(join(path, 'meta.json'), 'utf8')); } catch { /* incomplete save */ }
        if (!meta || now - meta.at >= TTL) await rm(path, { recursive: true, force: true });
      }
    }
  }
  async list(event) {
    const result = [];
    for (const item of await this.entries(this.dir(event))) {
      if (!item.isDirectory()) continue;
      const directory = join(this.dir(event), item.name);
      const meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8'));
      if (Date.now() - meta.at < TTL) result.push({ ...meta, directory });
    }
    return result.sort((a, b) => a.at - b.at);
  }
  async clear(event) { await rm(this.dir(event), { recursive: true, force: true }); }
  async receive(event) {
    const results = [];
    for (const item of (event.attachments || []).slice(0, 10)) {
      let directory;
      try {
        if ((await this.list(event)).length >= 10) throw new Error('最多保留 10 个附件，请先发送 /清除附件');
        let total = 0;
        for (const contact of await this.entries(this.root)) {
          if (contact.isDirectory()) total += (await this.entries(join(this.root, contact.name))).filter(e => e.isDirectory()).length;
        }
        if (total >= 100) throw new Error('附件存储已满，请稍后或先发送 /清除附件');
        if (item.size > MAX_BYTES) throw new Error('超过 20 MB');
        if (!item.id || item.id.length > 2048 || /[\\/\x00-\x1f]/.test(item.id) || item.id.includes(':')) throw new Error('无效的附件标识');
        let extension = extname(item.name).toLowerCase();
        if (item.kind !== 'image' && !supported.has(extension)) throw new Error('不支持此文件格式');
        const response = await fetch(`${this.config.api}/${item.kind === 'image' ? 'get_image' : 'get_file'}`, {
          method: 'POST', signal: AbortSignal.timeout(30000),
          headers: { 'content-type': 'application/json', ...(this.config.apiToken ? { authorization: `Bearer ${this.config.apiToken}` } : {}) },
          body: JSON.stringify({ file: item.id }),
        });
        const body = await response.json();
        if (!response.ok || body.status !== 'ok' || (body.retcode != null && body.retcode !== 0) || !body.data?.file) throw new Error('QQ 附件下载失败');
        const source = await realpath(body.data.file);
        let allowed = false;
        for (const root of this.roots) {
          const canonical = await realpath(root).catch(() => null);
          if (canonical && source.startsWith(canonical + sep)) allowed = true;
        }
        if (!allowed) throw new Error('附件不在 QQ 下载目录内');
        directory = join(this.dir(event), randomUUID());
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = join(directory, 'source');
        const input = await open(source, 'r');
        try {
          const stat = await input.stat();
          if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('附件不是普通文件或超过 20 MB');
          // Read at most the configured limit even if QQ modifies its cached file.
          const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await input.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length !== stat.size) throw new Error('附件读取期间发生变化，请重新发送');
          if (length > MAX_BYTES) throw new Error('超过 20 MB');
          if (item.kind === 'image') {
            extension = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? '.png'
              : buffer[0] === 255 && buffer[1] === 216 ? '.jpg'
              : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' ? '.webp' : '';
            if (!extension) throw new Error('仅支持 JPG、PNG、WebP 图片');
          }
          await writeFile(file, buffer.subarray(0, length), { mode: 0o600 });
        } finally { await input.close(); }
        const meta = { name: item.name.slice(0, 160), extension, at: Date.now() };
        await writeFile(join(directory, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
      } catch (error) {
        if (directory) await rm(directory, { recursive: true, force: true });
        // Never expose paths, URLs or bridge credentials in QQ error replies.
        const safe = /^(最多|超过|不支持|无效|QQ 附件|附件不在|附件不是|附件存储|附件读取期间|仅支持)/.test(error.message);
        results.push(`接收失败：${item.name.slice(0, 100)}（${safe ? error.message : '附件读取失败'}）`);
      }
    }
    if (event.attachments?.length > 10) results.push('单条消息最多接收 10 个附件，其余未保存。');
    return results.join('\n');
  }
  async context(event) {
    const documents = [], imagePaths = [];
    let remaining = 60000;
    for (const item of await this.list(event)) {
      if (remaining <= 0 && !images.has(item.extension)) { documents.push({ name: item.name, error: '本次附件文字总量超限，未读取' }); continue; }
      try {
        const output = join(item.directory, 'image.png');
        const { stdout } = await exec('/usr/bin/python3', [extractor, join(item.directory, 'source'), item.extension, output], { timeout: 25000, maxBuffer: 1024 * 1024 });
        const parsed = JSON.parse(stdout);
        const text = parsed.text.slice(0, remaining);
        remaining -= text.length;
        if (images.has(item.extension)) imagePaths.push(output);
        documents.push({ name: item.name, text, image: images.has(item.extension) ? imagePaths.length : undefined,
          truncated: parsed.truncated || text.length < parsed.text.length });
      } catch { documents.push({ name: item.name, error: '无法解析：文件可能损坏、加密、格式不符或超出处理限制' }); }
    }
    return { documents, imagePaths };
  }
}
