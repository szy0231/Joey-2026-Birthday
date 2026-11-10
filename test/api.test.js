// Upload protocol: create a wish, upload in chunks, survive a wrong offset, reject strangers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'joey-test-'));
let proc;

before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT, DATA_DIR: data, ADMIN_KEY: 'secret', R2_ACCOUNT_ID: '', R2_BUCKET: '' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { proc.kill(); fs.rmSync(data, { recursive: true, force: true }); });

const post = (url, body, token) => fetch(base + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { 'X-Wish-Token': token }) }, body: JSON.stringify(body),
});
const put = (url, buf, token) => fetch(base + url, { method: 'PUT', headers: { 'X-Wish-Token': token }, body: buf });

test('rejects empty name or message', async () => {
  const clientId = crypto.randomUUID();
  assert.equal((await post('/api/wishes', { clientId, name: ' ', message: 'hi' })).status, 400);
  assert.equal((await post('/api/wishes', { clientId, name: 'A', message: '' })).status, 400);
});

test('creating a wish is safe to retry and cannot be hijacked', async () => {
  const clientId = crypto.randomUUID(), body = { clientId, name: '小明', message: '生日快乐' };
  const a = await (await post('/api/wishes', body)).json();
  const b = await (await post('/api/wishes', body)).json(); // lost response, same content
  assert.equal(a.token, b.token);
  assert.equal((await post('/api/wishes', { ...body, message: 'overwritten' })).status, 409); // no token, new content
  assert.equal((await post('/api/wishes', { ...body, message: '改一下', token: a.token })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'wishes', clientId + '.json'))).message, '改一下');
});

test('chunked upload resumes and ends byte-identical', async () => {
  const clientId = crypto.randomUUID();
  const { token } = await (await post('/api/wishes', { clientId, name: 'A', message: 'hi' })).json();
  const file = crypto.randomBytes(300_000), url = `/api/wishes/${clientId}/video`;
  const meta = { name: 'a.MOV', size: file.length, type: 'video/quicktime' };

  assert.equal((await post(url, meta, 'wrong')).status, 404);
  assert.deepEqual(await (await post(url, meta, token)).json(), { offset: 0 });
  assert.equal((await put(url + '?offset=0', file.subarray(0, 100_000), 'wrong')).status, 404);
  assert.deepEqual(await (await put(url + '?offset=0', file.subarray(0, 100_000), token)).json(), { offset: 100_000, done: false });

  // A replayed or misaligned chunk is refused and told where to continue.
  const dup = await put(url + '?offset=0', file.subarray(0, 100_000), token);
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).offset, 100_000);
  // Declaring the same file again resumes instead of starting over.
  assert.deepEqual(await (await post(url, meta, token)).json(), { offset: 100_000 });
  // A chunk that would overrun the declared size is refused.
  assert.equal((await put(url + '?offset=100000', Buffer.alloc(200_001), token)).status, 400);

  assert.deepEqual(await (await put(url + '?offset=100000', file.subarray(100_000), token)).json(), { offset: 300_000, done: true });
  assert.ok(file.equals(fs.readFileSync(path.join(data, 'incoming', clientId))));
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'wishes', clientId + '.json')));
  assert.equal(saved.video.status, 'received');
  assert.deepEqual(await (await post(url, meta, token)).json(), { offset: 300_000, done: true });
});

test('admin page needs the key', async () => {
  assert.equal((await fetch(base + '/admin')).status, 404);
  assert.equal((await fetch(base + '/admin?key=nope')).status, 404);
  const ok = await fetch(base + '/admin?key=secret');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /小明/);
});
