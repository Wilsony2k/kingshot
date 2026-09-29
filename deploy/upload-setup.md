# Kingshot 上傳 API — Cloudflare 設定步驟

> 目標：令 `https://avgkingshot.85200852.xyz/api/*` 可以收上傳、列清單、取原始檔、刪檔。
> **本文所有 token 一律用佔位符，唔好 copy 真 token 入 repo。**
> 💡 有咗 CF API token 之後，本文大部分步驟可以自動化：`bash deploy/deploy.sh`
> （見 `deploy/README.md`；先 `--dry-run` 睇報告、`--verify-only` 隨時驗線上狀態）。
> 本文保留作手動設定／排錯參考。

## 0. 架構（先睇清楚邊個檔案去邊）

| 項目 | 值 | 備註 |
|------|-----|------|
| Pages 專案 | **`kingshot-2355-calendar`**（已用 API 核實；account `79bb9aba1666ff7b3ddbfd235f7418fe`） | Direct Upload 專案（API 無 `source` 欄位 → 冇 GitHub 連線）；domains = `kingshot-2355-calendar.pages.dev`、`avgkingshot.85200852.xyz` |
| 網站靜態輸出 | `docs/events/` | 唔需要改，唔會被今次改動影響 |
| Pages Functions | repo 根目錄 `functions/` | **唯一新增嘅 runtime 程式碼**：`functions/api/[[path]].js` |
| API 路由 | `POST /api/upload`、`GET /api/list`、`GET /api/raw`、`POST /api/delete` | 全部由同一個 catch-all function 內部 route |
| Storage | R2 binding `UPLOADS`（優先）或 KV binding `UPLOADS_KV`（後備） | 兩個都冇 → `500 {"ok":false,"error":"no_storage"}` |
| Auth | 環境變數 `UPLOAD_TOKEN` | request 帶 `x-upload-token` header 或 `?token=` |

Functions 同靜態網站喺同一個 Pages 專案，所以 API 同站同 domain，前端可以直接用相對路徑（例如 `/api/raw?key=...`），**唔需要**另外設 CORS。

⚠️ **`/api/raw` 需要 token**（4 個 endpoint 全部要）：唔可以用裸連結／`<img src="/api/raw?key=...">`，因為
① key 內含 epoch-ms，係可枚舉嘅識別碼，唔應該當成授權憑證；② 上傳檔案係同源內容，開上傳嘅 HTML 有 XSS 風險。
前端正確做法：`fetch('/api/raw?key=...', { headers: { 'x-upload-token': TOKEN } })` → `URL.createObjectURL(blob)`，或者由一個帶 token 嘅後端／Worker 代取。

---

## 1. 建立 storage（二選一，或兩個都做）

### 方案 A（建議）：R2 bucket
1. Cloudflare Dashboard → **R2** → **Create bucket**
2. Bucket name：`kingshot-uploads`（任何名都得，記住佢）
3. 之後喺 Pages 專案 binding 用變數名 **`UPLOADS`**（一定要一模一樣）

### 方案 B（後備，免費額度夠用）：KV namespace
1. Dashboard → **Workers & Pages** → **KV** → **Create namespace**
2. Namespace name：`kingshot-uploads`
3. 之後喺 Pages 專案 binding 用變數名 **`UPLOADS_KV`**

> KV 注意：值上限 25 MiB、最終一致性（eventual consistency）。API 會將 10 MiB 檔案 base64 後存（約 13.3 MiB），仍然喺上限內。
> 程式邏輯：**有 R2 就用 R2，冇 R2 才用 KV**；兩個都 bind 都可以（會用 R2）。

---

## 2. 設定環境變數（token）

1. Dashboard → **Workers & Pages** → 專案 `kingshot-2355-calendar` → **Settings** → **Variables and Secrets**（舊版介面叫 Environment variables）
2. **Add** 一項：
   - Name：`UPLOAD_TOKEN`
   - Value：佔位符 → 換成你自己產生嘅長隨機字串，例如本機執行：
     ```bash
     openssl rand -hex 32     # 例：<REPLACE_WITH_64_HEX_CHARS>
     ```
   - Type：**Secret**（加密，唔會喺 UI 再顯示）
   - Environment：**Production**（如果會用 preview 網址測試，Preview 都加同一組）
3. **Save**，然後 **重新 deploy**（Pages 改環境變數唔會自動重新 build，要再 push 或喺 dashboard 按 **Retry deployment**）

> ⚠️ 冇設定 `UPLOAD_TOKEN` 時，**所有需授權 endpoint（`/api/upload`、`/api/list`、`/api/raw`、`/api/delete`）一律回 `401 {"ok":false,"error":"unauthorized"}`**（包括你以為正確嘅 token）——見到 401 先檢查呢一步。
> `/api/raw` 亦一樣：未帶 token 唔會回 400/404，只會回 401（避免未認證就探到某個 key 存唔存在）。

---

## 3. 加 binding（R2 / KV → Functions）

Dashboard → 專案 `kingshot-2355-calendar` → **Settings** → **Functions**（舊版叫 Functions → Bindings）→ 加落 **Production**：

| 種類 | Variable name（必須一致） | 指向 |
|------|--------------------------|------|
| R2 bucket binding | `UPLOADS` | bucket `kingshot-uploads`（已建立，location EEUR / Standard） |
| KV namespace binding | `UPLOADS_KV` | namespace `kingshot-uploads`（id `3e94ca2a19b149c6801122d2b483f0ae`） |

> 兩個 binding 都要綁（R2 優先、KV 後備）：`functions/api/[[path]].js` 見 `env.UPLOADS` 就用 R2，否則用 `env.UPLOADS_KV`。
> ⚠️ 帳號內已有嘅 KV namespace `img_url` **唔可以碰** —— `deploy.sh` 只會用 title 完全相同嘅 `kingshot-uploads`，其他一律唔會讀寫或刪除（每次跑都會列印「其他現有 KV namespace（唔會碰）：…」）。

加完一樣要 **重新 deploy** 一次（Retry deployment）才會生效。

---

## 4. 確認 Git 連接同 build 設定

Dashboard → 專案 → **Settings** → **Build configuration**：

| 欄位 | 應該係 |
|------|--------|
| Git repository | `Wilsony2k/kingshot` |
| Production branch | `main`（或你實際用嘅 branch） |
| Framework preset | `None` |
| Build command | **留空**（呢個站冇 build step；空白會直接當成功） |
| **Build output directory** | `docs/events` |
| Root directory（advanced） | 留空 = repo 根目錄 |
| Functions directory | `functions`（repo 根目錄，Pages 預設值；dashboard 有顯示就用呢個名，**唔係** `docs/events/functions`） |

> 重點：`functions/` 一定要喺 **repo 根目錄**。如果你放喺 `docs/events/functions/`，Pages 唔會 compile，`/api/*` 會變成 404。

改完 push 一次（或 Retry deployment）令 functions 上線。

> **⚠️ 用 `deploy/deploy.sh` 部署時唔會直接上傳工作樹**（因為 `wrangler pages deploy` 係直接上傳目錄，會連未提交／未驗證嘅改動一齊推上線）。
> `deploy.sh` 會先砌一個 **staged 目錄 `.deploy-stage/`**：靜態檔一律用 `git HEAD` 版本（＋未 tracked 嘅新檔，例如 `upload.html`），`functions/` 用工作樹版本，
> 之後由 **repo root** 跑 `wrangler pages deploy .deploy-stage/site`（wrangler 係用 `path.join(process.cwd(), "functions")` 解 Functions 目錄，所以 cwd = repo root 就自動帶埋 `functions/`，唔需要 symlink；stage 內亦刻意唔放 `functions/`，避免源碼被當靜態檔公開）。想原樣部署工作樹就用 `--full-tree`（會有警告）。
> **API binding 形狀（真 API 實測，錯了會 HTTP 400）** —— PATCH `deployment_configs` 只收呢個形狀，`deploy.sh` 亦只會出呢個形狀：
> ```jsonc
> { "kv_namespaces": { "UPLOADS_KV": { "namespace_id": "3e94ca2a19b149c6801122d2b483f0ae" } },
>   "r2_buckets":    { "UPLOADS":    { "name": "kingshot-uploads" } },
>   "env_vars":      { "UPLOAD_TOKEN": { "type": "secret_text", "value": "<secret>" } } }
> ```
> ❌ 唔收：`{"id": …}`／`{"type":"kv_namespace","id":…}`／純字串（`Invalid KV namespace ID ()`）；`{"bucket_name": …}`／`{"type":"r2_bucket",…}`（`Invalid R2 bucket name ()`）。
> ⚠️ `wrangler` 內部 JS 用嘅 `type:"kv_namespace" + id` / `type:"r2_bucket" + bucket_name` 係 **wrangler.toml 路徑**嘅形狀，唔可以照抄落 Pages project API。

---

## 5. 部署後即時驗證（唔使等前端）

**⚠️ 實測現況（2026-09-29，未部署 functions 之前）：** `GET https://avgkingshot.85200852.xyz/api/list` 目前回
**HTTP 200 + `index.html` 嘅 HTML**（Pages 對未知路徑 fallback 去網站首頁，**唔會**回 404）。
所以判斷 functions 有冇生效，唔可以只睇 200 —— 要睇 body 係唔係 JSON：

```bash
BASE=https://avgkingshot.85200852.xyz
TOKEN=<YOUR_UPLOAD_TOKEN>          # 佔位符，自己代入；唔好貼入 repo

# 0) 一眼分辨 functions 有冇生效：body 係 HTML 就代表未 deploy
curl -sS "$BASE/api/list" | head -c 120
#   "<!DOCTYPE html>..."        → functions 未生效（未 push / 未 redeploy / 目錄位置唔對）
#   {"ok":false,"error":"..."}  → functions 已生效，繼續落面

# 1) 授權同 storage 狀態
curl -sS -i "$BASE/api/list?token=$TOKEN" | head -20
#   200 + {"ok":true,...}  → 好
#   401 unauthorized       → UPLOAD_TOKEN 未設／唔一致／未 redeploy
#   500 no_storage         → binding 未加／未 redeploy
#   404 not_found          → 路徑對但 route 唔對（例如打成 /api/lists）
#   HTML                   → functions 目錄位置唔對（要 repo 根目錄 functions/）

# 2) 上傳
printf 'hello' > /tmp/hero.jpg
curl -sS -H "x-upload-token: $TOKEN" -F "file=@/tmp/hero.jpg;type=image/jpeg" "$BASE/api/upload"

# 3) 取原始檔（要 token；query token 方便 curl）
curl -sS -D - "$BASE/api/raw?key=<上一步回傳嘅 key>&token=$TOKEN" | head -20
#   冇 token → 401（可以自己驗：curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/api/raw?key=<key>" 應該係 401）
#   檢查有 Cache-Control: no-store、X-Content-Type-Options: nosniff、
#   Content-Security-Policy: default-src 'none'; sandbox，而且冇 Access-Control-Allow-Origin

# 4) 刪除
curl -sS -X POST -H "x-upload-token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"key":"<key>"}' "$BASE/api/delete"
```

---

## 6. 本地測試（唔需要上網／唔需要 wrangler）

```bash
cd /home/wilsonc/DSH/Kingshot

# a) 語法檢查（Functions runtime 係 ESM，用 --check 就夠）
mkdir -p /tmp/kz && cp 'functions/api/[[path]].js' /tmp/kz/route.mjs && node --check /tmp/kz/route.mjs && echo OK

# b) 腳本語法
bash -n deploy/fetch-uploads.sh && echo OK

# c) 行為測試：mock R2／KV，直接跑真 onRequest，逐條對照 API contract（148 項）
node deploy/tests/api-contract.test.mjs
```

（可選，未驗證）想用真 wrangler 起本地 Pages：
`npx wrangler pages dev docs/events --binding UPLOAD_TOKEN=<TOKEN> --r2 UPLOADS --kv UPLOADS_KV`
—— 需要先 `npx wrangler login` 同網絡連線，本機環境未實測過，建議先用上面的 mock 測試。

---

## 7. Wilson 本機取上傳檔（deploy/fetch-uploads.sh）

先確認 token 檔：`deploy/.upload-token` **已經存在**（單行、64 位 hex，即 `openssl rand -hex 32` 格式）。
如果未有，或者要換新 token：

```bash
cd /home/wilsonc/DSH/Kingshot
printf '%s\n' '<YOUR_UPLOAD_TOKEN>' > deploy/.upload-token   # 佔位符，換成真值；唔好加引號／多餘空白
chmod 600 deploy/.upload-token
# .gitignore（root）同 deploy/.gitignore 都已經 ignore 咗呢個檔，唔會被 commit
```

> 呢個檔嘅值**必須同 Cloudflare 專案上嘅 `UPLOAD_TOKEN` 完全一致**，否則所有請求都會 401。
> 想換 token：兩邊（本機檔 + CF Secret）要一齊換，換完 CF 要 redeploy。

用法：

```bash
./deploy/fetch-uploads.sh --list                         # 列最近上傳（新到舊）
./deploy/fetch-uploads.sh --list --limit 20
./deploy/fetch-uploads.sh --download                     # 下載新檔到 uploads/（增量：用上次下載時間做 since）
./deploy/fetch-uploads.sh --download --since 2026-09-28T00:00:00Z
./deploy/fetch-uploads.sh --download --key 2026-09-29/1790661604-hero.jpg
./deploy/fetch-uploads.sh --download --delete --yes       # 分析完：下載成功嘅就刪遠端
./deploy/fetch-uploads.sh --delete --key <key> --yes      # 刪單一 key
./deploy/fetch-uploads.sh --help
```

- Token 讀取順序：`$UPLOAD_TOKEN` → `deploy/.upload-token`（可用 `$UPLOAD_TOKEN_FILE` 改路徑）
- Base URL：`$UPLOAD_BASE`（預設 `https://avgkingshot.85200852.xyz`）
- 下載目錄：`--out <dir>`（預設 `<repo>/uploads`，已建立；key 內含 epoch，唔會撞名）
- 任何 API 非 200 都會印錯誤並以非 0 結束；`--delete` 冇 `--yes` 時會要求喺終端機打 `yes` 確認（唔會讀 stdin，避免被 pipe 誤確認）
- `uploads/.fetch-state` 記錄上次「睇到最新嘅 uploadedAt」，做下次增量基準

---

## 8. API contract 快速對照

| Endpoint | 方法 | Auth | 成功 | 主要錯誤 |
|----------|------|------|------|----------|
| `/api/upload` | POST（multipart，欄位 `file`） | 要（header／`?token=`／form 欄位 `token`） | 200 `{"ok":true,"file":{...}}` | 400 `no_file`／401 `unauthorized`／413 `too_large`（`maxBytes:10485760`）／415 `unsupported_type`（`allowed:[...]`） |
| `/api/list` | GET（`limit`、`since`） | 要（見下方說明） | 200 `{"ok":true,"count":N,"files":[...]}` 新到舊 | 401 `unauthorized` |
| `/api/raw` | GET（`key`） | **要**（header 或 `?token=`） | 200 原始 bytes + 安全 headers | **401 `unauthorized`（未認證一律 401，唔會泄露 key 存唔存在）**／400 `bad_key`（只喺已認證後）／404 `not_found`（只喺已認證後） |
| `/api/delete` | POST（JSON `{"key":...}`） | 要 | 200 `{"ok":true,"deleted":"<key>"}` | 400 `bad_key`／401 `unauthorized`／404 `not_found` |

其他：未知路徑 → 404 `not_found`；方法唔對 → 405 `method_not_allowed` + `Allow` header；所有 JSON response 都帶 `Cache-Control: no-store`；storage 兩個 binding 都缺 → 500 `no_storage`。

**⚠️ 一處 contract 未明確、實作上取保守做法：** `/api/list` 目前**要求 token**（`functions/api/[[path]].js` 內 `REQUIRE_AUTH_ON_LIST = true`）。理由：清單會暴露所有上傳檔案名／大小，公開唔安全；而 `fetch-uploads.sh` 本身一定會帶 token。若果要公開只讀清單，改 `REQUIRE_AUTH_ON_LIST = false` 就得。

---

## 9. 疑難排解

| 症狀 | 原因 | 處理 |
|------|------|------|
| `/api/*` 回 **200 但 body 係 HTML**（實測未部署時就係咁） | functions 未生效：未 push、未 redeploy、或 `functions/` 唔喺 repo 根目錄 | 確認 `functions/api/[[path]].js` 存在並已 push → Retry deployment |
| `/api/*` 回 404 `not_found` | 路徑打錯（正確係 `/api/upload`、`/api/list`、`/api/raw`、`/api/delete`） | 對照第 8 節表格 |
| 401 `unauthorized`（token 明明正確） | `UPLOAD_TOKEN` 未設／設咗喺 Preview 但用 Production 網址／改完冇 redeploy | 重設變數（Secret）→ Retry deployment |
| 前端 `<img src="/api/raw?key=...">` 顯示唔到圖 | `/api/raw` 要 token，唔可以用裸連結 | 改用 `fetch` + `x-upload-token` header，再 `URL.createObjectURL(blob)` |
| 500 `no_storage` | R2／KV binding 未加或變數名唔係 `UPLOADS`／`UPLOADS_KV` | 加 binding → Retry deployment |
| 413 `too_large` | 超過 10 MiB | 壓縮圖片，或改 `functions/api/[[path]].js` 內 `MAX_BYTES`（同時要留意 KV 25 MiB 值上限） |
| 415 `unsupported_type` | 副檔名唔喺白名單 | 白名單：`html,htm,jpg,jpeg,png,webp,gif,svg,css,js,json,txt,md` |
| 靜態網站改極都唔更新 | Build output directory 唔係 `docs/events` | 見第 4 節 |
| 上傳嘅 HTML 喺站內「執行」 | 唔應該發生：`/api/raw` 已經加 `Content-Security-Policy: default-src 'none'; sandbox` + `nosniff` + `attachment` | 唔好移除呢啲 headers |

## 10. 安全須知

- `UPLOAD_TOKEN` 只可以喺 Cloudflare 環境變數（Secret）同本機 `deploy/.upload-token` 出現，**唔可以**入 git、唔可以寫入任何前端檔案。
- 本檔所有 token 位置都係佔位符（`<YOUR_UPLOAD_TOKEN>`、`<REPLACE_WITH_64_HEX_CHARS>`），唔好改成真值。
- token 比對係 timing-safe（SHA-256 digest + 固定時間 XOR），而且 token 永遠唔會出現喺 response 或 log。
- `/api/raw` **需要 token**（唔係公開連結）。前端唔好用 `<img src>`／裸連結：key 內含 epoch-ms 可被枚舉，而且上傳 HTML 係同源內容有 XSS 風險 → 用 `fetch` 帶 token + `blob:` URL 顯示。
- `key` 唔應該當成秘密憑證；敏感內容唔應該上傳（token 洩漏 = 全部檔案可讀）。
- R2 binding 路徑下，object 嘅 `name` metadata 係以 `encodeURIComponent` 存放（因為 R2 `customMetadata` 只接受 ASCII，中文檔名唔 encode 會令上傳失敗）。API 回傳嘅 `name` 會自動 decode 返，但如果有人直接睇 bucket／其他工具讀 metadata，會見到 URL-encoded 值。
- 冇 magic bytes 檢查（只靠副檔名白名單）：理論上可以上傳「內容同副檔名唔符」嘅檔。因為 `/api/raw` 有 `nosniff` + `Content-Security-Policy: default-src 'none'; sandbox` + `Content-Disposition: attachment`，風險可接受；要更嚴就要加檔案簽章檢查。
