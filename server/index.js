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
// Viewing: each video also gets one browser-ready copy at its original resolution and frame rate (see media.js),
// kept in data/play/ and backed up to R2 under play/. Joey's page is served only under a secret path; in
// production Caddy serves the files in data/play/ itself, straight from disk.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStorage, makeMirror } from './storage.js';
import { prepare } from './media.js';

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
const mirror = makeMirror(process.env);   // optional: playable copies in mainland China

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

const log = (...a) => console.log(new Date().toISOString(), ...a);

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

// ---- which playable copy a video has ----
const RULE = 2;   // bump when media.js changes what it produces: every video is then prepared again
const playDone = v => v?.play?.status === 'done';
const playCurrent = v => playDone(v) && v.play.rule === RULE;
const gaveUp = v => v?.playFail?.rule === RULE && v.playFail.attempts >= 2;
const settled = v => playCurrent(v) || gaveUp(v);
const playFile = (id, v) => v.play.file || id;          // files made before RULE 2 were named by id alone

const dims = p => `${p.width}×${p.height} · ${p.fps ? Math.round(p.fps) + ' 帧' : ''}`;
const playCell = v => {
  if (!v || v.status === 'uploading') return '';
  const p = v.play, out = [];
  if (p?.from) out.push(`原片：${esc(p.from.codec.toUpperCase())}${p.from.hdr ? ' HDR' : ''} · ${dims(p.from)} · ${p.from.mbps} Mb/s`);
  if (playCurrent(v)) {
    const mbps = p.duration ? p.size * 8 / p.duration / 1e6 : 0;
    out.push(`播放版：${p.mode === 'direct' ? '直接用原片画面（未重新编码）' : '已转成 H.264'} · ${dims(p)} · ${mb(p.size)} · <span class="rate" data-mbps="${mbps.toFixed(2)}" data-dur="${p.duration.toFixed(1)}">${mbps.toFixed(1)} Mb/s</span>${storage.enabled ? (p.synced ? ' · 已备份' : ' · 备份中') : ''}${mirror.enabled ? (p.mirrored ? ' · 已同步到大陆' : ' · 正在同步到大陆') : ''}`);
  } else if (gaveUp(v)) out.push('<span style="color:#b00">播放版：生成失败，Joey 会看到' + (playDone(v) ? '旧的播放版' : '原片') + '</span>');
  else out.push('播放版：' + (playDone(v) ? '正在按新规则重新生成（期间 Joey 看到旧版）' : '生成中'));
  return out.map(t => '<br><small>' + t + '</small>').join('');
};

const admin = (req, res, next) => (ADMIN_KEY && sameToken(ADMIN_KEY, req.query.key) ? next() : res.status(404).send('Not found'));

app.get('/admin', admin, wrap(async (req, res) => {
  const ws = await allWishes();
  const routes = await speedRoutes(`/admin/speed?mb=24&key=${encodeURIComponent(req.query.key)}`);
  const rows = ws.map((w, i) => `<tr data-id="${w.id}"><td>${i + 1}</td><td>${esc(w.name)}</td><td>${esc(new Date(w.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</td>
<td class="m">${esc(w.message)}</td><td>${fileCell(w.cover, '没有封面')}</td><td>${fileCell(w.video, '没有视频')}${playCell(w.video)}</td>
<td>${w.synced ? '是' : '还没有'}</td><td class="del"><button class="ask">删除</button><span hidden>确定删除 ${esc(w.name)} 的这条？删了找不回来。<br><button class="yes">确定删除</button> <button class="no">取消</button></span></td></tr>`).join('');
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>已收到的祝福</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}.m{white-space:pre-wrap;max-width:36em}small{color:#777}.w{overflow-x:auto}
button{font:inherit;padding:4px 12px;border:1px solid #bbb;border-radius:6px;background:#fff;cursor:pointer}button:disabled{opacity:.5}
.yes{border-color:#b00;background:#b00;color:#fff}.del{min-width:9em}.del span{color:#b00}.box{background:#f6f3f0;border-radius:8px;padding:12px 16px;margin:12px 0}.wait{color:#b00}</style>
<h1>已收到 ${ws.length} 份祝福</h1>${VIEW_KEY ? `<p><a href="/for-joey/${esc(VIEW_KEY)}">打开 Joey 会看到的页面</a>（这个网址只给 Joey）</p>` : ''}<p>文件存储：${storage.enabled ? 'Cloudflare R2（' + esc(storage.bucket) + '）' : '<b style="color:#b00">R2 未配置，文件只在这台服务器上</b>'}。时间为北京时间。</p>
<div class="box"><button id="speed">测一下网速</button> <span id="speed-out">分别测每条线路下载到你这台设备的速度。在 Joey 会用的网络上测最有参考价值。</span>
<p style="margin:8px 0 0">想知道大陆那边的速度：把这个测速链接发给在大陆的朋友，请对方打开后截图给你（这个链接只能测速，看不到祝福）：<br><code style="user-select:all">https://${esc(req.get('host'))}/speedtest/${TEST_KEY}</code></p></div>
<div class="w"><table><tr><th>#</th><th>署名</th><th>时间</th><th>祝福</th><th>封面照片</th><th>视频</th><th>文字已备份到 R2</th><th></th></tr>${rows}</table></div>
<script>
const key = new URLSearchParams(location.search).get('key');
document.querySelector('table').addEventListener('click', async e => {
  const td = e.target.closest('.del'); if (!td) return;
  const ask = td.querySelector('.ask'), box = td.querySelector('span');
  if (e.target.matches('.ask')) { ask.hidden = true; box.hidden = false; }
  if (e.target.matches('.no')) { ask.hidden = false; box.hidden = true; }
  if (e.target.matches('.yes')) {
    e.target.disabled = true; e.target.textContent = '正在删除…';
    const r = await fetch('/admin/delete/' + td.parentElement.dataset.id + '?key=' + encodeURIComponent(key), { method: 'POST' }).catch(() => null);
    if (r && r.ok) td.parentElement.remove();
    else { box.innerHTML = '没删成：' + (r ? (await r.json().catch(() => ({}))).error || r.status : '网络错误') + '。刷新页面再试。'; }
  }
});
const ROUTES = ${JSON.stringify(routes)};
${MEASURE_JS}
document.getElementById('speed').onclick = async e => {
  const out = document.getElementById('speed-out'); e.target.disabled = true;
  document.querySelectorAll('.est').forEach(el => el.remove());
  const best = await runSpeedTest(ROUTES, text => { out.textContent = text; });
  const mbps = best;
  if (mbps) out.textContent += ' Joey 的页面会自动用最快的那一路，下面按 ' + mbps.toFixed(1) + ' Mb/s 估算每个视频开播前要等多久。';
  e.target.disabled = false;
  if (!mbps) return;
  {
    document.querySelectorAll('.rate').forEach(el => {
      const b = +el.dataset.mbps, d = +el.dataset.dur, wait = Math.max(0, d * (b / mbps - 1));
      el.insertAdjacentHTML('afterend', wait < 1 ? '<span class="est"> · 可以边下边播</span>' : '<span class="est"> · <span class="wait">边下边播来不及，开播前约等 ' + Math.ceil(wait) + ' 秒（后台预加载好了就不用等）</span></span>');
    });
  }
};
</script>`);
}));

// Incompressible bytes for the speed test. The same 24 MB also sits in R2 (and COS), to test those routes.
const NOISE = crypto.randomBytes(1 << 20);
const SPEED_KEY = 'speedtest/24mb.bin';
async function ensureSpeedObject(store) {
  if (!store.enabled) return;
  try { if ((await store.size(SPEED_KEY)) === 24 * NOISE.length) return; } catch {}
  await store.putBuffer(SPEED_KEY, Buffer.concat(Array(24).fill(NOISE)), 'application/octet-stream');
  log('stored', SPEED_KEY, 'in', store.name);
}
function sendNoise(req, res) {
  let left = Math.min(Math.max(Number(req.query.mb) || 8, 1), 64);
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': left * NOISE.length, 'Cache-Control': 'no-store' });
  (function send() { while (left-- > 0) { if (!res.write(NOISE)) return res.once('drain', send); } res.end(); })();
}
// Every route a video can take to Joey, as [label, url] pairs for the speed test.
async function speedRoutes(serverUrl) {
  const out = [['香港服务器', serverUrl]];
  if (storage.enabled) out.push(['Cloudflare', await storage.presign(SPEED_KEY, 3600).catch(() => '')]);
  if (mirror.enabled) out.push(['腾讯云大陆 COS', await mirror.presign(SPEED_KEY, 3600).catch(() => '')]);
  return out;
}
// Client code: download each route for up to 20 s and report megabits per second; resolves with the best.
const MEASURE_JS = `
async function measure(url){
  const ctrl = new AbortController(), stop = setTimeout(() => ctrl.abort(), 20000);
  let n = 0, tFirst = 0;
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const reader = r.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (!tFirst) tFirst = performance.now(); n += value.length; }
  } catch (err) { if (!ctrl.signal.aborted) throw err; } finally { clearTimeout(stop); }
  if (n < 1e6) throw new Error('20 秒内只下到 ' + (n / 1e6).toFixed(1) + ' MB');
  return n * 8 / ((performance.now() - tFirst) / 1000) / 1e6;
}
async function runSpeedTest(routes, show){
  const done = []; let best = 0;
  for (const [label, url] of routes) {
    show(done.concat(label + ' 测速中…').join('；'));
    if (!url) { done.push(label + ' 未就绪'); continue; }
    try { const v = await measure(url); best = Math.max(best, v); done.push(label + ' ' + v.toFixed(1) + ' Mb/s'); }
    catch (err) { done.push(label + ' 测速失败' + (label === '香港服务器' ? '（' + err.message + '）' : '（多半是存储桶还没设置 CORS）')); }
  }
  show(done.join('；') + '。');
  return best;
}`;
// A link that can be sent to anyone to measure their speed on every route; it shows no wishes and allows nothing else.
const TEST_KEY = ADMIN_KEY ? crypto.createHash('sha256').update('speedtest:' + ADMIN_KEY).digest('hex').slice(0, 16) : '';
const tester = (req, res, next) => (TEST_KEY && sameToken(TEST_KEY, req.params.t) ? next() : res.status(404).send('Not found'));
app.get('/speedtest/:t/data', tester, sendNoise);
app.get('/speedtest/:t', tester, wrap(async (req, res) => {
  const routes = await speedRoutes(`/speedtest/${TEST_KEY}/data?mb=24`);
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>网速测试</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#3B0B19;color:#F7ECE6;font:15px/1.8 system-ui,-apple-system,"PingFang SC",sans-serif;padding:24px}
main{max-width:30em;display:flex;flex-direction:column;gap:18px;text-align:center}h1{margin:0;font-weight:400;letter-spacing:.2em}
p{margin:0;color:rgba(247,236,230,.7)}#out{color:#F4E2C2;font-size:17px;min-height:3.6em}
button{font:inherit;font-size:16px;padding:12px 32px;border:0;border-radius:999px;background:linear-gradient(135deg,#F4E2C2,#D8B98C 45%,#A8804D);color:#25060F;cursor:pointer}
button:disabled{opacity:.5}</style>
<main><h1>网速测试</h1><p>点下面的按钮，大约一分钟测完。测完请截图发回给我，谢谢！</p><div id="out"></div><button id="go">开始测速</button></main>
<script>const ROUTES = ${JSON.stringify(routes)};${MEASURE_JS}
document.getElementById('go').onclick = async e => { e.target.disabled = true; await runSpeedTest(ROUTES, t => { document.getElementById('out').textContent = t; }); e.target.textContent = '再测一次'; e.target.disabled = false; };
</script></html>`);
}));
app.get('/admin/speed', admin, sendNoise);

// Remove one wish everywhere: the R2 copies first (so a failure leaves something to retry), then local files.
const gone = new Set();   // ids deleted while a background job may still be holding them
async function purge(id) {
  if (storage.enabled) {
    for (const prefix of ['wishes/', 'originals/', 'covers/', 'play/']) {
      for (const key of await storage.list(prefix + id)) await storage.remove(key);
    }
  }
  if (mirror.enabled) for (const key of await mirror.list('play/' + id)) await mirror.remove(key);
  await fsp.rm(wishPath(id), { force: true });
  await fsp.rm(KINDS.video.local(id), { force: true });
  await fsp.rm(KINDS.cover.local(id), { force: true });
  await fsp.rm(path.join(COVERS, id), { force: true });
  for (const f of await fsp.readdir(PLAY)) if (f.startsWith(id)) await fsp.rm(path.join(PLAY, f), { force: true });
}
app.post('/admin/delete/:id', admin, wrap(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return fail(res, 404, 'not_found');
  gone.add(id);
  await withWish(id, () => purge(id));
  log('deleted', id);
  res.json({ ok: true });
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
const playable = v => !!v && v.status !== 'uploading' && (playDone(v) || gaveUp(v));
const viewer = (req, res, next) => (VIEW_KEY && sameToken(VIEW_KEY, req.params.key) ? next() : res.status(404).send('Not found'));
const media = { headers: { 'Cache-Control': 'private, max-age=86400' } };
const forever = { headers: { 'Cache-Control': 'private, max-age=31536000, immutable' } };

app.get('/for-joey/:key', viewer, (req, res) => {
  res.set({ 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  res.sendFile(path.join(ROOT, 'views', 'joey.html'));
});
// Shuffled, but the same shuffle every time: the numbers on the seals say how many, not who came first.
app.get('/api/view/:key/wishes', viewer, wrap(async (req, res) => {
  const rank = w => crypto.createHash('sha1').update(VIEW_KEY + w.id).digest('hex');
  const ws = (await allWishes()).sort((a, b) => rank(a).localeCompare(rank(b)));
  res.set('Cache-Control', 'no-store').json(await Promise.all(ws.map(async w => ({
    id: w.id, name: w.name, message: w.message,
    cover: !!w.cover && w.cover.status !== 'uploading',
    video: w.video && w.video.status !== 'uploading' ? await videoView(w) : null,
  }))));
}));
// Each playable video has up to three addresses: this server, and (once copied there) the same file straight from
// Cloudflare R2 or from Tencent Cloud COS in mainland China, through links that expire. Joey's browser measures
// them and plays from whichever is fastest where she is.
// Prepared files have a name that changes whenever they are remade, so browsers may keep them forever.
const ALT_TTL = 3 * 24 * 3600;
async function videoView(w) {
  const v = w.video, p = v.play;
  if (playDone(v)) {
    const file = playFile(w.id, v), base = `/media/${VIEW_KEY}/${file}`;
    const alts = {};
    if (storage.enabled && p.synced) alts.r2 = await storage.presign(`play/${file}.mp4`, ALT_TTL).catch(() => null);
    if (mirror.enabled && p.mirrored) alts.cos = await mirror.presign(`play/${file}.mp4`, ALT_TTL).catch(() => null);
    for (const k of Object.keys(alts)) if (!alts[k]) delete alts[k];
    return { ready: true, src: base + '.mp4', alts, poster: base + '.jpg', duration: p.duration, width: p.width, height: p.height, size: p.size };
  }
  if (gaveUp(v)) return { ready: true, src: `/api/view/${VIEW_KEY}/video/${w.id}`, poster: null, duration: 0, width: 0, height: 0, size: v.size };
  return { ready: false };
}
// Caddy answers /media/<key>/<file> itself when the file is on disk. This route covers local development and
// the case where a file has to be brought back from R2 first.
app.get('/media/:key/:file', viewer, wrap(async (req, res) => {
  const f = req.params.file;
  if (!/^[0-9a-f-]{36}(-[0-9a-z]+)?\.(mp4|jpg)$/.test(f)) return fail(res, 404, 'not_found');
  const file = await localOrFetch(path.join(PLAY, f), 'play/' + f).catch(() => null);
  file ? res.type(f.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg').sendFile(file, forever) : fail(res, 404, 'not_found');
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
// Only used when no playable copy could be made: hand over what the friend sent.
app.get('/api/view/:key/video/:id', viewer, viewWish, wrap(async (req, res) => {
  const w = req.wish, v = w.video;
  if (!v || v.status === 'uploading') return fail(res, 404, 'not_ready');
  const file = await localOrFetch(KINDS.video.local(w.id), v.key);
  file ? res.type(v.type || 'video/mp4').sendFile(file, media) : fail(res, 404, 'not_ready'); // sendFile answers Range requests
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
// The uploaded original may leave this disk only once R2 holds it and its playable copy is settled.
async function tidy(id) {
  const w = await readWish(id), v = w?.video;
  if (v?.status === 'stored' && settled(v)) await fsp.rm(KINDS.video.local(id), { force: true });
}
// Keep only the current playable copy of a video, here, in R2 and in COS.
async function dropOldPlay(id, keep) {
  for (const f of await fsp.readdir(PLAY)) if (f.startsWith(id) && !f.startsWith(keep + '.')) await fsp.rm(path.join(PLAY, f), { force: true });
  for (const store of [storage, mirror]) {
    if (store.enabled) for (const key of await store.list('play/' + id)) if (!key.startsWith(`play/${keep}.`)) await store.remove(key);
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
          if (w?.[kind]?.status !== 'received') return;
          Object.assign(w[kind], { status: 'stored', key, storedAt: new Date().toISOString() });
          w.synced = false;
          await writeWish(w);
        });
        if (kind === 'cover') await fsp.rename(local, path.join(COVERS, id)); // stays here for Joey's page
        log('stored', key);
      }
      // The playable copy and its poster.
      if (playDone(snapshot.video) && !snapshot.video.play.synced) {
        const file = playFile(id, snapshot.video);
        for (const [ext, type] of [['mp4', 'video/mp4'], ['jpg', 'image/jpeg']]) {
          const key = `play/${file}.${ext}`, local = path.join(PLAY, `${file}.${ext}`);
          await storage.putFile(key, local, type);
          const want = (await fsp.stat(local)).size, remote = await storage.size(key);
          if (remote !== want) throw new Error(`size mismatch for ${key}: remote ${remote}, expected ${want}`);
        }
        const kept = await withWish(id, async () => {
          const w = await readWish(id);
          if (!playDone(w?.video) || playFile(id, w.video) !== file) return false;
          w.video.play.synced = true; w.synced = false; await writeWish(w); return true;
        });
        if (kept) { await dropOldPlay(id, file); log('stored', `play/${file}.mp4`); }
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
      if (!gone.has(id)) { failed = true; console.error(new Date().toISOString(), 'sync error for', id, e.message); }
    }
    if (gone.has(id)) await purge(id).catch(() => {});   // deleted while we were copying it: clean up again
  }
  if (mirror.enabled && await mirrorAll()) failed = true;
  clearTimeout(retryTimer);
  if (failed) retryTimer = setTimeout(kick, 60_000);
}, 'sync');

// Copy each playable video to COS. Kept apart from the R2 work so a COS problem never holds up the backups.
async function mirrorAll() {
  let failed = false;
  for (const snapshot of await allWishes()) {
    const id = snapshot.id, v = snapshot.video;
    if (!playDone(v) || v.play.mirrored || gone.has(id)) continue;
    const file = playFile(id, v), key = `play/${file}.mp4`, local = path.join(PLAY, `${file}.mp4`);
    try {
      await mirror.putFile(key, local, 'video/mp4');
      const want = (await fsp.stat(local)).size, remote = await mirror.size(key);
      if (remote !== want) throw new Error(`size mismatch for ${key}: remote ${remote}, expected ${want}`);
      const kept = await withWish(id, async () => {
        const w = await readWish(id);
        if (!playDone(w?.video) || playFile(id, w.video) !== file) return false;
        w.video.play.mirrored = true; await writeWish(w); return true;
      });
      if (kept) { await dropOldPlay(id, file); log('mirrored', key); }
      else await mirror.remove(key);
    } catch (e) {
      if (!gone.has(id)) { failed = true; console.error(new Date().toISOString(), 'COS copy error for', id, e.message); }
    }
  }
  return failed;
}

/* ---------- background preparation of the playable copy ---------- */
// Separate from the R2 queue on purpose: a slow conversion must never delay getting an original into R2.
const kickPlay = queue(async () => {
  for (const snapshot of await allWishes()) {
    const id = snapshot.id, v = snapshot.video;
    if (!v || v.status === 'uploading' || settled(v) || gone.has(id)) continue;
    const file = `${id}-${Date.now().toString(36)}`;
    let play = null, error = null;
    try {
      const src = await localOrFetch(KINDS.video.local(id), v.key);
      if (!src) throw new Error('original not found');
      const t0 = Date.now();
      const out = await prepare(src, path.join(PLAY, file + '.mp4'), path.join(PLAY, file + '.jpg'));
      play = { status: 'done', rule: RULE, file, ...out, synced: false, at: new Date().toISOString() };
      log(out.mode, id, `${out.width}x${out.height}@${Math.round(out.fps)}`, mb(v.size), '->', mb(out.size), `in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      error = String(e.message).slice(0, 500);
      console.error(new Date().toISOString(), 'could not prepare', id, error);
    }
    const saved = await withWish(id, async () => {
      const w = await readWish(id);
      if (!w?.video || w.video.size !== v.size || w.video.name !== v.name) return false; // deleted or replaced meanwhile
      if (play) { w.video.play = play; delete w.video.playFail; }
      else w.video.playFail = { rule: RULE, attempts: (w.video.playFail?.rule === RULE ? w.video.playFail.attempts : 0) + 1, error };
      w.synced = false;
      await writeWish(w);
      return true;
    });
    if (!saved || gone.has(id)) { await purgeOrphans(id, file); continue; }
    if (play && !storage.enabled) await dropOldPlay(id, file);   // with R2 on, the sync queue does this once the new copy is safe
    await tidy(id);
    kick();
  }
}, 'prepare');
async function purgeOrphans(id, file) {
  if (gone.has(id)) return purge(id).catch(() => {});
  for (const ext of ['mp4', 'jpg']) await fsp.rm(path.join(PLAY, `${file}.${ext}`), { force: true });
}

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`listening on 127.0.0.1:${PORT} · data in ${DATA} · R2 ${storage.enabled ? 'on (' + storage.bucket + ')' : 'OFF (local only)'} · COS ${mirror.enabled ? 'on (' + mirror.bucket + ')' : 'off'}`);
  kick(); kickPlay();
  for (const store of [storage, mirror]) ensureSpeedObject(store).catch(e => console.error('speed test file in', store.name, e.message));
});
server.requestTimeout = 0; // slow mobile uploads must not be cut off
server.headersTimeout = 60_000;
setInterval(() => { kick(); kickPlay(); }, 10 * 60_000).unref();
