// Joey's birthday mailbox: friends post a wish (text) and optionally a video.
//
// Durability model
//   1. A wish is written to local disk (data/wishes/<id>.json) before the client is told it is saved.
//   2. A video (and an optional cover photo) is appended chunk by chunk under data/incoming/; the client can
//      resume after any drop.
//   3. Once complete, a background worker copies the wish JSON and the original files to R2 and
//      verifies the remote size. A local file is deleted only after that check passes.
//   4. On boot the worker rescans every wish, so a crash or reboot never strands a file.
//
// Viewing: each video is also converted once to a browser-ready 1080p MP4 (data/play/, copied to R2 under
// play/). Joey's page is served only under a secret path and reads covers and videos from this server.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStorage } from './storage.js';
import { transcode } from './media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const WISHES = path.join(DATA, 'wishes');
const INCOMING = path.join(DATA, 'incoming');
const PLAY = path.join(DATA, 'play');       // browser-ready videos and their posters, kept on this server
const COVERS = path.join(DATA, 'covers');   // cover photos, kept on this server
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const VIEW_KEY = process.env.VIEW_KEY || ''; // Joey's page lives at /for-joey/<VIEW_KEY>
const MAX_VIDEO = Number(process.env.MAX_VIDEO_BYTES || 4 * 1024 ** 3); // 4 GB
const MAX_CHUNK = 16 * 1024 ** 2;
const MAX_MESSAGE = 20000;
const DISK_RESERVE = 1024 ** 3; // keep 1 GB free

fs.mkdirSync(WISHES, { recursive: true });
fs.mkdirSync(INCOMING, { recursive: true });
fs.mkdirSync(PLAY, { recursive: true });
fs.mkdirSync(COVERS, { recursive: true });
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
// A wish can carry two files: the video and a postcard cover photo. Both use the same resumable protocol.
const KINDS = {
  video: {
    max: MAX_VIDEO, prefix: 'originals', fallback: 'mp4', local: id => path.join(INCOMING, id),
    exts: new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mpg', 'mpeg', 'wmv', 'hevc', 'ts', 'mts']),
  },
  cover: {
    max: 40 * 1024 ** 2, prefix: 'covers', fallback: 'jpg', local: id => path.join(INCOMING, id + '.cover'),
    exts: new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif']),
  },
};
const extOf = (kind, name) => {
  const e = (String(name).match(/\.([A-Za-z0-9]{1,5})$/) || [])[1];
  return e && KINDS[kind].exts.has(e.toLowerCase()) ? e.toLowerCase() : KINDS[kind].fallback;
};
const fileKey = (kind, w) => `${KINDS[kind].prefix}/${w.id}.${extOf(kind, w[kind].name)}`;

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
      video: null, cover: null, synced: false,
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
const offsetOf = async (kind, id) => { try { return (await fsp.stat(KINDS[kind].local(id))).size; } catch { return 0; } };
const FILE = '/api/wishes/:id/:kind(video|cover)';

// Declare a file. Calling it again with the same file resumes; a different file starts over.
app.post(FILE, express.json({ limit: '20kb' }), own, wrap(async (req, res) => {
  const { id, kind } = req.params;
  const size = Number(req.body?.size), name = String(req.body?.name ?? kind).slice(0, 200);
  const type = String(req.body?.type ?? '').slice(0, 100);
  if (!Number.isSafeInteger(size) || size <= 0) return fail(res, 400, 'bad_size');
  if (size > KINDS[kind].max) return fail(res, 413, 'too_large', { max: KINDS[kind].max });

  const out = await withWish(id, async () => {
    const w = await readWish(id), f = w[kind];
    if (f && f.status !== 'uploading' && f.size === size && f.name === name) return { offset: size, done: true };
    const same = f && f.status === 'uploading' && f.size === size && f.name === name;
    if (!same) {
      await fsp.rm(KINDS[kind].local(id), { force: true });
      const { bavail, bsize } = await fsp.statfs(DATA);
      if (bavail * bsize < size + DISK_RESERVE) return { full: true };
      w[kind] = { name, type, size, status: 'uploading', startedAt: new Date().toISOString() };
      w.synced = false;
      await writeWish(w);
    }
    return { offset: Math.min(await offsetOf(kind, id), size) };
  });
  if (out.full) return fail(res, 507, 'server_full');
  res.json(out);
}));

app.get(FILE, own, wrap(async (req, res) => {
  const { id, kind } = req.params, f = req.wish[kind];
  if (!f) return fail(res, 404, 'no_file');
  res.json({ offset: f.status === 'uploading' ? await offsetOf(kind, id) : f.size, size: f.size, done: f.status !== 'uploading' });
}));

// Append one chunk at ?offset=N. If the offset is wrong, answer 409 with the real one so the client realigns.
app.put(FILE, own, (req, res, next) => {
  const { id, kind } = req.params;
  withWish(id, async () => {
    const w = await readWish(id), f = w[kind];
    if (!f) return fail(res, 404, 'no_file');
    if (f.status !== 'uploading') return res.json({ offset: f.size, done: true });
    const have = await offsetOf(kind, id), offset = Number(req.query.offset);
    if (offset !== have) { req.resume(); return fail(res, 409, 'offset_mismatch', { offset: have }); }
    const len = Number(req.get('content-length'));
    if (!Number.isSafeInteger(len) || len <= 0 || len > MAX_CHUNK || have + len > f.size) { req.resume(); return fail(res, 400, 'bad_chunk'); }

    // Buffer the chunk, then append in one write: a dropped connection never leaves a partial chunk on disk.
    const parts = []; let got = 0;
    try {
      for await (const c of req) { got += c.length; if (got > len) break; parts.push(c); }
    } catch { return; } // client went away; nothing was written
    if (got !== len) return fail(res, 400, 'short_chunk', { offset: have });
    const fh = await fsp.open(KINDS[kind].local(id), 'a');
    try { await fh.write(Buffer.concat(parts)); await fh.sync(); } finally { await fh.close(); }

    const now = have + len;
    if (now === f.size) {
      f.status = 'received'; f.receivedAt = new Date().toISOString();
      await writeWish(w);
      kick(); kickPlay();
    }
    res.json({ offset: now, done: now === f.size });
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
const FILE_STATE = { uploading: '上传中（还没传完）', received: '已收到，正在存入 R2', stored: '已存入 R2' };

const fileCell = (f, none) => f ? esc(FILE_STATE[f.status] || f.status) + '<br><small>' + esc(f.name) + ' · ' + mb(f.size) + '</small>' : none;

const playCell = v => {
  if (!v || v.status === 'uploading') return '';
  const p = v.play;
  if (p?.status === 'done') return `<br><small>播放版：已生成 · ${p.width}×${p.height} · ${mb(p.size)}${storage.enabled ? (p.synced ? ' · 已备份' : ' · 备份中') : ''}</small>`;
  if (p?.status === 'failed' && p.attempts >= 2) return '<br><small style="color:#b00">播放版：生成失败，Joey 会看到原片</small>';
  return '<br><small>播放版：生成中</small>';
};

app.get('/admin', wrap(async (req, res) => {
  if (!ADMIN_KEY || !sameToken(ADMIN_KEY, req.query.key)) return res.status(404).send('Not found');
  const ws = await allWishes();
  const rows = ws.map((w, i) => `<tr><td>${i + 1}</td><td>${esc(w.name)}</td><td>${esc(new Date(w.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</td>
<td class="m">${esc(w.message)}</td><td>${fileCell(w.cover, '没有封面')}</td><td>${fileCell(w.video, '没有视频')}${playCell(w.video)}</td>
<td>${w.synced ? '是' : '还没有'}</td></tr>`).join('');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>已收到的祝福</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}.m{white-space:pre-wrap;max-width:40em}small{color:#777}.w{overflow-x:auto}</style>
<h1>已收到 ${ws.length} 份祝福</h1>${VIEW_KEY ? `<p><a href="/for-joey/${esc(VIEW_KEY)}">打开 Joey 会看到的页面</a>（这个网址只给 Joey）</p>` : ''}<p>文件存储：${storage.enabled ? 'Cloudflare R2（' + esc(storage.bucket) + '）' : '<b style="color:#b00">R2 未配置，文件只在这台服务器上</b>'}。时间为北京时间。</p>
<div class="w"><table><tr><th>#</th><th>署名</th><th>时间</th><th>祝福</th><th>封面照片</th><th>视频</th><th>文字已备份到 R2</th></tr>${rows}</table></div>`);
}));

/* ---------- Joey's page ---------- */
const exists = async f => { try { await fsp.access(f); return true; } catch { return false; } };
// Local file if present, otherwise restore it from R2 (e.g. after moving to a new server).
async function localOrFetch(file, key) {
  if (await exists(file)) return file;
  if (!storage.enabled || !key) return null;
  await storage.getFile(key, file);
  return file;
}
const playable = v => !!v && v.status !== 'uploading' && (v.play?.status === 'done' || (v.play?.status === 'failed' && v.play.attempts >= 2));
const viewer = (req, res, next) => (VIEW_KEY && sameToken(VIEW_KEY, req.params.key) ? next() : res.status(404).send('Not found'));
const media = { headers: { 'Cache-Control': 'private, max-age=86400' } };

app.get('/for-joey/:key', viewer, (req, res) => {
  res.set({ 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  res.sendFile(path.join(ROOT, 'views', 'joey.html'));
});
// Shuffled, but the same shuffle every time: the numbers on the seals say how many, not who came first.
app.get('/api/view/:key/wishes', viewer, wrap(async (req, res) => {
  const rank = w => crypto.createHash('sha1').update(VIEW_KEY + w.id).digest('hex');
  const ws = (await allWishes()).sort((a, b) => rank(a).localeCompare(rank(b)));
  res.set('Cache-Control', 'no-store').json(ws.map(w => ({
    id: w.id, name: w.name, message: w.message,
    cover: !!w.cover && w.cover.status !== 'uploading',
    video: w.video && w.video.status !== 'uploading'
      ? { ready: playable(w.video), duration: w.video.play?.duration || 0, width: w.video.play?.width || 0, height: w.video.play?.height || 0, poster: w.video.play?.status === 'done' }
      : null,
  })));
}));
const viewWish = wrap(async (req, res, next) => {
  req.wish = await readWish(req.params.id);
  req.wish ? next() : fail(res, 404, 'not_found');
});
app.get('/api/view/:key/cover/:id', viewer, viewWish, wrap(async (req, res) => {
  const w = req.wish, c = w.cover;
  if (!c || c.status === 'uploading') return fail(res, 404, 'no_cover');
  const file = c.status === 'received' ? KINDS.cover.local(w.id) : await localOrFetch(path.join(COVERS, w.id), c.key);
  if (!file) return fail(res, 404, 'no_cover');
  res.type(c.type && c.type.startsWith('image/') ? c.type : 'image/jpeg').sendFile(file, media);
}));
app.get('/api/view/:key/poster/:id', viewer, viewWish, wrap(async (req, res) => {
  if (req.wish.video?.play?.status !== 'done') return fail(res, 404, 'no_poster');
  const file = await localOrFetch(path.join(PLAY, req.wish.id + '.jpg'), `play/${req.wish.id}.jpg`);
  file ? res.type('image/jpeg').sendFile(file, media) : fail(res, 404, 'no_poster');
}));
app.get('/api/view/:key/video/:id', viewer, viewWish, wrap(async (req, res) => {
  const w = req.wish, v = w.video;
  if (!playable(v)) return fail(res, 404, 'not_ready');
  const file = v.play.status === 'done'
    ? await localOrFetch(path.join(PLAY, w.id + '.mp4'), `play/${w.id}.mp4`)
    : await localOrFetch(KINDS.video.local(w.id), v.key);            // conversion failed: fall back to what was sent
  if (!file) return fail(res, 404, 'not_ready');
  res.type(v.play.status === 'done' ? 'video/mp4' : (v.type || 'video/mp4')).sendFile(file, media); // sendFile answers Range requests
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
// One long-running job at a time per queue; a request to run while busy means "run once more afterwards".
function queue(job, label) {
  let running = false, again = false;
  return function kick() {
    if (running) { again = true; return; }
    running = true;
    job().catch(e => console.error(label, 'failed', e)).finally(() => {
      running = false;
      if (again) { again = false; kick(); }
    });
  };
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
// The uploaded original may leave this disk only once R2 holds it and the playable copy exists (or cannot be made).
async function tidy(id) {
  const w = await readWish(id), v = w?.video;
  if (v?.status === 'stored' && (v.play?.status === 'done' || (v.play?.status === 'failed' && v.play.attempts >= 2))) {
    await fsp.rm(KINDS.video.local(id), { force: true });
  }
}

let retryTimer = null;
const kick = queue(async () => {
  if (!storage.enabled) return;
  let failed = false;
  for (const snapshot of await allWishes()) {
    const id = snapshot.id;
    try {
      // Files first (slow, done outside the lock so chunk requests are never blocked).
      for (const kind of Object.keys(KINDS)) {
        const f = snapshot[kind];
        if (f?.status !== 'received') continue;
        const key = fileKey(kind, snapshot), local = KINDS[kind].local(id);
        await storage.putFile(key, local, f.type || 'application/octet-stream');
        const remote = await storage.size(key);
        if (remote !== f.size) throw new Error(`size mismatch for ${key}: remote ${remote}, expected ${f.size}`);
        await withWish(id, async () => {
          const w = await readWish(id);
          if (w[kind]?.status !== 'received') return;
          Object.assign(w[kind], { status: 'stored', key, storedAt: new Date().toISOString() });
          w.synced = false;
          await writeWish(w);
        });
        if (kind === 'cover') await fsp.rename(local, path.join(COVERS, id)); // stays here for Joey's page
        log('stored', key);
      }
      // The browser-ready video and its poster.
      if (snapshot.video?.play?.status === 'done' && !snapshot.video.play.synced) {
        for (const [ext, type] of [['mp4', 'video/mp4'], ['jpg', 'image/jpeg']]) {
          const key = `play/${id}.${ext}`, local = path.join(PLAY, `${id}.${ext}`);
          await storage.putFile(key, local, type);
          const want = (await fsp.stat(local)).size, remote = await storage.size(key);
          if (remote !== want) throw new Error(`size mismatch for ${key}: remote ${remote}, expected ${want}`);
        }
        await withWish(id, async () => {
          const w = await readWish(id);
          if (w.video?.play?.status === 'done') { w.video.play.synced = true; w.synced = false; await writeWish(w); }
        });
        log('stored', `play/${id}.mp4`);
      }
      await tidy(id);
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
}, 'sync');

/* ---------- background conversion to a browser-ready video ---------- */
// Separate from the R2 queue on purpose: a slow conversion must never delay getting an original into R2.
const kickPlay = queue(async () => {
  for (const snapshot of await allWishes()) {
    const id = snapshot.id, v = snapshot.video;
    if (!v || v.status === 'uploading' || v.play?.status === 'done' || (v.play?.status === 'failed' && v.play.attempts >= 2)) continue;
    let play;
    try {
      const src = await localOrFetch(KINDS.video.local(id), v.key);
      if (!src) throw new Error('original not found');
      const t0 = Date.now();
      const out = await transcode(src, path.join(PLAY, id + '.mp4'), path.join(PLAY, id + '.jpg'));
      play = { status: 'done', ...out, synced: false, at: new Date().toISOString() };
      log('converted', id, `${out.width}x${out.height}`, mb(v.size), '->', mb(out.size), `in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      play = { status: 'failed', attempts: (v.play?.attempts || 0) + 1, error: String(e.message).slice(0, 500) };
      console.error(new Date().toISOString(), 'conversion error for', id, e.message);
    }
    await withWish(id, async () => {
      const w = await readWish(id);
      if (!w?.video || w.video.size !== v.size || w.video.name !== v.name) return; // replaced meanwhile
      w.video.play = play; w.synced = false;
      await writeWish(w);
    });
    await tidy(id);
    kick();
  }
}, 'conversion');

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`listening on 127.0.0.1:${PORT} · data in ${DATA} · R2 ${storage.enabled ? 'on (' + storage.bucket + ')' : 'OFF (local only)'}`);
  kick(); kickPlay();
});
server.requestTimeout = 0; // slow mobile uploads must not be cut off
server.headersTimeout = 60_000;
setInterval(() => { kick(); kickPlay(); }, 10 * 60_000).unref();
