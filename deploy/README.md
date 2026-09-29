# Kingshot 部署工具

**1. Token 權限** — 需要一個 Cloudflare API token：`Account → Cloudflare Pages: Edit` + `Account → Workers KV Storage: Edit`（如用 R2 就再加 `Account → Workers R2 Storage: Edit`）；放喺 `deploy/.cf-token`（單行）或 `export CLOUDFLARE_API_TOKEN=...`。

**2. `deploy/.upload-token`** — 上傳 API 嘅 `UPLOAD_TOKEN`（單行 64 位 hex），由 `deploy.sh` 讀取並寫入 Pages 專案嘅 secret（production + preview），同時供 `deploy/fetch-uploads.sh` 下載／刪除檔案用；兩個檔都已喺 `.gitignore`，**唔可以經 git 或前端外泄**。

**3. 用法** — `bash deploy/deploy.sh`（完整流程：檢查 → 建 KV namespace → 加 KV/R2 binding → 設 secret → **staged 部署** → 線上驗證 upload/list/raw/delete）；`--dry-run` 只做**唯讀**檢查同報告（唔會建立、唔會 PATCH、唔會部署，想照做 a–g 變更就加 `CF_DRY_RUN_APPLY=1`），`--verify-only` 只跑線上驗證，`--no-verify` 部署但唔跑完整驗證（`/api/list` 必須 401 嘅部署完整性檢查照跑）。

**Bindings（預設兩個都綁）** — `UPLOADS` → R2 bucket `kingshot-uploads`、`UPLOADS_KV` → KV namespace `kingshot-uploads`（id 由 API 查 title 取得），production + preview 都設；KV／R2 都係 idempotent（已存在就重用，唔會報錯），帳號內其他 namespace（例如 `img_url`）唔會被碰。每次跑完會印最終 binding 清單（只列 name／bucket／namespace id，永不列 secret 值）。

**部署內容（重要）** — 預設 **staged**：靜態檔用 `git HEAD` 版本（＋未 tracked 新檔，例如 `upload.html`），`functions/` 用工作樹版本，放喺 `.deploy-stage/site`，再由 **repo root** 跑 `wrangler pages deploy .deploy-stage/site`（wrangler 用 `path.join(process.cwd(), "functions")` 解 Functions 目錄 → `functions/` 自動跟埋上，唔需要 copy／symlink），所以**未提交／未驗證嘅改動（例如 `docs/events/server-2355-calendar.*` 嘅工作樹版本）唔會上線**；要原樣部署工作樹就用 `--full-tree`。部署後會硬檢查 `${SITE_BASE}/api/list` 必須回 **401**（若回 200 + HTML 首頁即代表 functions 冇上到 → fail）。Pages 專案名 = `kingshot-2355-calendar`（Direct Upload）。

---

## 常用環境變數（全部可選）

| 變數 | 用途 |
|------|------|
| `CLOUDFLARE_API_TOKEN` | CF API token（優先於 `deploy/.cf-token`） |
| `UPLOAD_TOKEN` | 上傳 API token（優先於 `deploy/.upload-token`） |
| `CF_ACCOUNT_ID` | 直接指定 account（token 睇到多過一個 account 時必填） |
| `CF_PAGES_PROJECT` | 直接指定 Pages 專案（唔想靠網域比對時用） |
| `CF_KV_TITLE` | KV namespace 標題（預設 `kingshot-uploads`；已存在就重用，唔存在才建立；**其他 namespace 一律唔碰**） |
| `CF_R2_BUCKET` | R2 bucket 名（**預設 `kingshot-uploads`**，已存在就重用；設成**空值** `CF_R2_BUCKET=` 就只綁 KV） |
| `SITE_BASE` | 線上驗證目標（預設 `https://avgkingshot.85200852.xyz`） |

## 測試

```bash
bash -n deploy/deploy.sh
node deploy/tests/deploy-flow.test.mjs        # mock CF API + mock Pages site（唔需要真 token）
node deploy/tests/api-contract.test.mjs       # 上傳 API contract（148 項）
KZ_ONLY=1,2,3 node deploy/tests/deploy-flow.test.mjs   # 只跑指定 section
```

其他檔案：`upload-setup.md`（Cloudflare dashboard 手動設定步驟）、`fetch-uploads.sh`（本機取上傳檔）。
