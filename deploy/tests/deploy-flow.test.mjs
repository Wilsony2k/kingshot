/**
 * deploy/deploy.sh 流程測試 — 用 mock Cloudflare API + mock Pages site，唔需要真 token
 *
 * 用法：node deploy/tests/deploy-flow.test.mjs
 *
 * 覆蓋：
 *   - token 讀取（env / 檔案）、冇 token 友善報錯、token 唔會泄漏到輸出
 *   - account 解析（1 個／多個 → 要求指定）
 *   - 專案解析（只認 domains 含目標網域嘅專案；0 個／2 個 → 列候選 + exit 1）
 *   - 報告 Direct Upload vs Git-connected、bindings/vars 只列名
 *   - KV namespace 重用／建立
 *   - deployment_configs 合併（保留原有 bindings/vars/env_vars，production + preview 都加）
 *   - secret 設定（body 用 secret_text；輸出永遠遮罩）
 *   - --dry-run 全唯讀（唔會 PATCH／唔會建立 KV）
 *   - 線上驗證（用真 functions/api/[[path]].js + mock R2）：upload→raw sha256→delete
 *   - 真 wrangler 部署路徑會喺 auth 失敗時乾淨 exit 1（用假 token，唔會改任何嘢）
 */
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');
const DEPLOY_SH = join(REPO, 'deploy', 'deploy.sh');
const ROUTE_FILE = join(REPO, 'functions', 'api', '[[path]].js');

const CF_TOKEN = 'fake-cf-api-token-for-tests';
const UP_TOKEN = 'test-upload-token-abcdef123456';
const TMP = mkdtempSync(join(tmpdir(), 'kz-deploy-test-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

/* ===================== 測試框架 ===================== */
let pass = 0;
const failures = [];
const allOutput = [];
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name} ${detail}`); console.log(`  ❌ ${name} ${detail}`); }
}
function contains(name, hay, needle) {
  check(name, hay.includes(needle), `→ 搵唔到 ${JSON.stringify(needle)}`);
}
function notContains(name, hay, needle) {
  check(name, !hay.includes(needle), `→ 唔應該出現 ${JSON.stringify(needle)}`);
}

/* ===================== mock Pages Function（真 functions/api 檔） ===================== */
class MockR2 {
  constructor() { this.map = new Map(); }
  async put(key, value, opts = {}) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.map.set(key, { bytes, httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {} });
  }
  async get(key) {
    const o = this.map.get(key); if (!o) return null;
    return { key, size: o.bytes.length, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata,
      uploaded: new Date(), arrayBuffer: async () => o.bytes.slice().buffer };
  }
  async head(key) { const o = this.map.get(key); return o ? { key, size: o.bytes.length } : null; }
  async delete(key) { this.map.delete(key); }
  async list(opts = {}) {
    const keys = [...this.map.keys()].sort();
    const page = keys.slice(0, opts.limit || 1000);
    const objects = page.map((k) => { const o = this.map.get(k); const out = { key: k, size: o.bytes.length, uploaded: new Date() };
      if ((opts.include || []).includes('customMetadata')) out.customMetadata = o.customMetadata;
      if ((opts.include || []).includes('httpMetadata')) out.httpMetadata = o.httpMetadata; return out; });
    return { objects, truncated: false, cursor: undefined };
  }
}

/* ===================== mock server（CF API + Pages site 同一個 port） ===================== */
function startMock(cfg = {}) {
  const state = {
    accounts: cfg.accounts ?? [{ id: 'acc-1', name: 'Wilson Account' }],
    projects: JSON.parse(JSON.stringify(cfg.projects ?? [])),
    kvs: JSON.parse(JSON.stringify(cfg.kvs ?? [])),
    r2Buckets: JSON.parse(JSON.stringify(cfg.r2Buckets ?? [])),
    r2Creates: 0,
    siteMode: cfg.siteMode ?? 'ok',
    siteToken: cfg.siteToken ?? UP_TOKEN,
    patches: [],
    kvCreates: 0,
    siteRequests: [],
    cfRequests: [],
    authHeadersSeen: []
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks);            // 保留 binary（multipart 上傳唔可以經 UTF-8 轉換）
    const bodyText = rawBody.toString('utf8');
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    state.authHeadersSeen.push(req.headers.authorization || '');

    // ---- CF API ----
    if (p.startsWith('/client/v4/')) {
      state.cfRequests.push(`${req.method} ${p}${u.search}`);
      if (p === '/client/v4/accounts' && req.method === 'GET') {
        return json({ success: true, result: state.accounts, errors: [], messages: [], result_info: { count: state.accounts.length } });
      }
      let m;
      if ((m = p.match(/^\/client\/v4\/accounts\/([^/]+)\/pages\/projects$/)) && req.method === 'GET') {
        // 真 API 行為：per_page 上限 10，超過回 400 + 8000024（實測）
        const per = Number(u.searchParams.get('per_page') || 10);
        if (per > 10) {
          return json({ success: false, result: null, errors: [{ code: 8000024, message: 'Invalid list options provided. Review the `page` or `per_page` parameter.' }], messages: [] }, 400);
        }
        const page = Number(u.searchParams.get('page') || 1);
        const slice = state.projects.slice((page - 1) * per, page * per);
        return json({ success: true, result: slice, errors: [], messages: [],
          result_info: { page, per_page: per, count: slice.length, total_count: state.projects.length, total_pages: Math.max(1, Math.ceil(state.projects.length / per)) } });
      }
      if ((m = p.match(/^\/client\/v4\/accounts\/([^/]+)\/pages\/projects\/([^/]+)$/))) {
        const proj = state.projects.find((x) => x.name === decodeURIComponent(m[2]));
        if (!proj) return json({ success: false, result: null, errors: [{ code: 8000007, message: 'Project not found' }], messages: [] }, 404);
        if (req.method === 'GET') return json({ success: true, result: proj, errors: [], messages: [] });
        if (req.method === 'PATCH') {
          const incoming = JSON.parse(bodyText || '{}');
          state.patches.push(incoming);
          // 模擬 CF：每個 env 嘅 deployment_configs 係整份替換
          for (const [env, dcCfg] of Object.entries(incoming.deployment_configs || {})) {
            proj.deployment_configs = proj.deployment_configs || {};
            proj.deployment_configs[env] = JSON.parse(JSON.stringify(dcCfg));
          }
          return json({ success: true, result: proj, errors: [], messages: [] });
        }
      }
      if ((m = p.match(/^\/client\/v4\/accounts\/([^/]+)\/storage\/kv\/namespaces$/))) {
        if (req.method === 'GET') {
          return json({ success: true, result: state.kvs, errors: [], messages: [], result_info: { count: state.kvs.length, page: 1, per_page: 100, total_count: state.kvs.length, total_pages: 1 } });
        }
        if (req.method === 'POST') {
          const incoming = JSON.parse(bodyText || '{}');
          const created = { id: 'kv-created-0001', title: incoming.title };
          state.kvs.push(created);
          state.kvCreates++;
          return json({ success: true, result: created, errors: [], messages: [] });
        }
      }
      if ((m = p.match(/^\/client\/v4\/accounts\/([^/]+)\/r2\/buckets\/([^/]+)$/)) && req.method === 'GET') {
        const b = state.r2Buckets.find((x) => x.name === decodeURIComponent(m[2]));
        if (!b) return json({ success: false, result: null, errors: [{ code: 10006, message: 'The specified bucket does not exist.' }], messages: [] }, 404);
        return json({ success: true, result: { name: b.name }, errors: [], messages: [] });
      }
      if ((m = p.match(/^\/client\/v4\/accounts\/([^/]+)\/r2\/buckets$/)) && req.method === 'POST') {
        const incoming = JSON.parse(bodyText || '{}');
        state.r2Buckets.push({ name: incoming.name });
        state.r2Creates++;
        return json({ success: true, result: { name: incoming.name }, errors: [], messages: [] });
      }
      return json({ success: false, result: null, errors: [{ code: 7003, message: 'Could not route to ' + p }], messages: [] }, 404);
    }

    // ---- Pages site ----
    state.siteRequests.push(`${req.method} ${p}`);
    if (p === '/' || p === '/index.html' || p === '/upload.html') {
      const f = join(REPO, 'docs', 'events', p === '/upload.html' ? 'upload.html' : 'index.html');
      const html = existsSync(f) ? readFileSync(f) : '<html>stub</html>';
      if (p === '/upload.html' && state.siteMode === 'no-upload-html') return json({ ok: false, error: 'not_found' }, 404);
      if (p === '/upload.html' && state.siteMode === 'fallback') {
        // Pages 行為：唔存在嘅路徑回 200 + 首頁內容
        const idx = join(REPO, 'docs', 'events', 'index.html');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(existsSync(idx) ? readFileSync(idx) : '<html>index</html>');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (p.startsWith('/api/')) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
        method: req.method, headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody
      });
      const env = { UPLOAD_TOKEN: state.siteToken, UPLOADS: state.r2 };
      const resp = await routeMod.onRequest({ request, env, params: { path: [] }, data: {}, waitUntil() {}, next() {} });
      res.writeHead(resp.status, Object.fromEntries(resp.headers));
      return res.end(Buffer.from(await resp.arrayBuffer()));
    }
    return json({ ok: false, error: 'not_found' }, 404);
  });

  state.r2 = new MockR2();
  const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  state.port = null;
  state.ready = ready.then((port) => { state.port = port; return state; });
  state.close = () => new Promise((r) => server.close(r));
  return state;
}

/* ===================== 專案 fixture ===================== */
function projectFixture({ source = 'direct_upload', domain = 'avgkingshot.85200852.xyz', name = 'avgkingshot', shape = 'dict' } = {}) {
  return {
    name,
    id: 'proj-1',
    domains: domain ? [domain] : [],
    subdomain: `${name}.pages.dev`,
    source: source === 'none' ? undefined
      : source === 'direct_upload' ? { type: 'direct_upload' }
      : { type: 'github', config: { owner: 'Wilsony2k', repo_name: 'kingshot', production_branch: 'main', build_command: '', destination_dir: 'docs/events' } },
    latest_deployment: { created_on: '2026-09-29T06:00:00Z' },
    deployment_configs: {
      // 真 CF Pages API 嘅形狀：bindings 係 dict（key = binding 名），唔係 array（已用真 API 核實）
      production: shape === 'list'
        ? { compatibility_date: '2026-01-01',
            kv_namespaces: [{ name: 'OLD_KV', namespace_id: 'old-kv-id' }],
            r2_buckets: [{ name: 'OLD_R2', bucket_name: 'old-bucket' }],
            vars: { FOO: 'bar' }, env_vars: { SECRET_OTHER: { type: 'secret_text' } } }
        : { compatibility_date: '2026-01-01', fail_open: true, usage_model: 'standard',
            kv_namespaces: { OLD_KV: { namespace_id: 'old-kv-id' } },
            r2_buckets: { OLD_R2: { name: 'old-bucket' } },
            vars: { FOO: 'bar' }, env_vars: { SECRET_OTHER: { type: 'secret_text' } } },
      preview: shape === 'list'
        ? { compatibility_date: '2026-01-01', kv_namespaces: [], vars: {}, env_vars: {} }
        : { compatibility_date: '2026-01-01', kv_namespaces: {}, vars: {}, env_vars: {} }
    }
  };
}

/* ===================== 跑 deploy.sh ===================== */
// 一定要用 async spawn：spawnSync 會阻塞 parent event loop，mock server 就回應唔到 child 嘅 HTTP request（死鎖）
function runDeploy({ args = [], extraEnv = {}, dropEnv = ['CLOUDFLARE_API_TOKEN', 'UPLOAD_TOKEN'], timeout = 300000 } = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CF_') || k === 'SITE_BASE' || k.startsWith('UPLOAD_') || k.startsWith('npm_config_') || k === 'HOME') delete env[k];
  }
  for (const k of dropEnv) delete env[k];
  Object.assign(env, extraEnv);
  env.CI = '1';
  env.WRANGLER_SEND_METRICS = 'false';
  return new Promise((resolve) => {
    const child = spawn('bash', [DEPLOY_SH, ...args], { cwd: REPO, env });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { try { child.kill('SIGKILL'); } catch {} }
    }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end();   // stdin 即刻 EOF：任何互動 prompt 都會即刻失敗，唔會掛住
    child.on('close', (code, signal) => {
      settled = true;
      clearTimeout(timer);
      const joined = out + err;
      allOutput.push(joined);
      if (process.env.KZ_VERBOSE) console.log(`----- deploy.sh 輸出開始（exit=${signal ? 'signal:' + signal : code}）-----\n` + joined + '----- deploy.sh 輸出完 -----');
      resolve({ code: signal ? null : code, signal, out: joined, stdout: out, stderr: err });
    });
  });
}

/* ===================== 真 functions/api 檔（複製去 temp 再 import） ===================== */
const routeCopy = join(TMP, 'route-under-test.mjs');
writeFileSync(routeCopy, readFileSync(ROUTE_FILE, 'utf8'));
const routeMod = await import(pathToFileURL(routeCopy).href);

/* ===================== 測試 ===================== */
// 可以只跑指定 section：KZ_ONLY=1,2,3 node deploy/tests/deploy-flow.test.mjs
const want = (n) => !process.env.KZ_ONLY || process.env.KZ_ONLY.split(',').map((x) => x.trim()).includes(String(n));

const cfTokenFile = join(TMP, 'cf-token');
const upTokenFile = join(TMP, 'upload-token');
writeFileSync(cfTokenFile, CF_TOKEN + '\n');
writeFileSync(upTokenFile, UP_TOKEN + '\n');
const envBase = { CF_TOKEN_FILE: cfTokenFile, UPLOAD_TOKEN_FILE: upTokenFile, CLOUDFLARE_API_TOKEN: CF_TOKEN };

if (want(1)) {
console.log('\n[1] token 讀取同錯誤路徑');
{
  const r = await runDeploy({ args: ['--dry-run'], dropEnv: ['CLOUDFLARE_API_TOKEN', 'UPLOAD_TOKEN'],
    extraEnv: { CF_TOKEN_FILE: join(TMP, 'does-not-exist'), UPLOAD_TOKEN_FILE: upTokenFile } });
  check('1a 冇 CF token → exit 1', r.code === 1, `→ ${r.code}`);
  contains('1a 友善錯誤訊息', r.out, '搵唔到 Cloudflare API token');
  contains('1a 提示兩種提供方式', r.out, 'CLOUDFLARE_API_TOKEN');

  const r2 = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CLOUDFLARE_API_TOKEN: '' } });
  check('1b 空 env token 會 fallback 讀檔案', r2.code === 0 || r2.out.includes('CF API token 來源'), `→ code=${r2.code}`);
  contains('1b 顯示來源檔案路徑', r2.out, cfTokenFile);
  notContains('1b 唔會顯示 token 內容', r2.out, CF_TOKEN);

  const r3 = await runDeploy({ args: ['--bogus'], extraEnv: envBase });
  check('1c 未知參數 → exit 1', r3.code === 1, `→ ${r3.code}`);
  contains('1c 提示 --help', r3.out, '--help');
}

}
if (want(2)) {
console.log('\n[2] account 解析');
{
  const mock = startMock({ accounts: [{ id: 'acc-1', name: 'A' }, { id: 'acc-2', name: 'B' }], projects: [projectFixture()] });
  const st = await mock.ready;
  const base = `http://127.0.0.1:${st.port}/client/v4`;
  const r = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: base } });
  check('2a 多過一個 account → exit 1', r.code === 1, `→ ${r.code}`);
  contains('2a 列出 account-1', r.out, 'acc-1');
  contains('2a 列出 account-2', r.out, 'acc-2');
  contains('2a 提示用 CF_ACCOUNT_ID', r.out, 'CF_ACCOUNT_ID');

  const r2 = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: base, CF_ACCOUNT_ID: 'acc-2' } });
  check('2b 指定 CF_ACCOUNT_ID → 繼續', r2.code === 0, `→ ${r2.code}`);
  contains('2b 有報 account id', r2.out, 'acc-2');

  const empty = startMock({ accounts: [], projects: [] });
  const st2 = await empty.ready;
  const r3 = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${st2.port}/client/v4` } });
  check('2c 0 個 account → exit 1', r3.code === 1, `→ ${r3.code}`);
  contains('2c 提示權限', r3.out, '睇唔到任何 account');
  await mock.close(); await empty.close();
}

}
if (want(3)) {
console.log('\n[3] 專案解析');
{
  const noMatch = startMock({ projects: [projectFixture({ domain: 'other.example.com', name: 'other' })] });
  const s1 = await noMatch.ready;
  const r = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${s1.port}/client/v4` } });
  check('3a 搵唔到比對網域嘅專案 → exit 1', r.code === 1, `→ ${r.code}`);
  contains('3a 提示 CF_PAGES_PROJECT', r.out, 'CF_PAGES_PROJECT');
  await noMatch.close();

  const dup = startMock({ projects: [projectFixture({ name: 'p1' }), projectFixture({ name: 'p2' })] });
  const s2 = await dup.ready;
  const r2 = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${s2.port}/client/v4` } });
  check('3b 兩個專案都中 → exit 1', r2.code === 1, `→ ${r2.code}`);
  contains('3b 列候選 p1', r2.out, 'p1');
  contains('3b 列候選 p2', r2.out, 'p2');
  await dup.close();

  const one = startMock({ projects: [projectFixture({ name: 'avgkingshot' })] });
  const s3 = await one.ready;
  const r3 = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${s3.port}/client/v4`, CF_PAGES_PROJECT: 'avgkingshot' } });
  check('3c 指定 CF_PAGES_PROJECT → exit 0', r3.code === 0, `→ ${r3.code}`);
  await one.close();

  const missing = startMock({ projects: [] });
  const s4 = await missing.ready;
  const r4 = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${s4.port}/client/v4`, CF_PAGES_PROJECT: 'nope' } });
  check('3d 指定唔存在嘅專案 → exit 1', r4.code === 1, `→ ${r4.code}`);
  contains('3d 顯示 CF error 8000007', r4.out, '8000007');
  await missing.close();
}

}
if (want(4)) {
console.log('\n[4] --dry-run（全唯讀）：報告 + 計劃，唔可以改任何嘢');
{
  const mock = startMock({ projects: [projectFixture({ source: 'direct_upload' })], kvs: [{ id: 'kv-existing', title: 'kingshot-uploads' }] });
  const st = await mock.ready;
  const r = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${st.port}/client/v4` } });
  check('4a exit 0', r.code === 0, `→ ${r.code}`);
  contains('4a 報告 Direct Upload', r.out, 'Direct Upload');
  contains('4a 顯示 source.type', r.out, 'source.type=direct_upload');
  contains('4a 列出原有 binding 名', r.out, 'OLD_KV');
  contains('4a 列出原有 vars 名', r.out, 'vars');
  contains('4a 列出原有 env_vars 名', r.out, 'SECRET_OTHER');
  notContains('4a 唔會顯示 secret 值（本身都冇值）', r.out, 'secret-value');
  contains('4a KV 重用', r.out, 'KV namespace 已存在，重用');
  contains('4a 顯示計劃 PATCH bindings', r.out, '會 PATCH production + preview');
  contains('4a secret 遮罩成 ***', r.out, '"value": "***"');
  contains('4a 唔部署', r.out, '未部署');
  check('4a mock 收到 0 個 PATCH', st.patches.length === 0, `→ ${st.patches.length}`);
  check('4a mock 冇建立 KV', st.kvCreates === 0, `→ ${st.kvCreates}`);
  notContains('4a 輸出冇 upload token', r.out, UP_TOKEN);
  notContains('4a 輸出冇 CF token', r.out, CF_TOKEN);
  await mock.close();

  // 4e：真實 Direct Upload 專案嘅 API 形狀係「冇 source 欄位」（實測真 CF API）
  const noSrc = await startMock({ projects: [projectFixture({ source: 'none' })] });
  const sn = await noSrc.ready;
  const rn = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${sn.port}/client/v4` } });
  check('4e 冇 source 欄位 → exit 0', rn.code === 0, `→ ${rn.code}`);
  contains('4e 判斷為 Direct Upload', rn.out, 'Direct Upload（API 冇 source 欄位');
  await noSrc.close();

  const git = startMock({ projects: [projectFixture({ source: 'github' })], kvs: [] });
  const sg = await git.ready;
  const rg = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${sg.port}/client/v4` } });
  check('4b git-connected → exit 0', rg.code === 0, `→ ${rg.code}`);
  contains('4b 報告 Git-connected', rg.out, 'Git-connected');
  contains('4b 顯示 git repo 設定', rg.out, 'Wilsony2k/kingshot');
  contains('4b KV 唔存在 → 計劃建立', rg.out, '會建立 KV namespace');
  check('4b 唯讀：冇建立 KV', sg.kvCreates === 0, `→ ${sg.kvCreates}`);
  await git.close();
}

}
if (want(5)) {
console.log('\n[5] CF_DRY_RUN_APPLY=1：真做 a–g（KV + bindings 合併 + secret），但唔部署');
{
  const mock = startMock({ projects: [projectFixture({ source: 'direct_upload' })], kvs: [], r2Buckets: [{ name: 'kingshot-uploads' }] });
  const st = await mock.ready;
  // 唔傳 CF_R2_BUCKET → 用預設 kingshot-uploads（兩個 binding 都要綁）
  const r = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${st.port}/client/v4`, CF_DRY_RUN_APPLY: '1' } });
  check('5a exit 0', r.code === 0, `→ ${r.code}`);
  check('5a 建立咗 1 個 KV namespace', st.kvCreates === 1, `→ ${st.kvCreates}`);
  check('5a 收到 2 個 PATCH（bindings + secret）', st.patches.length === 2, `→ ${st.patches.length}`);
  notContains('5a 唔會真部署（冇「部署指令完成」）', r.out, '部署指令完成');
  contains('5a 只印出部署計劃', r.out, '真正部署時會執行');

  const proj = st.projects[0];
  const prod = proj.deployment_configs.production;
  const prev = proj.deployment_configs.preview;
  // 形狀無關嘅取 binding 名（真 API = dict，舊格式 = list）
  const bNames = (v) => (Array.isArray(v) ? v.map((b) => b.name) : Object.keys(v || {}));
  const kvNames = (c) => bNames(c.kv_namespaces);
  check('5b production 加咗 UPLOADS_KV', kvNames(prod).includes('UPLOADS_KV'), `→ ${JSON.stringify(kvNames(prod))}`);
  check('5b production 保留原有 OLD_KV', kvNames(prod).includes('OLD_KV'), `→ ${JSON.stringify(kvNames(prod))}`);
  check('5b preview 都加咗 UPLOADS_KV', kvNames(prev).includes('UPLOADS_KV'), `→ ${JSON.stringify(kvNames(prev))}`);
  const newKvId = Array.isArray(prod.kv_namespaces)
    ? (prod.kv_namespaces.find((b) => b.name === 'UPLOADS_KV') || {}).namespace_id
    : (prod.kv_namespaces.UPLOADS_KV || {}).namespace_id;
  check('5b binding 指向新 namespace id', newKvId === 'kv-created-0001', `→ ${newKvId}`);
  check('5b 保持 dict 形狀（唔會改成 array）', !Array.isArray(prod.kv_namespaces), `→ ${Array.isArray(prod.kv_namespaces) ? 'array' : 'dict'}`);
  const r2Names = bNames(prod.r2_buckets);
  check('5c R2 binding 已加（預設 kingshot-uploads）', r2Names.includes('UPLOADS'), `→ ${JSON.stringify(prod.r2_buckets)}`);
  const r2Bucket = Array.isArray(prod.r2_buckets)
    ? (prod.r2_buckets.find((b) => b.name === 'UPLOADS') || {}).bucket_name
    : ((prod.r2_buckets.UPLOADS || {}).name);
  check('5c R2 binding 指向正確 bucket', r2Bucket === 'kingshot-uploads', `→ ${r2Bucket}`);
  check('5c11 R2 bucket 已存在 → 重用（冇重複建立）', st.r2Creates === 0, `→ ${st.r2Creates}`);
  contains('5c11 有印最終 binding 清單', r.out, '最終 bindings');
  contains('5c11 KV binding 列出 id', r.out, 'UPLOADS_KV = namespace_id kv-created-0001');
  contains('5c11 R2 binding 列出 bucket', r.out, 'UPLOADS = bucket kingshot-uploads');
  check('5c 原有 R2 binding 保留', r2Names.includes('OLD_R2'), `→ ${JSON.stringify(prod.r2_buckets)}`);
  check('5c fail_open / usage_model 等原有 key 保留', prod.fail_open === true && prod.usage_model === 'standard', `→ ${JSON.stringify(Object.keys(prod))}`);
  check('5d 原本 vars.FOO 保留', prod.vars && prod.vars.FOO === 'bar', `→ ${JSON.stringify(prod.vars)}`);
  check('5d 原本 env_vars.SECRET_OTHER 保留', !!(prod.env_vars && prod.env_vars.SECRET_OTHER), `→ ${JSON.stringify(prod.env_vars)}`);
  check('5d UPLOAD_TOKEN 係 secret_text', prod.env_vars.UPLOAD_TOKEN.type === 'secret_text', `→ ${JSON.stringify(prod.env_vars.UPLOAD_TOKEN)}`);
  check('5d UPLOAD_TOKEN 值正確', prod.env_vars.UPLOAD_TOKEN.value === UP_TOKEN, '→ 值唔對');
  check('5e preview 都有 UPLOAD_TOKEN', !!(prev.env_vars && prev.env_vars.UPLOAD_TOKEN), `→ ${JSON.stringify(prev.env_vars)}`);
  check('5e compatibility_date 保留', prod.compatibility_date === '2026-01-01', `→ ${prod.compatibility_date}`);
  // 5g：CF_R2_BUCKET= 空 → 只綁 KV
  const kvOnly = startMock({ projects: [projectFixture({ source: 'direct_upload' })], kvs: [{ id: 'kv-existing', title: 'kingshot-uploads' }] });
  const skv = await kvOnly.ready;
  const rkv = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${skv.port}/client/v4`, CF_DRY_RUN_APPLY: '1', CF_R2_BUCKET: '' } });
  check('5g CF_R2_BUCKET 空 → exit 0', rkv.code === 0, `→ ${rkv.code}`);
  const kvOnlyR2 = bNames(skv.projects[0].deployment_configs.production.r2_buckets);
  check('5g 冇加我哋嘅 R2 binding（原有 OLD_R2 照舊保留）',
    !kvOnlyR2.includes('UPLOADS') && kvOnlyR2.includes('OLD_R2'),
    `→ ${JSON.stringify(skv.projects[0].deployment_configs.production.r2_buckets)}`);
  check('5g 仍然有 KV binding', bNames(skv.projects[0].deployment_configs.production.kv_namespaces).includes('UPLOADS_KV'), '→ 冇 UPLOADS_KV');
  await kvOnly.close();

  // 5h：R2 bucket 唔存在 → 唯讀只計劃；apply 模式會建立
  const noBucket = startMock({ projects: [projectFixture({ source: 'direct_upload' })], kvs: [{ id: 'kv-existing', title: 'kingshot-uploads' }], r2Buckets: [] });
  const snb = await noBucket.ready;
  const rnb = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${snb.port}/client/v4` } });
  check('5h 唯讀 dry-run exit 0', rnb.code === 0, `→ ${rnb.code}`);
  contains('5h 唯讀只計劃建立 R2 bucket', rnb.out, '（dry-run）會建立 R2 bucket：kingshot-uploads');
  check('5h 唯讀冇真建立', snb.r2Creates === 0, `→ ${snb.r2Creates}`);
  const rnb2 = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${snb.port}/client/v4`, CF_DRY_RUN_APPLY: '1' } });
  check('5h apply 模式 exit 0', rnb2.code === 0, `→ ${rnb2.code}`);
  check('5h apply 模式建立咗 1 個 R2 bucket', snb.r2Creates === 1, `→ ${snb.r2Creates}`);
  await noBucket.close();

  // 5i：唔可以碰其他人嘅 KV namespace（img_url）
  const withOther = startMock({ projects: [projectFixture({ source: 'direct_upload' })], kvs: [{ id: 'kv-existing', title: 'kingshot-uploads' }, { id: 'kv-img', title: 'img_url' }], r2Buckets: [{ name: 'kingshot-uploads' }] });
  const swo = await withOther.ready;
  const rwo = await runDeploy({ args: ['--dry-run'], extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${swo.port}/client/v4`, CF_DRY_RUN_APPLY: '1' } });
  check('5i exit 0', rwo.code === 0, `→ ${rwo.code}`);
  contains('5i 有列出唔會碰嘅 namespace', rwo.out, 'img_url');
  check('5i img_url 完全冇被動過', swo.kvs.some((k) => k.title === 'img_url'), `→ ${JSON.stringify(swo.kvs)}`);
  check('5i 冇多建立 namespace', swo.kvs.length === 2 && swo.kvCreates === 0, `→ kvs=${swo.kvs.length} creates=${swo.kvCreates}`);
  await withOther.close();

  notContains('5f 輸出冇 upload token 值', r.out, UP_TOKEN);
  notContains('5f 輸出冇 CF token 值', r.out, CF_TOKEN);
  contains('5f 有報告原有 bindings 冇缺失', r.out, '原有 bindings/vars 全部保留');
  await mock.close();
}

}
if (want(6)) {
console.log('\n[6] --verify-only：對真 functions/api + mock R2 做線上驗證');
{
  const mock = startMock({ projects: [projectFixture()] });
  const st = await mock.ready;
  const base = `http://127.0.0.1:${st.port}`;
  const r = await runDeploy({ args: ['--verify-only'], extraEnv: { UPLOAD_TOKEN: UP_TOKEN, UPLOAD_TOKEN_FILE: upTokenFile, SITE_BASE: base } });
  check('6a exit 0', r.code === 0, `→ ${r.code}`);
  contains('6a upload.html 200', r.out, 'GET /upload.html → 200');
  contains('6a list 冇 token 401', r.out, '（冇 token）→ 401');
  contains('6a list 帶 token 200', r.out, '（帶 token）→ 200 ok:true');
  contains('6a upload 200', r.out, 'POST /api/upload → 200');
  contains('6a raw 冇 token → 401', r.out, 'GET /api/raw（冇 token）→ 401');
  contains('6a raw 錯 token → 401', r.out, 'GET /api/raw（錯 token）→ 401');
  contains('6a raw 帶 token sha256 一致', r.out, 'GET /api/raw（帶 token）sha256 一致');
  contains('6a raw 有 CSP + nosniff', r.out, '有 CSP sandbox + nosniff');
  contains('6a raw 冇 CORS', r.out, '冇加 CORS header');
  contains('6a delete 200', r.out, 'POST /api/delete → 200');
  const listAfter = await (async () => {
    const resp = await fetch(`${base}/api/list`, { headers: { 'x-upload-token': UP_TOKEN } });
    return resp.json();
  })();
  check('6b 測試檔已清走（list count=0）', listAfter.count === 0, `→ count=${listAfter.count}`);
  await mock.close();

  // 驗證失敗情境：token 唔對 → list 帶 token 應該 401
  const wrong = startMock({ siteToken: 'a-different-token' });
  const sw = await wrong.ready;
  const r2 = await runDeploy({ args: ['--verify-only'], extraEnv: { UPLOAD_TOKEN: UP_TOKEN, UPLOAD_TOKEN_FILE: upTokenFile, SITE_BASE: `http://127.0.0.1:${sw.port}` } });
  check('6c token 唔對 → exit 1', r2.code === 1, `→ ${r2.code}`);
  contains('6c 指出 401', r2.out, '期望 200 + ok:true');
  contains('6c 有印 response body', r2.out, 'unauthorized');
  await wrong.close();

  // /upload.html 404 → 應該 fail
  const noHtml = startMock({ siteMode: 'no-upload-html' });
  const sh = await noHtml.ready;
  const r3 = await runDeploy({ args: ['--verify-only'], extraEnv: { UPLOAD_TOKEN: UP_TOKEN, UPLOAD_TOKEN_FILE: upTokenFile, SITE_BASE: `http://127.0.0.1:${sh.port}` } });
  check('6d upload.html 404 → exit 1', r3.code === 1, `→ ${r3.code}`);
  contains('6d 指出 upload.html 問題', r3.out, 'GET /upload.html → HTTP 404');
  await noHtml.close();

  // 冇 token 檔
  // 6g：Pages fallback（/upload.html 回 200 但內容係首頁）→ 要當失敗
  const fb = await startMock({ siteMode: 'fallback' });
  const sf = await fb.ready;
  const rf = await runDeploy({ args: ['--verify-only'], extraEnv: { UPLOAD_TOKEN: UP_TOKEN, UPLOAD_TOKEN_FILE: upTokenFile, SITE_BASE: `http://127.0.0.1:${sf.port}` } });
  check('6g fallback 假陽性 → exit 1', rf.code === 1, `→ ${rf.code}`);
  contains('6g 指出係 fallback', rf.out, 'Pages fallback');
  await fb.close();

  // 6h：env $UPLOAD_TOKEN 一定要贏過 token 檔（曾經有 bug：全域初始化清空 env → 靜靜讀檔）
  const envWins = await startMock({});
  const sw2 = await envWins.ready;
  const wrongFile = join(TMP, 'wrong-token');
  writeFileSync(wrongFile, 'a-completely-wrong-token-in-file\n');
  const r5 = await runDeploy({ args: ['--verify-only'], dropEnv: ['UPLOAD_TOKEN'],
    extraEnv: { UPLOAD_TOKEN: UP_TOKEN, UPLOAD_TOKEN_FILE: wrongFile, SITE_BASE: `http://127.0.0.1:${sw2.port}` } });
  check('6h env UPLOAD_TOKEN 贏過 token 檔（exit 0）', r5.code === 0, `→ ${r5.code}`);
  contains('6h 帶 token 嘅請求成功', r5.out, '（帶 token）→ 200 ok:true');
  await envWins.close();

  const r4 = await runDeploy({ args: ['--verify-only'], dropEnv: ['UPLOAD_TOKEN'], extraEnv: { UPLOAD_TOKEN_FILE: join(TMP, 'nope-token'), SITE_BASE: 'http://127.0.0.1:1' } });
  check('6e verify-only 冇 token → exit 1', r4.code === 1, `→ ${r4.code}`);
  contains('6e 友善提示', r4.out, '搵唔到 upload token');

  // 6f：唔覆蓋 UPLOAD_TOKEN_FILE → 應該讀到預設 deploy/.upload-token（唔會顯示內容）
  if (existsSync(join(REPO, 'deploy', '.upload-token'))) {
    const defMock = await startMock({ siteMode: 'no-upload-html' });
    const sd = await defMock.ready;
    const r5 = await runDeploy({ args: ['--verify-only'], dropEnv: ['UPLOAD_TOKEN', 'UPLOAD_TOKEN_FILE'], extraEnv: { SITE_BASE: `http://127.0.0.1:${sd.port}` } });
    notContains('6f 有讀到預設 deploy/.upload-token（唔係報冇 token）', r5.out, '搵唔到 upload token');
    contains('6f 有真係發出請求', r5.out, 'GET /upload.html');
    await defMock.close();
  } else {
    console.log('  ⏭️  6f 略過：deploy/.upload-token 唔存在');
  }
}

}
if (want(7)) {
console.log('\n[7] 全流程（非 dry-run）：走到 wrangler，用假 token 應該喺 auth 階段乾淨失敗');
{
  const mock = startMock({ projects: [projectFixture({ source: 'direct_upload' })], kvs: [{ id: 'kv-existing', title: 'kingshot-uploads' }] });
  const st = await mock.ready;
  const r = await runDeploy({
    args: ['--no-verify'],
    timeout: 180000,
    extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${st.port}/client/v4`, HOME: join(REPO, '.config-home') }
  });
  check('7a 假 token 部署 → exit 1', r.code === 1, `→ ${r.code}`);
  contains('7a 有行到 wrangler', r.out, 'npx --yes wrangler@latest pages deploy');
  contains('7a 部署失敗有清楚訊息', r.out, 'wrangler 部署失敗');
  notContains('7a/7b 輸出冇 CF token', r.out, CF_TOKEN);
  check('7c 部署前嘅 mutation 有做（2 個 PATCH）', st.patches.length === 2, `→ ${st.patches.length}`);
  const wranglerErr = /wrangler|cloudflare|authentication|Unauthorized|10000/i.test(r.out);
  check('7d wrangler 有實際錯誤輸出', wranglerErr, '→ 睇唔到 wrangler 錯誤');
  await mock.close();

  // 7e：HOME 唔可寫／冇設定（例如 sandbox）→ 自動改用 workspace 內 cache
  const mock2 = await startMock({ projects: [projectFixture()], kvs: [{ id: 'kv-existing', title: 'kingshot-uploads' }] });
  const st2 = await mock2.ready;
  const r5 = await runDeploy({
    args: ['--no-verify'],
    timeout: 180000,
    dropEnv: ['CLOUDFLARE_API_TOKEN', 'UPLOAD_TOKEN', 'HOME'],
    extraEnv: { ...envBase, CF_API_BASE: `http://127.0.0.1:${st2.port}/client/v4` }
  });
  check('7e HOME 空 → 一樣行到 wrangler（exit 1 = auth 失敗）', r5.code === 1, `→ ${r5.code}`);
  contains('7e 自己帶 npm_config_cache（唔靠 caller）', r5.out, 'npm_config_cache=');
  contains('7e 自己帶 XDG_CONFIG_HOME', r5.out, 'XDG_CONFIG_HOME=');
  contains('7e 自己帶 WRANGLER_LOG_PATH', r5.out, 'WRANGLER_LOG_PATH=');
  contains('7e 仍然行到 wrangler', r5.out, 'npx --yes wrangler@latest pages deploy');
  notContains('7e 唔會爆 EROFS', r5.out, 'EROFS');
  await mock2.close();
}

}
if (want(9)) {
console.log('\n[9] staged 部署目錄（唔可以推未提交改動）');
{
  const mock = await startMock({ projects: [projectFixture({ name: 'kingshot-2355-calendar' })] });
  const st = await mock.ready;
  const extra = { ...envBase, CF_API_BASE: `http://127.0.0.1:${st.port}/client/v4` };
  const r = await runDeploy({ args: ['--dry-run'], extraEnv: extra });
  const stage = join(REPO, '.deploy-stage');
  const site = join(stage, 'site');
  check('9a dry-run exit 0', r.code === 0, `→ ${r.code}`);
  contains('9a 有講明未提交改動唔會上線', r.out, '今次會用 HEAD 版本');
  check('9b stage/site 存在', existsSync(site), '→ 冇 .deploy-stage/site');

  const gitArgs = (a) => execFileSync('git', ['-c', `safe.directory=${REPO}`, '-C', REPO, ...a]);
  const headJs = gitArgs(['show', 'HEAD:docs/events/server-2355-calendar.js']);
  const workJs = readFileSync(join(REPO, 'docs', 'events', 'server-2355-calendar.js'));
  const stagedJs = readFileSync(join(site, 'server-2355-calendar.js'));
  check('9b staged js == HEAD 版本', sha(stagedJs) === sha(headJs), '→ 唔一致');
  const isDirty = gitArgs(['status', '--porcelain', '--', 'docs/events/server-2355-calendar.js']).toString().trim() !== '';
  if (isDirty) {
    const workJsNow2 = readFileSync(join(REPO, 'docs', 'events', 'server-2355-calendar.js'));
    check('9b staged js != 工作樹（未提交改動已排除）', sha(stagedJs) !== sha(workJsNow2), '→ 竟然等於工作樹');
  } else {
    console.log('  ⏭️  9b 略過「!= 工作樹」：該檔目前冇未提交改動');
  }
  check('9c 新檔 upload.html 有入 stage', existsSync(join(site, 'upload.html')), '→ 冇 upload.html');
  check('9c HEAD 子目錄 guides/ 有入 stage', existsSync(join(site, 'guides', 'strongest-lord.md')), '→ 冇 guides/');
  // wrangler 用 path.join(process.cwd(), "functions") 解 Functions 目錄 → 由 repo root 執行就得
  check('9d functions 仍然喺 repo root', existsSync(join(REPO, 'functions', 'api', '[[path]].js')), '→ 冇 functions');
  check('9d stage 內冇 functions（源碼唔會被當靜態檔上傳）', !existsSync(join(site, 'functions')), '→ site 內竟然有 functions');
  check('9d stage 內亦冇 copy 一份 functions', !existsSync(join(stage, 'functions')), '→ stage root 竟然有 functions');
  contains('9e 部署指令由 repo root 執行、部署 .deploy-stage/site',
    r.out, `cd ${REPO} && npx --yes wrangler@latest pages deploy .deploy-stage/site`);
  contains('9e 有 pre-flight 編譯 functions', r.out, 'functions 編譯成功');

  // 9f --full-tree 係工作樹版本
  const r2 = await runDeploy({ args: ['--dry-run', '--full-tree'], extraEnv: extra });
  check('9f --full-tree exit 0', r2.code === 0, `→ ${r2.code}`);
  contains('9f --full-tree 有警告', r2.out, '--full-tree');
  if (isDirty) {
    // 即時重讀工作樹（唔用開頭讀落嘅 workJs），避免中間有並行改動造成假失敗
    const workJsNow = readFileSync(join(REPO, 'docs', 'events', 'server-2355-calendar.js'));
    check('9f --full-tree 用工作樹版本', sha(readFileSync(join(site, 'server-2355-calendar.js'))) === sha(workJsNow), '→ 唔係工作樹版本');
  }

  // 9h 收尾：再跑一次預設 dry-run，令留低嘅 .deploy-stage 係「預設 staged」狀態（唔會誤導之後檢查）
  const r3 = await runDeploy({ args: ['--dry-run'], extraEnv: extra });
  check('9h 收尾 exit 0', r3.code === 0, `→ ${r3.code}`);
  check('9h 收尾後 stage 回復 HEAD 版本',
    sha(readFileSync(join(site, 'server-2355-calendar.js'))) === sha(headJs), '→ 唔係 HEAD 版本');

  // 9g 回歸：列 Pages 專案唔可以帶 per_page（Evelyn 真 token 撞到 HTTP 400 / 8000024）
  check('9g 有 GET /pages/projects 而且唔帶 query',
    st.cfRequests.some((x) => /^GET \/client\/v4\/accounts\/[^/]+\/pages\/projects$/.test(x)),
    `→ ${JSON.stringify(st.cfRequests.slice(0, 5))}`);
  // /accounts?per_page=50 係冇問題嘅（實測 200）；有問題嘅只係 pages/projects（per_page>10 → 400）
  check('9g Pages projects 同 KV list 都冇用 per_page',
    !st.cfRequests.some((x) => x.includes('pages/projects?') || x.includes('kv/namespaces?')),
    `→ ${JSON.stringify(st.cfRequests)}`);
  await mock.close();
}
}

if (want(8)) {
console.log('\n[8] token 泄漏全面掃描');
{
  const joined = allOutput.join('\n@@@\n');
  notContains('8a 所有輸出都冇 CF token', joined, CF_TOKEN);
  notContains('8b 所有輸出都冇 upload token', joined, UP_TOKEN);
}

}
console.log(`\n===== 結果：${pass} passed, ${failures.length} failed =====`);
if (failures.length) {
  console.log('失敗項：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通過 ✅');
