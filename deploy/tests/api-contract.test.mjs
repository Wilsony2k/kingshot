/**
 * Kingshot 上傳 API — contract 驗證測試（本地，Node 18+，唔需要 wrangler）
 *
 * 用法：node deploy/tests/api-contract.test.mjs
 *      KZ_ROUTE=/path/to/route.js node deploy/tests/api-contract.test.mjs   # 換另一個實作檔
 *
 * 原理：mock R2 binding（env.UPLOADS）同 KV binding（env.UPLOADS_KV），
 *       直接呼叫 functions/api/[[path]].js 匯出嘅 onRequest(context)，
 *       逐條對照凍結 contract：狀態碼、body、headers、排序、安全 header。
 * 注意：呢個檔案係本地測試工具，唔會 deploy，亦唔會被 CF Pages 當成 Function。
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ---------- 載入被測檔案（複製到 temp 再 import，避開 '[[path]]' 檔名問題） ---------- */
const here = dirname(fileURLToPath(import.meta.url));
const routeFile = process.env.KZ_ROUTE || join(here, '..', '..', 'functions', 'api', '[[path]].js');
const tmpDir = mkdtempSync(join(tmpdir(), 'kz-test-'));
const routeCopy = join(tmpDir, 'route.mjs');
writeFileSync(routeCopy, readFileSync(routeFile, 'utf8'));
const { onRequest } = await import(pathToFileURL(routeCopy).href);
console.log(`被測檔案：${routeFile}`);

const BASE = 'https://avgkingshot.85200852.xyz';
const TOKEN = 'test-secret-token-123';

/* ===================== mock R2 ===================== */
class MockR2 {
  constructor() { this.map = new Map(); }
  async put(key, value, opts = {}) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    // 模擬真 R2：customMetadata 只接受 ASCII（非 ASCII 會 throw）
    for (const [k, v] of Object.entries(opts.customMetadata || {})) {
      if (!/^[\x20-\x7e]*$/.test(String(v))) throw new Error(`R2 customMetadata must be ASCII (${k})`);
    }
    this.map.set(key, {
      bytes,
      httpMetadata: opts.httpMetadata || {},
      customMetadata: opts.customMetadata || {},
      uploaded: new Date()
    });
  }
  async get(key) {
    const o = this.map.get(key);
    if (!o) return null;
    return {
      key, size: o.bytes.length, uploaded: o.uploaded,
      httpMetadata: o.httpMetadata, customMetadata: o.customMetadata,
      arrayBuffer: async () => o.bytes.slice().buffer
    };
  }
  async head(key) { const o = this.map.get(key); return o ? { key, size: o.bytes.length } : null; }
  async delete(key) { this.map.delete(key); }
  async list(opts = {}) {
    // 同真 R2 一樣按 key 字典序升序 + cursor 分頁
    const keys = [...this.map.keys()].sort();
    const start = opts.cursor ? keys.indexOf(opts.cursor) : 0;
    const page = keys.slice(start, start + (opts.limit || 1000));
    const objects = page.map((k) => {
      const o = this.map.get(k);
      const out = { key: k, size: o.bytes.length, uploaded: o.uploaded };
      if ((opts.include || []).includes('customMetadata')) out.customMetadata = o.customMetadata;
      if ((opts.include || []).includes('httpMetadata')) out.httpMetadata = o.httpMetadata;
      return out;
    });
    const truncated = start + page.length < keys.length;
    return { objects, truncated, cursor: truncated ? keys[start + page.length] : undefined };
  }
}

/* ===================== mock KV ===================== */
class MockKV {
  constructor() { this.map = new Map(); }
  async put(k, v) { this.map.set(k, String(v)); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async delete(k) { this.map.delete(k); }
  async list(opts = {}) {
    const all = [...this.map.keys()].filter((k) => k.startsWith(opts.prefix || '')).sort();
    const start = opts.cursor ? all.indexOf(opts.cursor) : 0;
    const page = all.slice(start, start + (opts.limit || 1000));
    const complete = start + page.length >= all.length;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: complete,
      cursor: complete ? undefined : all[start + page.length]
    };
  }
}

/* ===================== 測試框架 ===================== */
let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name} ${detail}`); console.log(`  ❌ ${name} ${detail}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `→ got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
const fullEnv = () => ({ UPLOAD_TOKEN: TOKEN, UPLOADS: new MockR2(), UPLOADS_KV: new MockKV() });
const kvOnlyEnv = () => ({ UPLOAD_TOKEN: TOKEN, UPLOADS_KV: new MockKV() });

async function call(env, method, path, { headers = {}, body, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) init.body = form;
  else if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const request = new Request(BASE + path, init);
  return onRequest({ request, env, params: { path: [] }, data: {}, waitUntil() {}, next() {} });
}
async function callJson(env, method, path, payload, headers = {}) {
  return call(env, method, path, {
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  });
}
function mkFile(name, bytes, type = '') {
  const fd = new FormData();
  fd.set('file', new File([bytes], name, type ? { type } : undefined));
  return fd;
}
const textBytes = (s) => new TextEncoder().encode(s);
const auth = { 'x-upload-token': TOKEN };

/* ===================== 1. POST /api/upload ===================== */
async function testUpload() {
  console.log('\n[1] POST /api/upload');
  const env = fullEnv();

  let r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('hero.jpg', textBytes('JPEGDATA'), 'image/jpeg') });
  const body = await r.json();
  eq('1a 成功 200', r.status, 200);
  eq('1a ok=true', body.ok, true);
  check('1a key 格式 <YYYY-MM-DD>/<epoch-ms>-<slug>.<ext>',
    /^\d{4}-\d{2}-\d{2}\/\d{10,17}-[a-z0-9-]{1,60}\.jpg$/.test(body.file.key), `→ ${body.file.key}`);
  eq('1a name', body.file.name, 'hero.jpg');
  eq('1a size', body.file.size, 8);
  eq('1a type', body.file.type, 'image/jpeg');
  check('1a uploadedAt 係 ISO', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(body.file.uploadedAt), `→ ${body.file.uploadedAt}`);
  eq('1a url', body.file.url, `/api/raw?key=${encodeURIComponent(body.file.key)}`);
  eq('1a Cache-Control: no-store', r.headers.get('Cache-Control'), 'no-store');

  r = await call(env, 'POST', '/api/upload', { form: mkFile('x.jpg', textBytes('a'), 'image/jpeg') });
  eq('1b 冇 token → 401', r.status, 401);
  eq('1b body', await r.json(), { ok: false, error: 'unauthorized' });
  r = await call(env, 'POST', '/api/upload', { headers: { 'x-upload-token': 'wrong' }, form: mkFile('x.jpg', textBytes('a'), 'image/jpeg') });
  eq('1b token 錯（短）→ 401', r.status, 401);
  r = await call(env, 'POST', '/api/upload', { headers: { 'x-upload-token': TOKEN + 'x'.repeat(50) }, form: mkFile('x.jpg', textBytes('a'), 'image/jpeg') });
  eq('1b token 錯（長度唔同）→ 401', r.status, 401);

  const fd = mkFile('form-token.png', textBytes('png'), 'image/png');
  fd.set('token', TOKEN);
  r = await call(env, 'POST', '/api/upload', { form: fd });
  eq('1c form 欄位 token（冇 header）→ 200', r.status, 200);
  r = await call(env, 'POST', `/api/upload?token=${TOKEN}`, { form: mkFile('q.png', textBytes('png'), 'image/png') });
  eq('1d query token → 200', r.status, 200);

  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('big.png', new Uint8Array(10485760 + 1), 'image/png') });
  eq('1e 10 MiB+1 → 413', r.status, 413);
  eq('1e body', await r.json(), { ok: false, error: 'too_large', maxBytes: 10485760 });
  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('exact.png', new Uint8Array(10485760), 'image/png') });
  eq('1f 剛好 10 MiB → 200（邊界）', r.status, 200);

  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('evil.exe', textBytes('MZ'), 'application/x-msdownload') });
  eq('1g .exe → 415', r.status, 415);
  const ub = await r.json();
  eq('1g error=unsupported_type', ub.error, 'unsupported_type');
  check('1g allowed 有 13 個白名單', Array.isArray(ub.allowed) && ub.allowed.length === 13, `→ ${JSON.stringify(ub.allowed)}`);
  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('noext', textBytes('x'), 'text/plain') });
  eq('1g 冇副檔名 → 415', r.status, 415);

  const empty = new FormData();
  empty.set('token', TOKEN);
  r = await call(env, 'POST', '/api/upload', { form: empty });
  eq('1h 冇 file 欄位 → 400', r.status, 400);
  eq('1h body', await r.json(), { ok: false, error: 'no_file' });
  r = await call(env, 'POST', '/api/upload', { headers: auth, body: 'not-multipart' });
  eq('1h 非 multipart → 400 no_file', r.status, 400);

  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('note.txt', textBytes('hi')) });
  eq('1i File.type 空 → 由副檔名推 text/plain', (await r.json()).file.type, 'text/plain');
  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('gen.png', textBytes('p'), 'application/octet-stream') });
  eq('1i 泛用 octet-stream → 由副檔名推 image/png', (await r.json()).file.type, 'image/png');
  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('weird.txt', textBytes('p'), 'image/jpeg') });
  eq('1i 明確 File.type 優先', (await r.json()).file.type, 'image/jpeg');

  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('我的 截圖!!.PNG', textBytes('png'), 'image/png') });
  const cb = await r.json();
  eq('1j 中文檔名 → 200（R2 metadata 已編碼保護）', r.status, 200);
  check('1j slug fallback = file', /\/\d+-file\.png$/.test(cb.file.key), `→ ${cb.file.key}`);
  eq('1j 原始 name 保留', cb.file.name, '我的 截圖!!.PNG');

  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('My Cool  Header Image (v2).jpeg', textBytes('jpg'), 'image/jpeg') });
  const sb = await r.json();
  check('1k slug 只含 [a-z0-9-]', /\/\d+-[a-z0-9-]{1,60}\.jpeg$/.test(sb.file.key), `→ ${sb.file.key}`);
  check('1k slug 內容合理', sb.file.key.includes('my-cool-header-image'), `→ ${sb.file.key}`);
  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('a'.repeat(200) + '.png', textBytes('p'), 'image/png') });
  const lb = await r.json();
  check('1k slug 最長 60', /\/\d+-a{60}\.png$/.test(lb.file.key), `→ ${lb.file.key}`);

  r = await call({ UPLOAD_TOKEN: TOKEN }, 'POST', '/api/upload', { headers: auth, form: mkFile('a.png', textBytes('p'), 'image/png') });
  eq('1l 冇 storage binding → 500', r.status, 500);
  eq('1l body', await r.json(), { ok: false, error: 'no_storage' });

  r = await call({ UPLOADS: new MockR2() }, 'POST', '/api/upload', { headers: auth, form: mkFile('a.png', textBytes('p'), 'image/png') });
  eq('1m 未設 env.UPLOAD_TOKEN → 401（唔泄露配置狀態）', r.status, 401);
}

/* ===================== 2. GET /api/list ===================== */
async function testList() {
  console.log('\n[2] GET /api/list');
  const env = fullEnv();

  // 控制 Date.now 造三個唔同 epoch 嘅 key（唔依賴真實時鐘）
  const realNow = Date.now;
  let t = realNow() + 1000;
  Date.now = () => t;
  const keys = [];
  for (const n of ['first.png', 'second.png', 'third.png']) {
    const r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile(n, textBytes(n), 'image/png') });
    keys.push((await r.json()).file.key);
    t += 1000;
  }
  Date.now = realNow;

  let r = await call(env, 'GET', `/api/list?token=${TOKEN}`);
  let b = await r.json();
  eq('2a 200', r.status, 200);
  eq('2a ok=true', b.ok, true);
  eq('2a count', b.count, 3);
  eq('2a 新到舊排序', b.files.map((f) => f.key), [keys[2], keys[1], keys[0]]);
  check('2a entry 欄位齊全', b.files.every((f) => f.key && f.name && typeof f.size === 'number' && f.type && f.uploadedAt && f.url),
    `→ ${JSON.stringify(b.files[0])}`);
  eq('2a 最新一個 name', b.files[0].name, 'third.png');
  eq('2a Cache-Control: no-store', r.headers.get('Cache-Control'), 'no-store');

  r = await call(env, 'GET', `/api/list?token=${TOKEN}&limit=2`);
  b = await r.json();
  eq('2b limit=2 → count=2', b.count, 2);
  eq('2b limit=2 → 取最新兩個', b.files.map((f) => f.key), [keys[2], keys[1]]);
  r = await call(env, 'GET', `/api/list?token=${TOKEN}&limit=0`);
  eq('2b limit=0（非法）→ 預設 100', (await r.json()).count, 3);
  r = await call(env, 'GET', `/api/list?token=${TOKEN}&limit=abc`);
  eq('2b limit=abc（非法）→ 預設 100', (await r.json()).count, 3);
  r = await call(env, 'GET', `/api/list?token=${TOKEN}&limit=-5`);
  eq('2b limit=-5（非法）→ 預設 100', (await r.json()).count, 3);
  r = await call(env, 'GET', `/api/list?token=${TOKEN}&limit=99999`);
  eq('2b limit 超上限 → 夾到 500（唔會爆）', (await r.json()).count, 3);

  const past = new Date(t - 100000).toISOString();
  const future = new Date(t + 100000).toISOString();
  r = await call(env, 'GET', `/api/list?token=${TOKEN}&since=${encodeURIComponent(future)}`);
  eq('2c since=未來 → count=0', (await r.json()).count, 0);
  r = await call(env, 'GET', `/api/list?token=${TOKEN}&since=${encodeURIComponent(past)}`);
  eq('2c since=過去 → 全部', (await r.json()).count, 3);
  r = await call(env, 'GET', `/api/list?token=${TOKEN}&since=garbage`);
  eq('2c since 非法 → 當冇提供', (await r.json()).count, 3);

  r = await call(env, 'GET', '/api/list');
  eq('2d 冇 token → 401（REQUIRE_AUTH_ON_LIST=true）', r.status, 401);
  r = await call(env, 'GET', '/api/list', { headers: auth });
  eq('2d header token → 200', r.status, 200);

  r = await call(fullEnv(), 'GET', `/api/list?token=${TOKEN}`);
  eq('2e 空清單 count=0', (await r.json()).count, 0);
}

/* ===================== 3. GET /api/raw（需要 token） ===================== */
async function testRaw() {
  console.log('\n[3] GET /api/raw（需要 token）');
  const env = fullEnv();
  const payload = 'HELLO-RAW-BYTES-0123456789';

  let r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('shot.png', textBytes(payload), 'image/png') });
  const key = (await r.json()).file.key;
  const rawPath = `/api/raw?key=${encodeURIComponent(key)}`;

  // 3a 未認證：一律 401（唔可以因為未認證而泄露 key 存唔存在）
  r = await call(env, 'GET', rawPath);
  eq('3a 冇 token → 401', r.status, 401);
  eq('3a body', await r.json(), { ok: false, error: 'unauthorized' });
  r = await call(env, 'GET', rawPath, { headers: { 'x-upload-token': 'wrong' } });
  eq('3a token 錯（短）→ 401', r.status, 401);
  r = await call(env, 'GET', rawPath, { headers: { 'x-upload-token': TOKEN + 'x'.repeat(40) } });
  eq('3a token 錯（長度唔同）→ 401', r.status, 401);
  r = await call(env, 'GET', `/api/raw?key=${encodeURIComponent(key)}&token=wrong-token`);
  eq('3a query token 錯 → 401', r.status, 401);
  // 未認證 + 壞 key／唔存在 key：都必須 401（唔可以 400 bad_key／404 not_found）
  r = await call(env, 'GET', '/api/raw?key=../../etc/passwd');
  eq('3a 未認證 + 壞 key → 401（唔係 bad_key）', r.status, 401);
  eq('3a 未認證 + 壞 key body', await r.json(), { ok: false, error: 'unauthorized' });
  r = await call(env, 'GET', '/api/raw?key=2026-09-29%2F1790661604-ghost.png');
  eq('3a 未認證 + 唔存在 key → 401（唔係 not_found）', r.status, 401);
  r = await call(env, 'GET', '/api/raw');
  eq('3a 未認證 + 冇 key → 401', r.status, 401);

  // 3b 認證後：header token
  r = await call(env, 'GET', rawPath, { headers: auth });
  eq('3b 帶 token → 200', r.status, 200);
  eq('3b bytes 一致', await r.text(), payload);
  eq('3b Content-Type', r.headers.get('Content-Type'), 'image/png');
  check('3b Content-Disposition attachment + filename',
    /^attachment; filename="shot\.png"/.test(r.headers.get('Content-Disposition') || ''), `→ ${r.headers.get('Content-Disposition')}`);
  eq('3b Cache-Control: no-store', r.headers.get('Cache-Control'), 'no-store');
  eq('3b X-Content-Type-Options: nosniff', r.headers.get('X-Content-Type-Options'), 'nosniff');
  eq('3b Content-Security-Policy', r.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  eq('3b 冇 Access-Control-Allow-Origin', r.headers.get('Access-Control-Allow-Origin'), null);

  // 3c query token（方便 curl）：?key=...&token=...
  r = await call(env, 'GET', `${rawPath}&token=${TOKEN}`);
  eq('3c query token → 200', r.status, 200);
  eq('3c query token bytes 一致', await r.text(), payload);
  // URL 順序倒轉都應該通
  r = await call(env, 'GET', `/api/raw?token=${TOKEN}&key=${encodeURIComponent(key)}`);
  eq('3c token 放前面 → 200', r.status, 200);

  // 3d 中文檔名
  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('我的截圖.png', textBytes('x'), 'image/png') });
  const ckey = (await r.json()).file.key;
  r = await call(env, 'GET', `/api/raw?key=${encodeURIComponent(ckey)}`, { headers: auth });
  const cd = r.headers.get('Content-Disposition') || '';
  check('3d Content-Disposition 全 ASCII', /^[\x20-\x7e]*$/.test(cd), `→ ${cd}`);
  check('3d 帶 filename*=UTF-8 原名',
    cd.includes("filename*=UTF-8''") && cd.includes(encodeURIComponent('我的截圖.png')), `→ ${cd}`);

  // 3e 缺 metadata
  const bareKey = '2026-09-29/1790661604-bare.png';
  await env.UPLOADS.put(bareKey, textBytes('bare'), { httpMetadata: {}, customMetadata: {} });
  r = await call(env, 'GET', `/api/raw?key=${encodeURIComponent(bareKey)}`, { headers: auth });
  eq('3e 缺 type → application/octet-stream', r.headers.get('Content-Type'), 'application/octet-stream');
  check('3e 缺 name → 由 key 推 fallback', /filename="bare\.png"/.test(r.headers.get('Content-Disposition') || ''), '→ fallback 錯');

  // 3f 已認證之下嘅 bad_key（400 只可以喺已認證情況下發生）
  const badKeys = [
    '../../etc/passwd', '/etc/passwd', '2026-09-29/1790661604-a.png/../../x', 'nope', '',
    '2026-09-29/1790661604-UPPER.png', '2026-09-29/abc-file.png', '2026-9-29/1790661604-a.png',
    '2026-09-29/1790661604-' + 'a'.repeat(61) + '.png', '2026-09-29\\1790661604-a.png'
  ];
  for (const bad of badKeys) {
    const rr = await call(env, 'GET', `/api/raw?key=${encodeURIComponent(bad)}`, { headers: auth });
    eq(`3f 已認證 bad_key: ${(bad.slice(0, 40) || '(空)')}`, rr.status, 400);
  }
  r = await call(env, 'GET', '/api/raw', { headers: auth });
  eq('3f 已認證但冇 key 參數 → 400', r.status, 400);
  eq('3f body', await r.json(), { ok: false, error: 'bad_key' });

  // 3g 已認證 + 唔存在
  r = await call(env, 'GET', '/api/raw?key=2026-09-29%2F1790661604-ghost.png', { headers: auth });
  eq('3g 唔存在 → 404', r.status, 404);
  eq('3g body', await r.json(), { ok: false, error: 'not_found' });

  // 3h 上傳嘅 HTML：一樣有 CSP sandbox（同源 XSS 防護）
  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('evil.html', textBytes('<script>alert(1)</script>'), 'text/html') });
  const hkey = (await r.json()).file.key;
  r = await call(env, 'GET', `/api/raw?key=${encodeURIComponent(hkey)}`, { headers: auth });
  eq('3h html Content-Type', r.headers.get('Content-Type'), 'text/html');
  eq('3h html CSP sandbox', r.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  eq('3h html nosniff', r.headers.get('X-Content-Type-Options'), 'nosniff');
}

/* ===================== 4. POST /api/delete ===================== */
async function testDelete() {
  console.log('\n[4] POST /api/delete');
  const env = fullEnv();
  let r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('tmp.png', textBytes('x'), 'image/png') });
  const key = (await r.json()).file.key;

  r = await callJson(env, 'POST', '/api/delete', { key, token: TOKEN });
  eq('4a 200', r.status, 200);
  eq('4a body', await r.json(), { ok: true, deleted: key });
  r = await call(env, 'GET', `/api/raw?key=${encodeURIComponent(key)}`, { headers: auth });
  eq('4a 刪完 raw（帶 token）→ 404', r.status, 404);

  r = await callJson(env, 'POST', '/api/delete', { key, token: TOKEN });
  eq('4b 重複刪 → 404', r.status, 404);
  eq('4b body', await r.json(), { ok: false, error: 'not_found' });

  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('h.png', textBytes('x'), 'image/png') });
  const k2 = (await r.json()).file.key;
  r = await callJson(env, 'POST', '/api/delete', { key: k2 }, auth);
  eq('4c header token → 200', r.status, 200);

  r = await callJson(env, 'POST', '/api/delete', { key: 'x', token: 'bad' });
  eq('4d token 錯 → 401', r.status, 401);
  r = await callJson(env, 'POST', '/api/delete', { key: '../../etc/passwd', token: TOKEN });
  eq('4d 非法 key → 400 bad_key', r.status, 400);
  eq('4d body', await r.json(), { ok: false, error: 'bad_key' });
  r = await call(env, 'POST', '/api/delete', { headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  eq('4d JSON 壞 → 400 bad_request', r.status, 400);
}

/* ===================== 5. Router / 全域 headers ===================== */
async function testRouter() {
  console.log('\n[5] Router / 全域 headers');
  const env = fullEnv();

  let r = await call(env, 'GET', '/api/upload');
  eq('5a GET upload → 405', r.status, 405);
  eq('5a Allow: POST', r.headers.get('Allow'), 'POST');
  eq('5a body', await r.json(), { ok: false, error: 'method_not_allowed' });

  r = await call(env, 'POST', '/api/list', { headers: auth, body: '{}' });
  eq('5b POST list → 405', r.status, 405);
  eq('5b Allow: GET', r.headers.get('Allow'), 'GET');

  r = await call(env, 'POST', '/api/raw');
  eq('5c POST raw → 405', r.status, 405);
  eq('5c Allow: GET', r.headers.get('Allow'), 'GET');

  r = await call(env, 'GET', '/api/delete');
  eq('5d GET delete → 405', r.status, 405);
  eq('5d Allow: POST', r.headers.get('Allow'), 'POST');

  r = await call(env, 'DELETE', '/api/whatever');
  eq('5e 未知路徑 → 404 not_found', r.status, 404);
  eq('5e body', await r.json(), { ok: false, error: 'not_found' });
  eq('5e /api → 404', (await call(env, 'GET', '/api')).status, 404);
  eq('5e 深層未知路徑 → 404', (await call(env, 'GET', '/api/upload/extra')).status, 404);

  eq('5f /api/list/ 尾斜線 → 200', (await call(env, 'GET', `/api/list/?token=${TOKEN}`)).status, 200);

  for (const [m, p] of [['GET', '/api/nope'], ['GET', '/api/upload'], ['GET', `/api/list?token=${TOKEN}`]]) {
    const rr = await call(env, m, p);
    eq(`5g ${m} ${p} → Cache-Control: no-store`, rr.headers.get('Cache-Control'), 'no-store');
    check(`5g ${m} ${p} → body 冇回顯 token`, !(await rr.clone().text()).includes(TOKEN), '→ token 泄露！');
  }

  const bare = { UPLOAD_TOKEN: TOKEN };
  for (const [m, p] of [['GET', '/api/list'], ['GET', '/api/raw?key=2026-09-29%2F1790661604-a.png'], ['POST', '/api/delete']]) {
    eq(`5h ${m} ${p} → 500 no_storage`, (await call(bare, m, p, { headers: auth })).status, 500);
  }
}

/* ===================== 6. KV-only 模式 ===================== */
async function testKvOnly() {
  console.log('\n[6] KV-only（冇 R2 binding）');
  const env = kvOnlyEnv();

  let r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('kv.png', textBytes('KV-BYTES'), 'image/png') });
  const b = await r.json();
  eq('6a KV 上傳 200', r.status, 200);
  const key = b.file.key;

  const rawVal = await env.UPLOADS_KV.get('file:' + key);
  check('6b KV key = file:<objectKey>', rawVal !== null && rawVal !== undefined, '→ 冇寫入');
  const parsed = JSON.parse(rawVal);
  check('6b envelope 有 meta + dataBase64', !!parsed.meta && typeof parsed.dataBase64 === 'string', `→ ${Object.keys(parsed)}`);
  eq('6b meta.name（encodeURIComponent 存放）', parsed.meta.name, encodeURIComponent('kv.png'));
  eq('6b meta.size', parsed.meta.size, 8);
  eq('6b meta.type', parsed.meta.type, 'image/png');
  check('6b meta.uploadedAt', /^\d{4}-\d{2}-\d{2}T/.test(parsed.meta.uploadedAt), `→ ${parsed.meta.uploadedAt}`);

  r = await call(env, 'GET', `/api/raw?key=${encodeURIComponent(key)}`, { headers: auth });
  eq('6c KV raw 200', r.status, 200);
  eq('6c KV bytes 一致', await r.text(), 'KV-BYTES');
  eq('6c KV Content-Type', r.headers.get('Content-Type'), 'image/png');

  const bin = new Uint8Array(10240);
  for (let i = 0; i < bin.length; i++) bin[i] = i % 256;
  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('bin.png', bin, 'image/png') });
  const bkey = (await r.json()).file.key;
  r = await call(env, 'GET', `/api/raw?key=${encodeURIComponent(bkey)}`, { headers: auth });
  const got = new Uint8Array(await r.arrayBuffer());
  check('6d 二進位 10240 bytes round-trip 完全一致',
    got.length === bin.length && got.every((v, i) => v === bin[i]), `→ len ${got.length}`);

  r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('中文圖.png', textBytes('z'), 'image/png') });
  const ckey = (await r.json()).file.key;
  r = await call(env, 'GET', `/api/list?token=${TOKEN}`);
  const lb = await r.json();
  eq('6e list 200', r.status, 200);
  eq('6e count=3', lb.count, 3);
  eq('6e KV list 新到舊', lb.files[0].key, ckey);
  eq('6e 中文 name round-trip', lb.files[0].name, '中文圖.png');
  eq('6e KV list url 正確', lb.files[0].url, `/api/raw?key=${encodeURIComponent(ckey)}`);

  const future = new Date(Date.now() + 86400000).toISOString();
  r = await call(env, 'GET', `/api/list?token=${TOKEN}&since=${encodeURIComponent(future)}`);
  eq('6f since=未來 → count=0（KV 快速跳過生效）', (await r.json()).count, 0);

  r = await callJson(env, 'POST', '/api/delete', { key, token: TOKEN });
  eq('6g KV delete 200', r.status, 200);
  eq('6g KV key 真係刪咗', await env.UPLOADS_KV.get('file:' + key), null);
  r = await callJson(env, 'POST', '/api/delete', { key, token: TOKEN });
  eq('6g 重複刪 → 404', r.status, 404);

  await env.UPLOADS_KV.put('file:2026-09-29/1790661604-corrupt.png', 'not-json');
  r = await call(env, 'GET', '/api/raw?key=2026-09-29%2F1790661604-corrupt.png', { headers: auth });
  eq('6h 損毀 envelope → 404（唔會 500）', r.status, 404);
  r = await call(env, 'GET', `/api/list?token=${TOKEN}`);
  eq('6h 損毀值唔影響 list', (await r.json()).count, 2);
}

/* ===================== 7. R2 分頁（>1000 objects） ===================== */
async function testPaging() {
  console.log('\n[7] R2 分頁與排序（1100 個 object）');
  const env = fullEnv();
  for (let i = 0; i < 1100; i++) {
    const day = i < 550 ? '2026-09-01' : '2026-09-02';
    const key = `${day}/${1790661604000 + i}-f${i}.png`;
    await env.UPLOADS.put(key, textBytes('x'), {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: {
        name: encodeURIComponent(`f${i}.png`), size: '1',
        type: 'image/png', uploadedAt: new Date(1790661604000 + i).toISOString()
      }
    });
  }
  const b = await (await call(env, 'GET', `/api/list?token=${TOKEN}&limit=5`)).json();
  eq('7a count=5', b.count, 5);
  eq('7a 跨分頁攞到真最新 5 個', b.files.map((f) => f.name), ['f1099.png', 'f1098.png', 'f1097.png', 'f1096.png', 'f1095.png']);
  eq('7b 預設 limit=100', (await (await call(env, 'GET', `/api/list?token=${TOKEN}`)).json()).count, 100);
  const b3 = await (await call(env, 'GET', `/api/list?token=${TOKEN}&limit=500`)).json();
  eq('7c limit=500 → count=500', b3.count, 500);
  eq('7c limit=500 最新一個', b3.files[0].name, 'f1099.png');
}

/* ===================== 8. round-trip 完整性 ===================== */
function testRoundTrip() {
  console.log('\n[8] R2 round-trip 完整性');
  return (async () => {
    const env = fullEnv();
    const bin = new Uint8Array(4096);
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 7) % 256;
    const r = await call(env, 'POST', '/api/upload', { headers: auth, form: mkFile('rt.png', bin, 'image/png') });
    const key = (await r.json()).file.key;
    const rr = await call(env, 'GET', `/api/raw?key=${encodeURIComponent(key)}`, { headers: auth });
    const got = new Uint8Array(await rr.arrayBuffer());
    check('8a 4096 bytes R2 round-trip 一致', got.length === bin.length && got.every((v, i) => v === bin[i]), `→ len ${got.length}`);
    const list = await (await call(env, 'GET', `/api/list?token=${TOKEN}`)).json();
    eq('8b list 內 size 正確', list.files[0].size, 4096);
    eq('8c list 內 name 正確', list.files[0].name, 'rt.png');
  })();
}

/* ===================== main ===================== */
const t0 = Date.now();
await testUpload();
await testList();
await testRaw();
await testDelete();
await testRouter();
await testKvOnly();
await testPaging();
await testRoundTrip();

console.log(`\n===== 結果：${pass} passed, ${failures.length} failed（${Date.now() - t0} ms）=====`);
if (failures.length) {
  console.log('失敗項：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通過 ✅');
