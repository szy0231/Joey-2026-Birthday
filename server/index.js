// Joey's birthday mailbox: friends post a wish (text) and optionally a video.
//
// Durability model
//   1. A wish is written to local disk (data/wishes/<id>.json) before the client is told it is saved.
//   2. A video is appended chunk by chunk to data/incoming/<id>; the client can resume after any drop.
//   3. Once complete, a background worker copies the wish JSON and the original video to R2 and
//      verifies the remote size. The local video is deleted only after that check passes.
//   4. On boot the worker rescans every wish, so a crash or reboot never strands a file.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStorage } from './storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const WISHES = path.join(DATA, 'wishes');
const INCOMING = path.join(DATA, 'incoming');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_VIDEO = Number(process.env.MAX_VIDEO_BYTES || 4 * 1024 ** 3); // 4 GB
const MAX_CHUNK = 16 * 1024 ** 2;
const MAX_MESSAGE = 20000;
const DISK_RESERVE = 1024 ** 3; // keep 1 GB free

fs.mkdirSync(WISHES, { recursive: true });
fs.mkdirSync(INCOMING, { recursive: true });
const storage = makeStorage(process.env);

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/* ---------- wish records ---------- */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const wishPath = id => path.join(WISHES, id + '.json');
const incomingPath = id => path.join(INCOMING, id);

async function readWish(id) {
  if (!ID_RE.test(id)) return null;
  try { return JSON.parse(await fsp.readFile(wishPath(id), 'utf8')); } catch { return null; }
}
// Write-then-rename so a crash mid-write can never leave a half-written record.
async function writeWish(w) {
  const tmp = wishPath(w.id) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  const fh = await fsp.open(tmp, 'w');
  await fh.writeFile(JSON.stringify(w, null, 2));
  await fh.sync();
  await fh.close();
  await fsp.rename(tmp, wishPath(w.id));
}
// Serialise all changes to one wish so concurrent requests cannot overwrite each other.
const locks = new Map();
function withWish(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next);
  next.catch(() => {}).finally(() => { if (locks.get(id) === next) locks.delete(id); });
  return next;
}
const sameToken = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const EXT_OK = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mpg', 'mpeg', 'wmv', 'hevc', 'ts', 'mts']);
const extOf = name => {
  const e = (String(name).match(/\.([A-Za-z0-9]{1,5})$/) || [])[1];
  return e && EXT_OK.has(e.toLowerCase()) ? e.toLowerCase() : 'mp4';
};
const videoKey = w => `originals/${w.id}.${extOf(w.video.name)}`;

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

const fail = (res, code, error, extra) => res.status(code).json({ error, ...extra });
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// Create a wish. `clientId` makes the request safe to retry on a flaky connection.
app.post('/api/wishes', express.json({ limit: '200kb' }), wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 60);
  const message = String(req.body?.message ?? '').trim();
  const clientId = String(req.body?.clientId ?? '');
  if (!name) return fail(res, 400, 'name_required');
  if (!message) return fail(res, 400, 'message_required');
  if (message.length > MAX_MESSAGE) return fail(res, 400, 'message_too_long');
  if (!ID_RE.test(clientId)) return fail(res, 400, 'bad_client_id');

  const out = await withWish(clientId, async () => {
    const existing = await readWish(clientId);
    if (existing) {
      // A retry whose first response was lost has no token yet: identical content proves it is the same sender.
      const retry = existing.name === name && existing.message === message;
      if (!retry && !sameToken(existing.token, req.body?.token)) return null;
      Object.assign(existing, { name, message, synced: false });
      await writeWish(existing);
      return existing;
    }
    const w = {
      id: clientId, token: crypto.randomBytes(24).toString('hex'),
      name, message, createdAt: new Date().toISOString(),
      userAgent: String(req.get('user-agent') || '').slice(0, 300),
      video: null, synced: false,
    };
    await writeWish(w);
    return w;
  });
  if (!out) return fail(res, 409, 'exists');
  res.json({ id: out.id, token: out.token });
  kick();
}));

// Auth for everything under a wish: the token handed out at creation.
const own = wrap(async (req, res, next) => {
  const w = await readWish(req.params.id);
  if (!w || !sameToken(w.token, req.get('x-wish-token'))) return fail(res, 404, 'not_found');
  req.wish = w; next();
});
const offsetOf = async id => { try { return (await fsp.stat(incomingPath(id))).size; } catch { return 0; } };

// Declare the video. Calling it again with the same file resumes; a different file starts over.
app.post('/api/wishes/:id/video', express.json({ limit: '20kb' }), own, wrap(async (req, res) => {
  const size = Number(req.body?.size), name = String(req.body?.name ?? 'video').slice(0, 200);
  const type = String(req.body?.type ?? '').slice(0, 100);
  if (!Number.isSafeInteger(size) || size <= 0) return fail(res, 400, 'bad_size');
  if (size > MAX_VIDEO) return fail(res, 413, 'too_large', { max: MAX_VIDEO });

  const out = await withWish(req.params.id, async () => {
    const w = await readWish(req.params.id);
    if (w.video && w.video.status !== 'uploading' && w.video.size === size && w.video.name === name) {
      return { offset: size, done: true };
    }
    const same = w.video && w.video.status === 'uploading' && w.video.size === size && w.video.name === name;
    if (!same) {
      await fsp.rm(incomingPath(w.id), { force: true });
      const { bavail, bsize } = await fsp.statfs(DATA);
      if (bavail * bsize < size + DISK_RESERVE) return { full: true };
      w.video = { name, type, size, status: 'uploading', startedAt: new Date().toISOString() };
      w.synced = false;
      await writeWish(w);
    }
    return { offset: Math.min(await offsetOf(w.id), size) };
  });
  if (out.full) return fail(res, 507, 'server_full');
  res.json(out);
}));

app.get('/api/wishes/:id/video', own, wrap(async (req, res) => {
  const v = req.wish.video;
  if (!v) return fail(res, 404, 'no_video');
  res.json({ offset: v.status === 'uploading' ? await offsetOf(req.wish.id) : v.size, size: v.size, done: v.status !== 'uploading' });
}));

// Append one chunk at ?offset=N. If the offset is wrong, answer 409 with the real one so the client realigns.
app.put('/api/wishes/:id/video', own, (req, res, next) => {
  withWish(req.params.id, async () => {
    const w = await readWish(req.params.id);
    const v = w.video;
    if (!v) return fail(res, 404, 'no_video');
    if (v.status !== 'uploading') return res.json({ offset: v.size, done: true });
    const have = await offsetOf(w.id), offset = Number(req.query.offset);
    if (offset !== have) { req.resume(); return fail(res, 409, 'offset_mismatch', { offset: have }); }
    const len = Number(req.get('content-length'));
    if (!Number.isSafeInteger(len) || len <= 0 || len > MAX_CHUNK || have + len > v.size) { req.resume(); return fail(res, 400, 'bad_chunk'); }

    // Buffer the chunk, then append in one write: a dropped connection never leaves a partial chunk on disk.
    const parts = []; let got = 0;
    try {
      for await (const c of req) { got += c.length; if (got > len) break; parts.push(c); }
    } catch { return; } // client went away; nothing was written
    if (got !== len) return fail(res, 400, 'short_chunk', { offset: have });
    const fh = await fsp.open(incomingPath(w.id), 'a');
    try { await fh.write(Buffer.concat(parts)); await fh.sync(); } finally { await fh.close(); }

    const now = have + len;
    if (now === v.size) {
      v.status = 'received'; v.receivedAt = new Date().toISOString();
      await writeWish(w);
      kick();
    }
    res.json({ offset: now, done: now === v.size });
  }).catch(next);
});

/* ---------- admin: who has sent what ---------- */
async function allWishes() {
  const out = [];
  for (const f of await fsp.readdir(WISHES)) {
    if (!f.endsWith('.json')) continue;
    const w = await readWish(f.slice(0, -5));
    if (w) out.push(w);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = n => (n / 1e6).toFixed(1) + ' MB';
const VIDEO_STATE = { uploading: '上传中（还没传完）', received: '已收到，正在存入 R2', stored: '已存入 R2' };

app.get('/admin', wrap(async (req, res) => {
  if (!ADMIN_KEY || !sameToken(ADMIN_KEY, req.query.key)) return res.status(404).send('Not found');
  const ws = await allWishes();
  const rows = ws.map((w, i) => `<tr><td>${i + 1}</td><td>${esc(w.name)}</td><td>${esc(new Date(w.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</td>
<td class="m">${esc(w.message)}</td><td>${w.video ? esc(VIDEO_STATE[w.video.status] || w.video.status) + '<br><small>' + esc(w.video.name) + ' · ' + mb(w.video.size) + '</small>' : '没有视频'}</td>
<td>${w.synced ? '是' : '还没有'}</td></tr>`).join('');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>已收到的祝福</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}.m{white-space:pre-wrap;max-width:40em}small{color:#777}.w{overflow-x:auto}</style>
<h1>已收到 ${ws.length} 份祝福</h1><p>视频存储：${storage.enabled ? 'Cloudflare R2（' + esc(storage.bucket) + '）' : '<b style="color:#b00">R2 未配置，文件只在这台服务器上</b>'}。时间为北京时间。</p>
<div class="w"><table><tr><th>#</th><th>署名</th><th>时间</th><th>祝福</th><th>视频</th><th>文字已备份到 R2</th></tr>${rows}</table></div>`);
}));

app.get('/healthz', (req, res) => res.json({ ok: true, r2: storage.enabled }));
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders(res, p) {
    if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else if (p.includes(`${path.sep}fonts${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return fail(res, 413, 'too_large');
  if (err?.type === 'entity.parse.failed') return fail(res, 400, 'bad_json');
  console.error(new Date().toISOString(), req.method, req.path, err);
  if (!res.headersSent) fail(res, 500, 'server_error');
});

/* ---------- background sync to R2 ---------- */
let running = false, again = false, retryTimer = null;
function kick() {
  if (!storage.enabled) return;
  if (running) { again = true; return; }
  running = true;
  syncAll().catch(e => console.error('sync failed', e)).finally(() => {
    running = false;
    if (again) { again = false; kick(); }
  });
}
async function syncAll() {
  let failed = false;
  for (const snapshot of await allWishes()) {
    const id = snapshot.id;
    try {
      // Video first (slow, done outside the lock so chunk requests are never blocked).
      if (snapshot.video?.status === 'received') {
        const key = videoKey(snapshot);
        await storage.putFile(key, incomingPath(id), snapshot.video.type || 'application/octet-stream');
        const remote = await storage.size(key);
        if (remote !== snapshot.video.size) throw new Error(`size mismatch for ${key}: remote ${remote}, expected ${snapshot.video.size}`);
        await withWish(id, async () => {
          const w = await readWish(id);
          if (w.video?.status !== 'received') return;
          Object.assign(w.video, { status: 'stored', key, storedAt: new Date().toISOString() });
          w.synced = false;
          await writeWish(w);
        });
        await fsp.rm(incomingPath(id), { force: true });
        console.log(new Date().toISOString(), 'stored video', key);
      }
      // Then the record itself. Re-read under the lock so we upload exactly what we mark as synced.
      await withWish(id, async () => {
        const w = await readWish(id);
        if (!w || w.synced) return;
        const { token, ...pub } = w;
        await storage.putJSON(`wishes/${id}.json`, { ...pub, synced: undefined });
        w.synced = true;
        await writeWish(w);
      });
    } catch (e) {
      failed = true;
      console.error(new Date().toISOString(), 'sync error for', id, e.message);
    }
  }
  clearTimeout(retryTimer);
  if (failed) retryTimer = setTimeout(kick, 60_000);
}

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`listening on 127.0.0.1:${PORT} · data in ${DATA} · R2 ${storage.enabled ? 'on (' + storage.bucket + ')' : 'OFF (local only)'}`);
  kick();
});
server.requestTimeout = 0; // slow mobile uploads must not be cut off
server.headersTimeout = 60_000;
setInterval(kick, 10 * 60_000).unref();
