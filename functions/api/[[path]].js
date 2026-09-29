/**
 * Kingshot 上傳 API — Cloudflare Pages Function（單一檔案 catch-all 路由器）
 *
 * 位置：functions/api/[[path]].js（repo 根目錄，CF Pages 自動 compile）
 * Runtime：Cloudflare Workers — 只有 Web API（crypto.subtle / Request / Response / atob / btoa），
 *          冇 Node 嘅 fs / path / Buffer；唔用任何 npm 依賴或 CDN。
 * 單一檔案：避免 Pages Functions 對共享 module 嘅路由不確定性。
 *
 * 路由（全部喺 /api 之下）：
 *   POST /api/upload   multipart/form-data 上傳單一檔案（上限 10 MiB）
 *   GET  /api/list     列出最近上傳（新到舊；需要 token，見 REQUIRE_AUTH_ON_LIST）
 *   GET  /api/raw      取原始 bytes（需要 token；已鎖 Content-Type + CSP，唔加 CORS 頭）
 *   POST /api/delete   application/json 刪除單一 object
 *
 * Auth：env.UPLOAD_TOKEN；request 帶 header x-upload-token 或 query ?token=
 *       （upload 額外接受 form 欄位 token；delete 額外接受 body.token）
 *       raw 一樣要 token（可用 ?token= 方便 curl），唔好當佢係公開連結：
 *       ① key 內含 epoch-ms，屬可枚舉嘅識別碼，唔應該當成授權憑證；
 *       ② 前端唔應該用裸連結／<img src="/api/raw?key=...">，因為上傳檔案係同源內容，
 *          開上傳嘅 HTML 會有 XSS 風險 —— 改用 fetch + 帶 token，再用 blob URL 顯示。
 * Storage：優先 R2 binding env.UPLOADS，其次 KV binding env.UPLOADS_KV，兩者皆無 → 500 no_storage
 * 安全：token 永不寫入 log／response；比對用 SHA-256 digest + 固定時間 XOR，
 *       長度唔同都會行完同樣次數嘅運算，唔會早期 return 泄露長度。
 */

/* ===================== 1. 常數 ===================== */

// 單檔上限 10 MiB
const MAX_BYTES = 10485760;

// 副檔名白名單（小寫、不含點）
const ALLOWED_EXT = [
  'html', 'htm', 'jpg', 'jpeg', 'png', 'webp', 'gif',
  'svg', 'css', 'js', 'json', 'txt', 'md'
];

// File.type 為空時用副檔名推 MIME
const MIME_BY_EXT = {
  html: 'text/html', htm: 'text/html',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml',
  css: 'text/css', js: 'text/javascript', json: 'application/json',
  txt: 'text/plain', md: 'text/markdown'
};

const DEFAULT_LIMIT = 100;  // /api/list 預設回幾多筆
const MAX_LIMIT = 500;      // /api/list 上限

// object key 格式：<YYYY-MM-DD>/<epoch-ms>-<slug>.<ext>
// epoch-ms 用 10~17 位（contract 範例係 10 位，Date.now() 係 13 位）
const KEY_RE = /^\d{4}-\d{2}-\d{2}\/\d{10,17}-[a-z0-9-]{1,60}\.[a-z0-9]{1,12}$/;

const KV_PREFIX = 'file:';   // KV 內 object key 嘅前綴（KV key = file:<objectKey>）
const SCAN_PAGE = 1000;      // 單頁上限（KV / R2 都係 1000）
const MAX_SCAN_PAGES = 20;   // 最多掃 20000 個 object，避免極端情況下爆 CPU

// /api/list 係唔係要 token：contract 未明確寫 list 嘅 401 情況。
// 保守起見 default 要 token（公開清單等於公開所有上傳檔案名／大小）。
// 若 Wilson 確認要公開只讀清單，改成 false 就得（其餘程式碼唔需要改）。
const REQUIRE_AUTH_ON_LIST = true;

// /api/raw 固定安全 headers：nosniff + CSP sandbox，令上傳嘅 HTML 唔可以喺本站 domain 執行
const RAW_SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox"
};

/* ===================== 2. 小工具 ===================== */

/** 統一 JSON response：全部加 Content-Type 同 Cache-Control: no-store */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

/** 405 回應（一定要帶 Allow header） */
function methodNotAllowed(allow) {
  return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: allow });
}

/** 安全 JSON.parse：失敗回 null，唔拋錯 */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 把 metadata 嘅 name 還原：寫入時用 encodeURIComponent（見 decodeName 註解） */
function decodeName(value) {
  if (typeof value !== 'string') return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // 唔係合法 percent-encoding（例如檔名本身含 '%'）→ 原樣返回
  }
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 由 key 推 fallback 檔名：去掉日期目錄同 epoch 前綴 */
function keyName(key) {
  return String(key).replace(/^.*\//, '').replace(/^\d+-/, '') || 'file';
}

/** raw 連結（key 必須 URL-encode，因為 key 內含 '/'） */
function rawUrl(key) {
  return `/api/raw?key=${encodeURIComponent(key)}`;
}

/* ===================== 3. Token 驗證（timing-safe） ===================== */

/** SHA-256 digest → 固定 32 bytes，令比較長度同輸入長度無關（連長度都唔泄露） */
async function sha256Bytes(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

/** 固定時間比較：行完所有 byte，唔可以因長度唔同而提早 return */
function fixedTimeEqual(a, b) {
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) {
    diff |= (a[i] || 0) ^ (b[i] || 0);
  }
  return diff === 0;
}

/**
 * 驗證 token。
 * - env.UPLOAD_TOKEN 未設定 → 一律 false（回 401，唔會泄露係「未設定」）
 * - 兩個 digest 一定係 32 bytes，所以 XOR 迴圈次數固定
 */
async function isAuthorized(env, provided) {
  const secret = typeof env.UPLOAD_TOKEN === 'string' ? env.UPLOAD_TOKEN : '';
  const given = typeof provided === 'string' ? provided : '';
  const [a, b] = await Promise.all([sha256Bytes(secret), sha256Bytes(given)]);
  if (!secret) return false;
  return fixedTimeEqual(a, b);
}

/** 依 contract 次序取 token：header → query → body/form 欄位 */
function pickToken(request, url, body) {
  const header = request.headers.get('x-upload-token');
  if (typeof header === 'string' && header !== '') return header;
  const query = url.searchParams.get('token');
  if (typeof query === 'string' && query !== '') return query;
  if (body && typeof body.token === 'string' && body.token !== '') return body.token;
  return '';
}

/* ===================== 4. base64（KV envelope 用） ===================== */

/** Uint8Array → base64（分 chunk，避免 apply 參數過多爆 stack） */
function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 → Uint8Array */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ===================== 5. Storage 抽象層 ===================== */

/** 揀 storage：R2 優先，其次 KV，都冇 → null（上層回 500 no_storage） */
function getStore(env) {
  if (env && env.UPLOADS && typeof env.UPLOADS.put === 'function') {
    return { kind: 'r2', bucket: env.UPLOADS };
  }
  if (env && env.UPLOADS_KV && typeof env.UPLOADS_KV.put === 'function') {
    return { kind: 'kv', kv: env.UPLOADS_KV };
  }
  return null;
}

/**
 * R2 object → 統一 entry。
 * 註：R2 customMetadata 只接受 ASCII（實際上會當 HTTP header value 處理），
 *     所以寫入時 name 會做 encodeURIComponent，讀取時解返。
 */
function r2Entry(obj) {
  const cm = obj.customMetadata || {};
  const http = obj.httpMetadata || {};
  return {
    key: obj.key,
    name: decodeName(cm.name) || keyName(obj.key),
    size: toNumber(cm.size, typeof obj.size === 'number' ? obj.size : 0),
    type: (typeof cm.type === 'string' && cm.type) || http.contentType || 'application/octet-stream',
    uploadedAt: (typeof cm.uploadedAt === 'string' && cm.uploadedAt) ||
      (obj.uploaded instanceof Date ? obj.uploaded.toISOString() : ''),
    url: rawUrl(obj.key)
  };
}

/** KV envelope（{"meta":{...},"dataBase64":"..."}）→ 統一 entry */
function kvEntryFromParsed(key, parsed) {
  const m = (parsed && parsed.meta) || {};
  return {
    key,
    name: decodeName(m.name) || keyName(key),
    size: toNumber(m.size, 0),
    type: (typeof m.type === 'string' && m.type) || 'application/octet-stream',
    uploadedAt: typeof m.uploadedAt === 'string' ? m.uploadedAt : '',
    url: rawUrl(key)
  };
}

/** 只讀 KV metadata（list 用，唔 decode base64，省 CPU／記憶體） */
async function kvEntry(store, key) {
  const raw = await store.kv.get(KV_PREFIX + key);
  if (raw === null || raw === undefined) return null;
  const parsed = safeJson(typeof raw === 'string' ? raw : raw.toString());
  if (!parsed || typeof parsed !== 'object') return null;
  return kvEntryFromParsed(key, parsed);
}

/** 寫入 object（bytes = Uint8Array，meta = {name,size,type,uploadedAt}） */
async function storePut(store, key, bytes, meta) {
  // name 統一以 encodeURIComponent 存放：R2 customMetadata 唔食非 ASCII（中文檔名會出事）
  const storedName = encodeURIComponent(meta.name);
  if (store.kind === 'r2') {
    await store.bucket.put(key, bytes, {
      httpMetadata: { contentType: meta.type },
      customMetadata: {
        name: storedName,
        size: String(meta.size),
        type: meta.type,
        uploadedAt: meta.uploadedAt
      }
    });
    return;
  }
  // KV value 上限 25 MiB：10 MiB 檔案 base64 後約 13.3 MiB，仲喺安全範圍
  await store.kv.put(KV_PREFIX + key, JSON.stringify({
    meta: {
      name: storedName,
      size: meta.size,
      type: meta.type,
      uploadedAt: meta.uploadedAt
    },
    dataBase64: bytesToBase64(bytes)
  }));
}

/** 讀 object：回 {bytes, entry}，唔存在／損毀回 null */
async function storeRead(store, key) {
  if (store.kind === 'r2') {
    const obj = await store.bucket.get(key);
    if (!obj) return null;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    return { bytes, entry: r2Entry(obj) };
  }
  const raw = await store.kv.get(KV_PREFIX + key);
  if (raw === null || raw === undefined) return null;
  const parsed = safeJson(typeof raw === 'string' ? raw : raw.toString());
  if (!parsed || typeof parsed.dataBase64 !== 'string') return null;
  return { bytes: base64ToBytes(parsed.dataBase64), entry: kvEntryFromParsed(key, parsed) };
}

/** 刪 object：回 true（刪到）／false（唔存在） */
async function storeDelete(store, key) {
  if (store.kind === 'r2') {
    const head = await store.bucket.head(key);
    if (!head) return false;
    await store.bucket.delete(key);
    return true;
  }
  const raw = await store.kv.get(KV_PREFIX + key);
  if (raw === null || raw === undefined) return false;
  await store.kv.delete(KV_PREFIX + key);
  return true;
}

/** 新到舊排序（uploadedAt 相同就用 key 比） */
function compareDesc(a, b) {
  if (a.uploadedAt !== b.uploadedAt) return a.uploadedAt < b.uploadedAt ? 1 : -1;
  if (a.key === b.key) return 0;
  return a.key < b.key ? 1 : -1;
}

/**
 * 列出所有 object（已由新到舊 sort）。
 * 注意：R2 同 KV 嘅 list 都係按 key 字典序「升序」返回，而 key 以日期開頭，
 *       即係最新嘅一定喺最後 → 唔可以 list(limit) 就當係最近 N 個，
 *       一定要掃完（有 MAX_SCAN_PAGES 上限）再自己 sort。
 * sinceDay（YYYY-MM-DD）只用作 KV 層嘅快速跳過：key 日期比 since 舊就一定唔符合。
 */
async function storeList(store, sinceDay) {
  const entries = [];
  if (store.kind === 'r2') {
    let cursor;
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const res = await store.bucket.list({
        limit: SCAN_PAGE,
        cursor,
        include: ['customMetadata', 'httpMetadata'] // 唔 include 就冇 customMetadata
      });
      for (const obj of res.objects || []) entries.push(r2Entry(obj));
      cursor = res.truncated ? res.cursor : undefined;
      if (!cursor) break;
    }
  } else {
    let cursor;
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const res = await store.kv.list({ prefix: KV_PREFIX, limit: SCAN_PAGE, cursor });
      for (const k of res.keys || []) {
        const key = String(k.name).slice(KV_PREFIX.length);
        if (sinceDay && key.slice(0, 10) < sinceDay) continue; // 舊過 since → 唔需要 get
        const e = await kvEntry(store, key);
        if (e) entries.push(e);
      }
      cursor = res.list_complete ? undefined : res.cursor;
      if (!cursor) break;
    }
  }
  entries.sort(compareDesc);
  return entries;
}

/* ===================== 6. 輸入驗證 ===================== */

/** object key 白名單驗證：唔准 '..'、唔准以 '/' 開頭、唔准反斜線／控制字元、必須符合 key 格式 */
function isValidKey(key) {
  if (typeof key !== 'string' || key === '' || key.length > 200) return false;
  if (key.startsWith('/') || key.includes('..') || key.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(key)) return false;
  return KEY_RE.test(key);
}

/** limit：非法（NaN／<=0）用預設，超過上限夾到 500 */
function parseLimit(raw) {
  const n = Number.parseInt(raw === null ? '' : raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** since：合法 ISO 日期 → epoch ms，否則 null（當作冇提供） */
function parseSince(raw) {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/** 取檔名 basename（去掉任何路徑成分） */
function baseName(name) {
  const s = typeof name === 'string' && name !== '' ? name : 'file';
  return s.split(/[\\/]/).pop() || 'file';
}

/** 由檔名抽副檔名（小寫、不含點） */
function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** 由檔名生成 slug：只准 [a-z0-9-]、最長 60、空就 'file' */
function slugOf(name, ext) {
  const stem = ext ? name.slice(0, name.length - (ext.length + 1)) : name;
  let slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  slug = slug.replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return slug === '' ? 'file' : slug;
}

/* ===================== 7. 各 endpoint handler ===================== */

/** POST /api/upload */
async function handleUpload({ request, env, url, store }) {
  // 1) 讀 multipart（token 可能放喺 form 欄位，所以一定要先 parse）
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'no_file' }, 400);
  }

  // 2) Auth（header → query → form 欄位）
  const formToken = form.get('token');
  const provided = pickToken(request, url, null) ||
    (typeof formToken === 'string' ? formToken : '');
  if (!(await isAuthorized(env, provided))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  // 3) 一定要有單一檔案欄位 file
  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return json({ ok: false, error: 'no_file' }, 400);
  }

  // 4) 大小上限（先用 File.size，讀完 bytes 再 double check）
  if (typeof file.size === 'number' && file.size > MAX_BYTES) {
    return json({ ok: false, error: 'too_large', maxBytes: MAX_BYTES }, 413);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_BYTES) {
    return json({ ok: false, error: 'too_large', maxBytes: MAX_BYTES }, 413);
  }

  // 5) 副檔名白名單
  const name = baseName(file.name);
  const ext = extOf(name);
  if (!ALLOWED_EXT.includes(ext)) {
    return json({ ok: false, error: 'unsupported_type', allowed: ALLOWED_EXT }, 415);
  }

  // 6) 組 key + metadata
  const uploadedAt = new Date().toISOString();
  const key = `${uploadedAt.slice(0, 10)}/${Date.now()}-${slugOf(name, ext)}.${ext}`;
  // type：File.type 有具體值就用；空（或者只係泛用嘅 application/octet-stream，
  // 即 multipart part 冇帶 Content-Type 時 runtime 嘅預設值）→ 用副檔名推。
  const declared = typeof file.type === 'string' ? file.type : '';
  const type = (declared !== '' && declared !== 'application/octet-stream')
    ? declared
    : (MIME_BY_EXT[ext] || 'application/octet-stream');
  const meta = { name, size: bytes.length, type, uploadedAt };

  try {
    await storePut(store, key, bytes, meta);
  } catch {
    // 唔回顯底層錯誤內容（避免泄露 binding 細節）
    return json({ ok: false, error: 'storage_error' }, 500);
  }

  return json({
    ok: true,
    file: { key, name, size: meta.size, type, uploadedAt, url: rawUrl(key) }
  }, 200);
}

/** GET /api/list */
async function handleList({ request, env, url, store }) {
  if (REQUIRE_AUTH_ON_LIST) {
    const provided = pickToken(request, url, null);
    if (!(await isAuthorized(env, provided))) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  const limit = parseLimit(url.searchParams.get('limit'));
  const sinceMs = parseSince(url.searchParams.get('since'));
  const sinceDay = sinceMs === null ? null : new Date(sinceMs).toISOString().slice(0, 10);

  const all = await storeList(store, sinceDay);
  const files = (sinceMs === null
    ? all
    : all.filter((f) => Date.parse(f.uploadedAt) > sinceMs)
  ).slice(0, limit);

  return json({ ok: true, count: files.length, files });
}

/**
 * GET /api/raw?key=<key> —— 需要 token（header x-upload-token 或 query ?token=）
 *
 * 檢查次序：一定要 auth 先行。未認證就回 bad_key／not_found，等於免費俾人探
 * 「某個 key 存唔存在」，所以 key 驗證同存在性檢查都放喺 auth 之後。
 * 前端唔應該用裸連結／<img src>：key 內含 epoch-ms 可被枚舉，而且上傳檔案係同源內容，
 * 直接開 HTML 有 XSS 風險 —— 應該 fetch（帶 token）再用 blob URL 顯示。
 */
async function handleRaw({ request, env, url, store }) {
  const provided = pickToken(request, url, null);
  if (!(await isAuthorized(env, provided))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const key = url.searchParams.get('key') || '';
  if (!isValidKey(key)) return json({ ok: false, error: 'bad_key' }, 400);

  const found = await storeRead(store, key);
  if (!found) return json({ ok: false, error: 'not_found' }, 404);

  const name = found.entry.name || keyName(key);
  // Content-Disposition 只准 ASCII：唔安全嘅字元換 '_'，另外用 RFC 5987 filename* 帶返原名
  const asciiName = (name.replace(/[\r\n"\\]/g, '_').replace(/[^\x20-\x7e]/g, '_').slice(0, 120)) || 'download';
  const disposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`;

  return new Response(found.bytes, {
    status: 200,
    headers: {
      'Content-Type': found.entry.type || 'application/octet-stream',
      'Content-Disposition': disposition,
      ...RAW_SECURITY_HEADERS
      // 注意：刻意唔加 Access-Control-Allow-Origin
    }
  });
}

/** POST /api/delete（body {"key":"...","token":"..."} 或 header token） */
async function handleDelete({ request, env, url, store }) {
  // 只有真有 body 才 parse；parse 失敗回 bad_request（唔當 bad_key，方便分辨）
  const text = await request.text().catch(() => '');
  let body = {};
  if (text.trim() !== '') {
    const parsed = safeJson(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return json({ ok: false, error: 'bad_request' }, 400);
    }
    body = parsed;
  }

  const provided = pickToken(request, url, body);
  if (!(await isAuthorized(env, provided))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const key = typeof body.key === 'string' && body.key !== ''
    ? body.key
    : (url.searchParams.get('key') || '');
  if (!isValidKey(key)) return json({ ok: false, error: 'bad_key' }, 400);

  const deleted = await storeDelete(store, key);
  if (!deleted) return json({ ok: false, error: 'not_found' }, 404);
  return json({ ok: true, deleted: key }, 200);
}

/* ===================== 8. Router ===================== */

/**
 * Pages Functions entry：/api 之下所有路徑都入嚟呢個檔案，自己 route。
 * 注意：functions/api/[[path]].js 係 optional catch-all，/api 同 /api/ 都會入嚟。
 */
export async function onRequest(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const route = url.pathname.replace(/\/+$/, ''); // 去掉結尾斜線：/api/upload/ 都通

    if (route !== '/api/upload' && route !== '/api/list' &&
        route !== '/api/raw' && route !== '/api/delete') {
      return json({ ok: false, error: 'not_found' }, 404);
    }

    // 方法檢查（未知方法／方法唔對都要 405 + Allow）
    const allowed = (route === '/api/upload' || route === '/api/delete') ? 'POST' : 'GET';
    if (method !== allowed) return methodNotAllowed(allowed);

    const store = getStore(env);
    if (!store) return json({ ok: false, error: 'no_storage' }, 500);

    const ctx = { request, env, url, store };
    if (route === '/api/upload') return await handleUpload(ctx);
    if (route === '/api/list') return await handleList(ctx);
    if (route === '/api/raw') return await handleRaw(ctx);
    return await handleDelete(ctx);
  } catch {
    // 兜底：唔向外泄露 stack／內部細節，亦絕對唔會回顯 token
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}
