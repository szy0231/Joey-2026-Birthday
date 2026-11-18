#!/usr/bin/env node
// Packs everything worth keeping into one zip:
//   Dear Joey.html     the page Joey saw, working from the folder with no server and no internet
//   files/             the playable videos, their poster frames and the postcard photos that page uses
//   原片 Originals/     every friend's video exactly as it was uploaded
//   祝福 Messages.txt   all the messages, readable;  messages.json  the same for programs
//
// Run on the server as `joey-export` (add --no-cloud to skip the copy to R2). The zip lands in data/export/ and,
// when R2 is set up, also in R2 under export/; the admin page shows a download link for each.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeStorage } from '../server/storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n') : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const OUT = path.join(DATA, 'export'), WORK = path.join(OUT, 'work');
const VIEW_KEY = process.env.VIEW_KEY || '';
const storage = makeStorage(process.env);
const cloud = storage.enabled && !process.argv.includes('--no-cloud');
const TOP = 'Dear Joey', ORIG = '原片 Originals';

const say = (...a) => console.log(...a);
const mb = n => (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + ' MB';
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const sizeOf = p => fs.statSync(p).size;
const clock = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
// A friend's name, made safe as part of a file name on Windows and macOS.
const safe = s => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'friend';

async function main() {
  // The postcards, in the order Joey saw them: no video first, then videos from smallest to largest.
  const wishes = [];
  for (const f of await fsp.readdir(path.join(DATA, 'wishes'))) {
    if (!f.endsWith('.json')) continue;
    try { wishes.push(JSON.parse(await fsp.readFile(path.join(DATA, 'wishes', f), 'utf8'))); } catch {}
  }
  const rank = w => crypto.createHash('sha1').update(VIEW_KEY + w.id).digest('hex');
  const weight = w => (w.video && w.video.status !== 'uploading' ? (w.video.play?.size || w.video.size) : 0);
  wishes.sort((a, b) => weight(a) - weight(b) || rank(a).localeCompare(rank(b)));
  if (!wishes.length) { say('还没有任何祝福，没什么可导出的。'); return; }
  say(`共 ${wishes.length} 封明信片。`);

  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(path.join(WORK, 'r2'), { recursive: true });

  // Where each file can be found: on this server, or in R2 (fetched into WORK when needed).
  const plan = [];   // { local, key, size, arc }
  const want = (local, key, arc, size) => {
    if (local && exists(local)) plan.push({ local, arc, size: sizeOf(local) });
    else if (key && storage.enabled) plan.push({ key, arc, size: size || 0 });
    else say(`  找不到 ${arc}，跳过`);
  };
  const keepsake = [], text = [], records = [];
  wishes.forEach((w, k) => {
    const nn = String(k + 1).padStart(2, '0'), v = w.video, c = w.cover, card = { id: w.id, name: w.name, message: w.message, cover: null, video: null };
    if (c && c.status !== 'uploading') {
      const local = c.status === 'received' ? path.join(DATA, 'incoming', w.id + '.cover') : path.join(DATA, 'covers', w.id);
      want(local, c.key, `${TOP}/files/${nn}-photo.jpg`, c.size);
      card.cover = `files/${nn}-photo.jpg`;
    }
    let original = null;
    if (v && v.status !== 'uploading') {
      const ext = (String(v.name).match(/\.([A-Za-z0-9]{1,5})$/) || [, 'mp4'])[1].toLowerCase();
      original = `${ORIG}/${nn} ${safe(w.name)}.${ext}`;
      want(path.join(DATA, 'incoming', w.id), v.key, `${TOP}/${original}`, v.size);
      const p = v.play;
      if (p && p.status === 'done') {
        const file = p.file || w.id;
        want(path.join(DATA, 'play', file + '.mp4'), `play/${file}.mp4`, `${TOP}/files/${nn}.mp4`, p.size);
        want(path.join(DATA, 'play', file + '.jpg'), `play/${file}.jpg`, `${TOP}/files/${nn}.jpg`);
        card.video = { ready: true, src: `files/${nn}.mp4`, poster: `files/${nn}.jpg`, duration: p.duration, width: p.width, height: p.height, size: p.size };
      } else {
        // No playable copy was made: the page plays the original, which some browsers may not manage.
        card.video = { ready: true, src: original.split('/').map(encodeURIComponent).join('/'), poster: null, duration: 0, width: 0, height: 0, size: v.size };
      }
    }
    keepsake.push(card);
    const when = new Date(w.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    text.push(`${nn}  ${w.name}\n${when}\n\n${w.message}\n` + (card.video ? `\n（视频：${original}${v.play?.duration ? ' · ' + clock(v.play.duration) : ''}）\n` : '') + (card.cover ? `（明信片照片：${card.cover}）\n` : ''));
    records.push({ number: k + 1, name: w.name, message: w.message, sentAt: w.createdAt, photo: card.cover, video: card.video && { original, playable: card.video.src, duration: v.play?.duration || null, width: v.play?.width || null, height: v.play?.height || null, fps: v.play?.fps || null } });
  });

  // Room on the disk: whatever comes from R2, plus the zip itself, plus a margin.
  const fetchBytes = plan.filter(x => x.key).reduce((s, x) => s + x.size, 0);
  const zipBytes = plan.reduce((s, x) => s + x.size, 0);
  const { bavail, bsize } = await fsp.statfs(DATA);
  const free = bavail * bsize;
  say(`要打包约 ${mb(zipBytes)}，其中 ${mb(fetchBytes)} 要先从 R2 取回；硬盘剩余 ${mb(free)}。`);
  if (free < fetchBytes + zipBytes + 1e9) {
    say('硬盘空间不够打包全部内容。先删掉旧的导出包再试：rm -f /opt/joey/data/export/*.zip');
    process.exitCode = 1; return;
  }

  // Fetch what is not on this server.
  for (const x of plan.filter(y => y.key)) {
    const dest = path.join(WORK, 'r2', x.key.replace(/[^\w.-]+/g, '_'));
    say(`  从 R2 取回 ${x.arc.slice(TOP.length + 1)}（${mb(x.size)}）`);
    await storage.getFile(x.key, dest);
    x.local = dest; x.size = sizeOf(dest);
  }

  // The page, the messages and a note on what is what.
  let html = await fsp.readFile(path.join(ROOT, 'views', 'joey.html'), 'utf8');
  html = html.replace(/<link rel="preload"[^>]*>\n?/g, '');
  html = html.replace(/url\(\/fonts\/([\w.-]+\.woff2)(\?v=\d+)?\)/g, (m, f) =>
    `url(data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, 'public', 'fonts', f)).toString('base64')})`);
  const data = JSON.stringify({ wishes: keepsake }).replace(/</g, '\\u003c');
  const at = html.indexOf('<script>');
  html = html.slice(0, at) + `<script>window.KEEPSAKE = ${data};</script>\n` + html.slice(at);
  const extra = [
    ['Dear Joey.html', html],
    ['祝福 Messages.txt', `Dear Joey · 2026 生日明信片\n共 ${wishes.length} 封\n\n` + text.join('\n────────────\n\n')],
    ['messages.json', JSON.stringify(records, null, 2)],
    ['先看我 README.txt', [
      '这是 Joey 2026 年生日信箱的完整备份。',
      '',
      'Dear Joey.html     用电脑上的浏览器（Chrome、Safari、Edge）双击打开，就是 Joey 那天看到的页面，不需要网络。',
      '                   要和 files 文件夹放在同一个地方。手机上打不开。',
      '原片 Originals      朋友们上传的原始视频，没有任何改动，画质最好。文件名前面的数字就是火漆上的编号。',
      'files              网页用到的视频（浏览器能直接播放的版本）、视频封面帧和明信片照片。',
      '祝福 Messages.txt   所有文字祝福。',
      'messages.json      同样的内容，给程序用。',
      '',
    ].join('\n')],
  ];
  for (const [name, body] of extra) {
    const p = path.join(WORK, name);
    await fsp.writeFile(p, body);
    plan.push({ local: p, arc: `${TOP}/${name}`, size: sizeOf(p) });
  }

  // The zip: files stored as they are (videos do not compress), names in UTF-8, ZIP64 when it is large.
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const zipName = `Dear-Joey-${stamp}.zip`, zipPath = path.join(OUT, zipName);
  const manifest = path.join(WORK, 'manifest.json');
  await fsp.writeFile(manifest, JSON.stringify(plan.map(x => [x.local, x.arc])));
  say(`打包 ${plan.length} 个文件 → ${zipName}`);
  const z = spawnSync('python3', [path.join(ROOT, 'scripts', 'zipfiles.py'), manifest, zipPath], { stdio: 'inherit' });
  if (z.status !== 0) throw new Error('打包失败');
  say(`打包完成：${mb(sizeOf(zipPath))}`);

  // Keep only the newest export, here and in R2.
  for (const f of await fsp.readdir(OUT)) {
    if (/^Dear-Joey-[\w-]+\.zip$/.test(f) && f !== zipName) { await fsp.rm(path.join(OUT, f), { force: true }); say(`删掉了旧的导出包 ${f}`); }
  }
  await fsp.rm(WORK, { recursive: true, force: true });

  if (cloud) {
    say('正在把导出包传一份到 Cloudflare R2（在中国大陆以外下载通常更快）…');
    const t0 = Date.now();
    await storage.putFile(`export/${zipName}`, zipPath, 'application/zip');
    if ((await storage.size(`export/${zipName}`)) !== sizeOf(zipPath)) throw new Error('R2 上的导出包大小不对，请重新运行 joey-export');
    for (const key of await storage.list('export/')) if (key !== `export/${zipName}`) await storage.remove(key);
    say(`已传到 R2（用了 ${Math.round((Date.now() - t0) / 1000)} 秒）。`);
  }
  say('\n完成。打开管理页，最上面有下载链接。');
}

main().catch(e => { console.error('导出失败：', e.message); process.exitCode = 1; });
