#!/usr/bin/env bash
#
# Kingshot — Cloudflare Pages 一鍵部署 + 線上驗證（可重複執行，idempotent）
#
# 用法：
#   bash deploy/deploy.sh                 # 完整流程：檢查 → 設 binding/secret → 部署 → 線上驗證
#   bash deploy/deploy.sh --dry-run       # 只做唯讀檢查 + 報告（唔會建立 KV／唔會 PATCH／唔會部署）
#   bash deploy/deploy.sh --verify-only   # 只跑線上驗證（唔碰 CF 設定、唔部署）
#   bash deploy/deploy.sh --no-verify     # 部署但跳過線上驗證
#   bash deploy/deploy.sh --full-tree     # 直接部署工作樹 docs/events（含未提交改動；預設係 staged）
#
# 部署內容（預設 = staged）：
#   靜態檔一律用 git HEAD 版本（+ 未 tracked 嘅新檔），functions/ 用工作樹版本，
#   放喺 .deploy-stage/site/，再由 repo root 跑 wrangler（functions 由 cwd/functions 攞）—— 咁就唔會把
#   未提交／未驗證嘅不相關改動（例如 docs/events/*.html|js 嘅工作樹版本）推上線。
#   部署後會硬檢查 GET /api/list 一定要回 401（200 + HTML 首頁 = functions 冇上到）。
#
# Token：
#   CF API token：$CLOUDFLARE_API_TOKEN → 否則 deploy/.cf-token（單行）
#   UPLOAD token：$UPLOAD_TOKEN         → 否則 deploy/.upload-token（單行）
#   ⚠️ 本腳本任何情況都唔會 echo／log 呢兩個 token（curl 亦用 stdin config 傳 header，
#      唔會出現喺 process args）。
#
# 需要嘅 token 權限：Account → Cloudflare Pages:Edit、Workers KV Storage:Edit
#                  （用 R2 就加 Workers R2 Storage:Edit）
#
# 測試用覆寫（正常唔需要）：
#   CF_API_BASE   預設 https://api.cloudflare.com/client/v4（可指向 mock server）
#   SITE_BASE     預設 https://avgkingshot.85200852.xyz（線上驗證目標）
#   CF_DRY_RUN_APPLY=1  連 --dry-run 都照做 a–g 嘅變更（但一樣唔部署）；預設 0 = 全唯讀
#
set -euo pipefail

# ---------- 路徑／常數 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

API_BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
API_BASE="${API_BASE%/}"
SITE_BASE="${SITE_BASE:-https://avgkingshot.85200852.xyz}"
SITE_BASE="${SITE_BASE%/}"
PAGES_DOMAIN="${CF_PAGES_DOMAIN:-avgkingshot.85200852.xyz}"
KV_TITLE="${CF_KV_TITLE:-kingshot-uploads}"
# 預設兩個 binding 都綁：R2 bucket 名預設 kingshot-uploads（Evelyn 已建立）。
# 想只綁 KV（唔綁 R2）就設 CF_R2_BUCKET= 空值；想用其他 bucket 就設 CF_R2_BUCKET=<bucket 名>。
R2_BUCKET="${CF_R2_BUCKET-kingshot-uploads}"
PAGES_DIR="${CF_PAGES_DIR:-docs/events}"          # Pages build output = 靜態站根目錄
PROD_BRANCH="${CF_PAGES_BRANCH:-main}"
CF_TOKEN_FILE="${CF_TOKEN_FILE:-${SCRIPT_DIR}/.cf-token}"          # 可用 $CF_TOKEN_FILE 覆蓋（測試用）
UPLOAD_TOKEN_FILE="${UPLOAD_TOKEN_FILE:-${SCRIPT_DIR}/.upload-token}"

DRY_RUN=0
VERIFY_ONLY=0
DO_VERIFY=1
DRY_RUN_APPLY="${CF_DRY_RUN_APPLY:-0}"
FULL_TREE="${CF_FULL_TREE:-0}"                       # 1 = 直接部署工作樹（預設 0 = staged）
GIT_OK=0

# staged 部署：靜態檔一律用 HEAD 版本，避免將未提交／未驗證嘅改動推上線
STAGE_ROOT="${CF_STAGE_DIR:-${REPO_ROOT}/.deploy-stage}"
STAGE_SITE_NAME="site"
# wrangler 係用 path.join(process.cwd(), "functions") 解 Functions 目錄（唔係用部署目錄！），
# 所以部署時 cwd 一定要係 repo root，functions/ 就會自動跟埋上，唔需要 copy 或 symlink。
STAGE_DEPLOY_DIR_REL=".deploy-stage/${STAGE_SITE_NAME}"

# ⚠️ 一定要先記住 caller 經環境變數傳入嘅 UPLOAD_TOKEN：下面為咗 set -u 安全會初始化同名全域變數，
# 如果唔記低，`UPLOAD_TOKEN=""` 就會清空環境變數，變成靜靜改用 deploy/.upload-token（實測踩過呢個坑）。
ENV_UPLOAD_TOKEN="${UPLOAD_TOKEN:-}"

CF_TOKEN=""
CF_TOKEN_SRC=""
UPLOAD_TOKEN=""
ACC=""
PROJ=""
PROJECT_JSON=""
KV_ID=""
KV_STATE=""
R2_STATE=""
CF_STATUS=""
CF_BODY=""
TMP_DIR=""

# npx / wrangler 一定要自己帶呢四個路徑（唔可以靠 caller）：
# sandbox 內預設 ~/.npm 係唯讀（rofs）→ 唔指去 workspace 就即刻爆 EROFS。三個目錄都已 gitignore。
mkdir -p "${REPO_ROOT}/.npm-cache" "${REPO_ROOT}/.config-home" "${REPO_ROOT}/.wrangler-logs"
WR_ENV=(
  "npm_config_cache=${REPO_ROOT}/.npm-cache"
  "XDG_CONFIG_HOME=${REPO_ROOT}/.config-home"
  "WRANGLER_LOG_PATH=${REPO_ROOT}/.wrangler-logs"
  "npm_config_update_notifier=false"
)

# ---------- 基本工具 ----------
die() { echo "❌ $*" >&2; exit 1; }

# 所有 git 呼叫都帶 -c safe.directory（唔想改用戶 global git config；亦令 agent/sandbox 環境照樣行得通）
GIT=(git -c "safe.directory=${REPO_ROOT}" -C "${REPO_ROOT}")
info() { echo "▶ $*"; }
ok() { echo "✅ $*"; }
warn() { echo "⚠️  $*" >&2; }

# PATCH 係「整份 deployment_configs 換」，所以唯讀 dry-run 都要標示清楚
MUTATE=1
is_mutate() { [ "$MUTATE" -eq 1 ]; }

tmp_dir() {
  # 喺 main 叫一次就夠；之後全部用 "$TMP_DIR/..."。
  # （唔可以用 $(tmp_dir)：command substitution 會喺 subshell 行，TMP_DIR 同 trap 都會失效。）
  if [ -z "$TMP_DIR" ]; then
    TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kingshot-deploy.XXXXXX")"
    trap 'rm -rf "$TMP_DIR"' EXIT
  fi
}

sha256_file() { python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

usage() {
  # 印檔頭註解（由「用法」到 set -euo pipefail 之前），唔會因為檔案變長而走位
  sed -n '3,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --verify-only) VERIFY_ONLY=1 ;;
      --no-verify) DO_VERIFY=0 ;;
      --full-tree) FULL_TREE=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "唔認識嘅參數：$1（試 --help）" ;;
    esac
    shift
  done
  if [ "$DRY_RUN" -eq 1 ] && [ "$VERIFY_ONLY" -eq 1 ]; then
    die "--dry-run 同 --verify-only 唔可以一齊用"
  fi
  # 只有「dry-run 且冇要求照做」時才全唯讀
  if [ "$DRY_RUN" -eq 1 ] && [ "$DRY_RUN_APPLY" != "1" ]; then
    MUTATE=0
  fi
}

check_deps() {
  command -v curl >/dev/null 2>&1 || die "需要 curl"
  if command -v git >/dev/null 2>&1 && "${GIT[@]}" rev-parse --git-dir >/dev/null 2>&1; then
    GIT_OK=1
  else
    GIT_OK=0
    if [ "$FULL_TREE" -ne 1 ]; then
      warn "呢個目錄唔係 git repo（或者冇 git）→ staged 部署做唔到，會用 --full-tree 行為"
      warn "（即係直接部署工作樹，未提交改動都會上線）"
      FULL_TREE=1
    fi
  fi
  command -v python3 >/dev/null 2>&1 || die "需要 python3（解析 CF API JSON）"
  if [ "$VERIFY_ONLY" -eq 0 ]; then
    command -v npx >/dev/null 2>&1 || die "需要 npx（部署用 wrangler）"
    [ -d "${REPO_ROOT}/${PAGES_DIR}" ] || die "搵唔到部署目錄 ${REPO_ROOT}/${PAGES_DIR}"
    if [ ! -f "${REPO_ROOT}/${PAGES_DIR}/upload.html" ]; then
      warn "${PAGES_DIR}/upload.html 唔存在 — 線上驗證步驟會期望佢回 200，請確認前端頁面已入 repo"
    fi
  fi
}

# ---------- token 讀取（永不回顯） ----------
read_secret_file() {  # $1=路徑 → 單行內容（去頭尾空白）
  head -n 1 "$1" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

load_cf_token() {
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    CF_TOKEN="$CLOUDFLARE_API_TOKEN"
    CF_TOKEN_SRC="環境變數 \$CLOUDFLARE_API_TOKEN"
  elif [ -f "$CF_TOKEN_FILE" ]; then
    CF_TOKEN="$(read_secret_file "$CF_TOKEN_FILE")"
    CF_TOKEN_SRC="$CF_TOKEN_FILE"
  else
    cat >&2 <<EOF
❌ 搵唔到 Cloudflare API token。請二選一：
   1) export CLOUDFLARE_API_TOKEN=<你的 token>
   2) printf '%s\n' '<你的 token>' > ${CF_TOKEN_FILE}   # 單行；已喺 .gitignore
   權限需要：Account → Cloudflare Pages:Edit、Workers KV Storage:Edit（用 R2 就加 Workers R2 Storage:Edit）
EOF
    exit 1
  fi
  [ -n "$CF_TOKEN" ] || die "${CF_TOKEN_SRC} 存在但內容係空"
  case "$CF_TOKEN" in
    *[[:space:]]*) die "CF token 唔應該有空白／換行，請檢查 ${CF_TOKEN_SRC}" ;;
  esac
  echo "▶ CF API token 來源：${CF_TOKEN_SRC}（長度 ${#CF_TOKEN}，內容唔會顯示）"
}

load_upload_token() {
  if [ -n "$ENV_UPLOAD_TOKEN" ]; then
    UPLOAD_TOKEN="$ENV_UPLOAD_TOKEN"
  elif [ -f "$UPLOAD_TOKEN_FILE" ]; then
    UPLOAD_TOKEN="$(read_secret_file "$UPLOAD_TOKEN_FILE")"
  elif [ "$VERIFY_ONLY" -eq 0 ]; then
    # 部署流程：未有任何 upload token 就自動生成一個（openssl 或 python3 都得）
    local dir="${UPLOAD_TOKEN_FILE%/*}"
    [ -d "$dir" ] || mkdir -p "$dir"
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 32 > "$UPLOAD_TOKEN_FILE"
    else
      python3 -c 'import secrets;print(secrets.token_hex(32))' > "$UPLOAD_TOKEN_FILE"
    fi
    chmod 600 "$UPLOAD_TOKEN_FILE"
    UPLOAD_TOKEN="$(read_secret_file "$UPLOAD_TOKEN_FILE")"
    ok "已生成新嘅 upload token → ${UPLOAD_TOKEN_FILE}（內容唔會顯示）"
  else
    die "搵唔到 upload token：請設定 \$UPLOAD_TOKEN 或建立 ${UPLOAD_TOKEN_FILE}（單行）"
  fi
  [ -n "$UPLOAD_TOKEN" ] || die "upload token 係空"
}

# ---------- CF API ----------
cf_api() {  # $1=method $2=path [curl 額外參數...] → CF_STATUS / CF_BODY
  local method="$1" path="$2"
  shift 2
  local raw
  if ! raw="$(curl -sS -X "$method" \
      -H "Authorization: Bearer ${CF_TOKEN}" \
      -H 'Content-Type: application/json' \
      -w $'\n%{http_code}' "$@" "${API_BASE}${path}" 2>&1)"; then
    die "連唔到 Cloudflare API：${method} ${path}"
  fi
  CF_STATUS="${raw##*$'\n'}"
  CF_BODY="${raw%$'\n'*}"
}

print_cf_errors() {
  printf '%s' "$1" | python3 -c '
import json,sys
raw=sys.stdin.read()
try:
    d=json.loads(raw)
except Exception:
    print("  回應（非 JSON，前 500 字）："+raw[:500]); sys.exit()
for e in d.get("errors") or []:
    print("  CF error %s: %s" % (e.get("code"), e.get("message")))
for m in (d.get("messages") or [])[:3]:
    print("  CF message: %s" % m.get("message"))
if not (d.get("errors") or d.get("messages")):
    print("  回應："+raw[:500])
'
}

cf_expect_ok() {  # $1=步驟描述；失敗 → 印錯誤 + exit 1
  local desc="$1" success
  if [ "$CF_STATUS" != "200" ]; then
    echo "❌ ${desc} 失敗：HTTP ${CF_STATUS}" >&2
    print_cf_errors "$CF_BODY" >&2
    exit 1
  fi
  success="$(printf '%s' "$CF_BODY" | python3 -c 'import json,sys;print(bool(json.load(sys.stdin).get("success")))')"
  if [ "$success" != "True" ]; then
    echo "❌ ${desc} 失敗：success != true" >&2
    print_cf_errors "$CF_BODY" >&2
    exit 1
  fi
}

# 通用分頁拉取（真 API 行為：GET /pages/projects 嘅 per_page 上限係 10，
# 用 20/100 會回 HTTP 400 + error 8000024「Invalid list options」）。
# $1=路徑（唔含 page/per_page） $2=per_page $3=描述；完成後 CF_BODY = {"success":true,"result":[...合併...]}
cf_get_paged() {
  local path="$1" desc="$2" page=1 total=1 merged='[]' q=""
  while [ "$page" -le "$total" ] && [ "$page" -le 25 ]; do
    # 第 1 頁刻意唔帶任何 query（實測 CF 對 GET /pages/projects 嘅 per_page 好敏感：
    # per_page>10 會回 HTTP 400 + error 8000024；唔帶 query 一定成功）。
    # 只有真係需要翻頁（total_pages>1）才加 ?page=N。
    [ "$page" -eq 1 ] && q="" || q="?page=${page}"
    cf_api GET "${path}${q}"
    cf_expect_ok "${desc}（第 ${page} 頁）"
    total="$(printf '%s' "$CF_BODY" | python3 -c 'import json,sys;print(int((json.load(sys.stdin).get("result_info") or {}).get("total_pages") or 1))')"
    merged="$(printf '%s' "$CF_BODY" | CF_MERGED="$merged" python3 -c '
import json,sys,os
acc=json.loads(os.environ["CF_MERGED"])
cur=json.load(sys.stdin).get("result") or []
print(json.dumps({"success": True, "result": acc + (cur if isinstance(cur, list) else [])}))')"
    page=$((page + 1))
  done
  CF_BODY="$merged"
}

# ---------- b. account id ----------
resolve_account() {
  if [ -n "${CF_ACCOUNT_ID:-}" ]; then
    ACC="$CF_ACCOUNT_ID"
    echo "▶ Account ID：${ACC}（來自 \$CF_ACCOUNT_ID）"
    return 0
  fi
  info "解析 account id：GET /accounts"
  cf_api GET "/accounts?per_page=50"
  cf_expect_ok "列出 accounts"
  local n
  n="$(printf '%s' "$CF_BODY" | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("result") or []))')"
  case "$n" in
    0) die "呢個 token 睇唔到任何 account（權限不足？）" ;;
    1) ACC="$(printf '%s' "$CF_BODY" | python3 -c 'import json,sys;print((json.load(sys.stdin).get("result") or [{}])[0].get("id",""))')" ;;
    *)
      echo "❌ token 可以存取多過一個 account，請用 \$CF_ACCOUNT_ID 指定其中一個：" >&2
      printf '%s' "$CF_BODY" | python3 -c '
import json,sys
for a in json.load(sys.stdin).get("result") or []:
    print("   %s  %s" % (a.get("id",""), a.get("name","")))' >&2
      exit 1 ;;
  esac
  [ -n "$ACC" ] || die "解唔到 account id"
  echo "▶ Account ID：${ACC}"
}

# ---------- c. 專案 ----------
resolve_project() {
  info "解析 Pages 專案（目標網域：${PAGES_DOMAIN}）"
  project_selector() {  # stdin=專案 JSON → 唯一命中嘅名，或者空（同時把候選印去 stderr）
    PAGES_DOMAIN="$PAGES_DOMAIN" python3 -c '
import json,sys,os
target=os.environ["PAGES_DOMAIN"]
hits=[]
for p in json.load(sys.stdin).get("result") or []:
    doms=set(p.get("domains") or [])
    if p.get("subdomain"): doms.add(p["subdomain"])
    if target in doms: hits.append(p)
if len(hits)==1:
    print(hits[0].get("name",""))
else:
    sys.stderr.write("候選（%d 個）:\n" % len(hits))
    for p in hits:
        sys.stderr.write("   %s  domains=%s\n" % (p.get("name",""), ", ".join(p.get("domains") or []) or "-"))
'
  }
  if [ -n "${CF_PAGES_PROJECT:-}" ]; then
    PROJ="$CF_PAGES_PROJECT"
    echo "▶ 專案名：${PROJ}（來自 \$CF_PAGES_PROJECT）"
  else
    cf_get_paged "/accounts/${ACC}/pages/projects" "列出 Pages 專案"
    local candidates
    candidates="$(printf '%s' "$CF_BODY" | project_selector 2>&1 >/dev/null || true)"
    PROJ="$(printf '%s' "$CF_BODY" | project_selector 2>/dev/null || true)"
    if [ -z "$PROJ" ]; then
      echo "❌ 喺呢個 account 搵唔到（或者多過一個）domains 含 ${PAGES_DOMAIN} 嘅 Pages 專案：" >&2
      [ -n "$candidates" ] && printf '%s\n' "$candidates" >&2
      echo "   請用 \$CF_PAGES_PROJECT=<專案名> 指定。" >&2
      exit 1
    fi
    echo "▶ 專案名：${PROJ}（由網域 ${PAGES_DOMAIN} 比對出嚟）"
  fi

  info "讀取專案詳情：GET /accounts/${ACC}/pages/projects/${PROJ}"
  cf_api GET "/accounts/${ACC}/pages/projects/${PROJ}"
  if [ "$CF_STATUS" != "200" ]; then
    echo "❌ 讀唔到專案 ${PROJ}：HTTP ${CF_STATUS}" >&2
    print_cf_errors "$CF_BODY" >&2
    echo "   提示：專案名可能唔對；用 \$CF_PAGES_PROJECT 指定，或檢查 token 有冇 Pages:Edit 權限" >&2
    exit 1
  fi
  PROJECT_JSON="$CF_BODY"
  PROJ="$(printf '%s' "$PROJECT_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("result",{}).get("name",""))')"
  [ -n "$PROJ" ] || die "解唔到專案名"
}

# ---------- d. 報告 source + bindings/vars 名（唔印值） ----------
report_project() {
  echo
  echo "──────── 專案現況 ────────"
  printf '%s' "$PROJECT_JSON" | python3 -c '
import json,sys
p=json.load(sys.stdin).get("result",{})
src=(p.get("source") or {})
t=src.get("type")
# 實測：真正 Direct Upload 專案嘅 API 回應係冇 source 欄位（唔係 source.type=direct_upload）
if not t:
    t="（冇 source 欄位）"
    label="Direct Upload（API 冇 source 欄位 → 唔係 Git 連接）"
else:
    label={"direct_upload":"Direct Upload（wrangler 直接上傳）",
           "github":"Git-connected（GitHub 自動 build）",
           "gitlab":"Git-connected（GitLab 自動 build）"}.get(t, t)
print("  專案名      : %s" % p.get("name",""))
print("  來源        : %s  [source.type=%s]" % (label, t))
if src.get("config"):
    c=src["config"]
    print("  Git 設定    : repo=%s branch=%s build_cmd=%s output=%s" % (
        c.get("owner","?")+"/"+c.get("repo_name","?"), c.get("production_branch","?"),
        repr(c.get("build_command","")), repr(c.get("destination_dir",""))))
print("  自訂網域    : %s" % (", ".join(p.get("domains") or []) or "（冇）"))
print("  子網域      : %s" % (p.get("subdomain","（冇）")))
print("  最近部署    : %s" % ((p.get("latest_deployment") or {}).get("created_on","（冇）")))
BIND_KEYS=("kv_namespaces","r2_buckets","d1_databases","durable_object_namespaces",
           "hyperdrive","services","queues","vectorize","analytics_engine_datasets",
           "ai","browser","images")
def binding_names(v):
    # 真 API 回嘅係 dict（key = binding 名，value = 設定）；舊／其他工具可能用 list
    if isinstance(v, dict):  return list(v.keys())
    if isinstance(v, list):  return [(b.get("name") if isinstance(b,dict) else str(b)) for b in v]
    return []
dc=p.get("deployment_configs") or {}
for env in ("production","preview"):
    cfg=dc.get(env) or {}
    lines=[]
    for k in BIND_KEYS:
        for name in binding_names(cfg.get(k)):
            lines.append("%-26s → %s" % (k, name))
    for k in sorted((cfg.get("vars") or {}).keys()):
        lines.append("%-26s → %s" % ("vars", k))
    for k,v in sorted((cfg.get("env_vars") or {}).items()):
        lines.append("%-26s → %s (type=%s)" % ("env_vars", k, (v or {}).get("type")))
    print("  [%s] %d 個條目（只列名，唔列值）：" % (env, len(lines)))
    for l in lines: print("      "+l)
    if not lines: print("      （冇）")
'
  echo "──────────────────────────"
}

# ---------- e. KV namespace ----------
resolve_kv() {
  info "查 KV namespace：title=${KV_TITLE}"
  cf_get_paged "/accounts/${ACC}/storage/kv/namespaces" "列出 KV namespaces"
  KV_ID="$(printf '%s' "$CF_BODY" | KV_TITLE="$KV_TITLE" python3 -c '
import json,sys,os
t=os.environ["KV_TITLE"]
for n in json.load(sys.stdin).get("result") or []:
    if n.get("title")==t: print(n.get("id","")); break
')"
  # 透明化：列出其他現有 namespace（我哋只會用 title 完全相同嗰個，其他一律唔碰）
  local others
  others="$(printf '%s' "$CF_BODY" | KV_TITLE="$KV_TITLE" python3 -c '
import json,sys,os
t=os.environ["KV_TITLE"]
names=[n.get("title","?") for n in (json.load(sys.stdin).get("result") or []) if n.get("title")!=t]
print(", ".join(names) if names else "（冇）")')"
  echo "ℹ️  其他現有 KV namespace（唔會碰）：${others}"

  if [ -n "$KV_ID" ]; then
    KV_STATE="reused"
    ok "KV namespace 已存在，重用：${KV_TITLE} → ${KV_ID}"
    return 0
  fi
  if ! is_mutate; then
    KV_STATE="would_create"
    KV_ID="（dry-run：未建立）"
    echo "（dry-run）會建立 KV namespace：title=${KV_TITLE}"
    return 0
  fi
  info "建立 KV namespace：POST /accounts/${ACC}/storage/kv/namespaces"
  cf_api POST "/accounts/${ACC}/storage/kv/namespaces" \
    --data "$(KV_TITLE="$KV_TITLE" python3 -c 'import json,os;print(json.dumps({"title":os.environ["KV_TITLE"]}))')"
  cf_expect_ok "建立 KV namespace"
  KV_ID="$(printf '%s' "$CF_BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("result",{}).get("id",""))')"
  [ -n "$KV_ID" ] || die "建立 KV namespace 成功但攞唔到 id"
  KV_STATE="created"
  ok "已建立 KV namespace：${KV_TITLE} → ${KV_ID}"
}

# ---------- f/g. 合併 deployment_configs（保留原有 bindings/vars） ----------
# ---------- e2. R2 bucket（idempotent：已存在就重用，冇才建立） ----------
resolve_r2() {
  R2_STATE="skipped"
  if [ -z "$R2_BUCKET" ]; then
    echo "▶ R2：\$CF_R2_BUCKET 為空 → 只綁 KV（UPLOADS_KV）"
    return 0
  fi
  info "查 R2 bucket：${R2_BUCKET}"
  cf_api GET "/accounts/${ACC}/r2/buckets/${R2_BUCKET}"
  if [ "$CF_STATUS" = "200" ]; then
    R2_STATE="reused"
    ok "R2 bucket 已存在，重用：${R2_BUCKET}"
    return 0
  fi
  if [ "$CF_STATUS" != "404" ]; then
    echo "❌ 查 R2 bucket 失敗：HTTP ${CF_STATUS}" >&2
    print_cf_errors "$CF_BODY" >&2
    echo "   提示：token 需要 Account → Workers R2 Storage:Edit；或者用 CF_R2_BUCKET= 明確只綁 KV" >&2
    exit 1
  fi
  if ! is_mutate; then
    R2_STATE="would_create"
    echo "（dry-run）會建立 R2 bucket：${R2_BUCKET}"
    return 0
  fi
  info "建立 R2 bucket：POST /accounts/${ACC}/r2/buckets"
  cf_api POST "/accounts/${ACC}/r2/buckets" \
    --data "$(R2_NAME="$R2_BUCKET" python3 -c 'import json,os;print(json.dumps({"name":os.environ["R2_NAME"]}))')"
  cf_expect_ok "建立 R2 bucket"
  R2_STATE="created"
  ok "已建立 R2 bucket：${R2_BUCKET}"
}

# 最終 binding 清單（只列 name／bucket／namespace id 同 secret 嘅 type，永不列 secret 值）
print_bindings_report() {   # stdin = 專案 JSON 或 {"deployment_configs":…}
  python3 -c '
import json,sys
d=json.load(sys.stdin)
p=d.get("result") if isinstance(d.get("result"),dict) else d
dc=p.get("deployment_configs") or {}
def names(v, key):
    if isinstance(v,dict):
        for name,cfg in v.items():
            yield name, (cfg or {}).get(key) if isinstance(cfg,dict) else cfg
    elif isinstance(v,list):
        for b in v:
            if isinstance(b,dict): yield b.get("name"), b.get(key)
for env in ("production","preview"):
    cfg=dc.get(env) or {}
    print("  [%s]" % env)
    n=0
    for name,val in names(cfg.get("kv_namespaces"),"namespace_id"):
        print("      kv_namespaces → %s = namespace_id %s" % (name,val)); n+=1
    for name,val in names(cfg.get("r2_buckets"),"bucket_name"):
        if val is None:
            v=(cfg.get("r2_buckets") or {}) if isinstance(cfg.get("r2_buckets"),dict) else {}
            val=(v.get(name) or {}).get("name") if isinstance(v.get(name),dict) else None
        print("      r2_buckets    → %s = bucket %s" % (name,val)); n+=1
    for k,v in sorted((cfg.get("env_vars") or {}).items()):
        print("      env_vars      → %s (type=%s，值唔會顯示)" % (k, (v or {}).get("type") if isinstance(v,dict) else "?")); n+=1
    for k in sorted((cfg.get("vars") or {}).keys()):
        print("      vars          → %s" % k); n+=1
    if n==0: print("      （冇）")
'
}

build_project_patch() {  # $1=bindings|secret ; stdin=專案 JSON ; env: PATCH_KV_ID / PATCH_R2 / PATCH_TOKEN
  PATCH_MODE="$1" python3 -c '
import json,sys,os
_d=json.load(sys.stdin)
p=_d.get("result") if isinstance(_d.get("result"),dict) else _d   # 接受 {result:…} 或 {deployment_configs:…}
mode=os.environ["PATCH_MODE"]
kv_id=os.environ.get("PATCH_KV_ID","")
r2=os.environ.get("PATCH_R2","")
token=os.environ.get("PATCH_TOKEN","")
dc=p.get("deployment_configs") or {}
out={}
for env in ("production","preview"):
    cfg=dict(dc.get(env) or {})          # 先複製原有 config（保留 compatibility_date 等）
    if mode=="bindings":
        # 真 CF Pages project API（PATCH deployment_configs）實測只收呢個形狀：
        #   kv_namespaces = {"<binding 名>": {"namespace_id": "<hex>"}}
        #   r2_buckets    = {"<binding 名>": {"name": "<bucket 名>"}}
        # 其他寫法（{"id":…}／{"type":"kv_namespace","id":…}／純字串／r2 用 "bucket_name"）會被回
        # HTTP 400（"Invalid KV namespace ID ()"／"Invalid R2 bucket name ()"）—— wrangler 內部
        # 用嘅 type/id 形狀係 wrangler.toml 路徑，唔可以照抄落 Pages project API。
        # 所以呢度無論原本係 dict 定 list，都一律「正規化」成上面呢個形狀（原有 binding 全部保留）。
        def norm_kv(cur):
            items = list(cur.items()) if isinstance(cur,dict) else \
                    [((b.get("name") if isinstance(b,dict) else str(b)), b) for b in (cur or [])]
            out={}
            for name,v in items:
                nid = v.get("namespace_id") if isinstance(v,dict) else (v if isinstance(v,str) else None)
                if name and isinstance(nid,str) and nid: out[name]={"namespace_id":nid}
            return out
        def norm_r2(cur):
            items = list(cur.items()) if isinstance(cur,dict) else \
                    [((b.get("name") if isinstance(b,dict) else str(b)), b) for b in (cur or [])]
            out={}
            for name,v in items:
                if not name: continue
                if isinstance(v,dict):
                    bucket = v.get("name") or v.get("bucket_name")
                elif isinstance(v,str):
                    bucket = v
                else:
                    bucket = None
                if isinstance(bucket,str) and bucket: out[name]={"name":bucket}
            return out
        kvs=norm_kv(cfg.get("kv_namespaces"))
        kvs["UPLOADS_KV"]={"namespace_id":kv_id}
        cfg["kv_namespaces"]=kvs
        if r2:
            rs=norm_r2(cfg.get("r2_buckets"))
            rs["UPLOADS"]={"name":r2}
            cfg["r2_buckets"]=rs
        # vars / env_vars / 其他 binding 一律原樣帶返（唔可以清空）
    else:
        ev=dict(cfg.get("env_vars") or {})
        for k in list(ev.keys()):
            if k=="UPLOAD_TOKEN":
                ev.pop(k)                     # 舊值一律換新（避免殘留）
        ev["UPLOAD_TOKEN"]={"type":"secret_text","value":token}
        cfg["env_vars"]=ev
    out[env]=cfg
print(json.dumps({"deployment_configs":out}))
'
}

names_only() {  # stdin=專案 JSON → 每行 "env|種類|名"，用嚟證明 PATCH 冇清走嘢
  python3 -c '
import json,sys
p=json.load(sys.stdin).get("result",{})
dc=p.get("deployment_configs") or {}
BIND_KEYS=("kv_namespaces","r2_buckets","d1_databases","durable_object_namespaces",
           "hyperdrive","services","queues","vectorize","analytics_engine_datasets",
           "ai","browser","images")
for env in ("production","preview"):
    cfg=dc.get(env) or {}
    for k in BIND_KEYS:
        v=cfg.get(k)
        if isinstance(v,dict):
            for name in v: print("%s|%s|%s" % (env,k,name))
        elif isinstance(v,list):
            for b in v: print("%s|%s|%s" % (env,k,(b.get("name") if isinstance(b,dict) else b)))
    for k in (cfg.get("vars") or {}): print("%s|vars|%s" % (env,k))
    for k in (cfg.get("env_vars") or {}): print("%s|env_vars|%s" % (env,k))
' | sort -u
}

patch_project() {  # $1=描述 $2=JSON body
  local desc="$1" body="$2"
  cf_api PATCH "/accounts/${ACC}/pages/projects/${PROJ}" --data "$body"
  cf_expect_ok "$desc"
}

verify_nothing_lost() {  # $1=PATCH 前嘅 names 清單檔案
  local before_file="$1"
  cf_api GET "/accounts/${ACC}/pages/projects/${PROJ}"
  cf_expect_ok "重新讀取專案（驗證 PATCH 冇清走嘢）"
  # 順手更新全域 PROJECT_JSON：下一步（g 設 secret）一定要基於 PATCH 之後嘅狀態，
  # 否則會用舊 config 去 PATCH，變相蓋走啱啱加嘅 bindings（PATCH 係整份 config 換）。
  PROJECT_JSON="$CF_BODY"
  printf '%s' "$CF_BODY" | names_only > "$TMP_DIR/after.names"
  local missing
  missing="$(while IFS= read -r l; do
      [ -n "$l" ] || continue
      grep -qxF "$l" "$TMP_DIR/after.names" || printf '%s\n' "$l"
    done < "$before_file")"
  if [ -n "$missing" ]; then
    echo "❌ PATCH 之後有條目唔見咗，需要人手檢查：" >&2
    printf '%s\n' "$missing" | sed 's/^/   /' >&2
    exit 1
  fi
  ok "原有 bindings/vars 全部保留（PATCH 前 $(grep -c . "$before_file" || true) 條 → 冇缺失）"
}

apply_bindings() {
  local body
  body="$(printf '%s' "$PROJECT_JSON" | PATCH_KV_ID="$KV_ID" PATCH_R2="$R2_BUCKET" build_project_patch bindings)"
  if ! is_mutate; then
    echo
    echo "（dry-run）會 PATCH production + preview 嘅 kv_namespaces${R2_BUCKET:+ 同 r2_buckets}，內容："
    printf '%s' "$body" | python3 -c '
import json,sys
d=json.load(sys.stdin)["deployment_configs"]
for env,cfg in d.items():
    print("   [%s] kv_namespaces = %s" % (env, json.dumps(cfg.get("kv_namespaces"),ensure_ascii=False)))
    if cfg.get("r2_buckets") is not None:
        print("   [%s] r2_buckets    = %s" % (env, json.dumps(cfg.get("r2_buckets"),ensure_ascii=False)))
'
    return 0
  fi
  printf '%s' "$PROJECT_JSON" | names_only > "$TMP_DIR/before.names"
  info "PATCH bindings（production + preview）"
  patch_project "更新 bindings" "$body"
  ok "已加上 KV binding UPLOADS_KV${R2_BUCKET:+ 同 R2 binding UPLOADS}"
  verify_nothing_lost "$TMP_DIR/before.names"
}

apply_secret() {
  local body display
  body="$(printf '%s' "$PROJECT_JSON" | PATCH_TOKEN="$UPLOAD_TOKEN" build_project_patch secret)"
  # 顯示用：value 一律遮罩，唔可以出現喺輸出
  display="$(printf '%s' "$PROJECT_JSON" | PATCH_TOKEN='***' build_project_patch secret)"
  if ! is_mutate; then
    echo
    echo "（dry-run）會 PATCH env_vars.UPLOAD_TOKEN（production + preview，type=secret_text）："
    printf '%s' "$display" | python3 -c '
import json,sys
for env,cfg in json.load(sys.stdin)["deployment_configs"].items():
    print("   [%s] env_vars.UPLOAD_TOKEN = %s" % (env, json.dumps(cfg["env_vars"]["UPLOAD_TOKEN"],ensure_ascii=False)))
'
    return 0
  fi
  printf '%s' "$PROJECT_JSON" | names_only > "$TMP_DIR/before-secret.names"
  info "PATCH env_vars.UPLOAD_TOKEN（production + preview）"
  if cf_api PATCH "/accounts/${ACC}/pages/projects/${PROJ}" --data "$body" && [ "$CF_STATUS" = "200" ]; then
    ok "已設定 secret UPLOAD_TOKEN（值唔會顯示）"
  else
    # 退路：用 wrangler 設 secret（value 由 stdin 入，唔會出現喺 process args）
    warn "API 方式設 secret 失敗（HTTP ${CF_STATUS}）——改用 wrangler pages secret put"
    print_cf_errors "$CF_BODY" >&2
    command -v npx >/dev/null 2>&1 || die "npx 唔可用，冇辦法設定 secret"
    local env_name
    for env_name in production preview; do
      if ! printf '%s' "$UPLOAD_TOKEN" | CLOUDFLARE_API_TOKEN="$CF_TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACC" \
           npx --yes wrangler@latest pages secret put UPLOAD_TOKEN --project-name "$PROJ" --env "$env_name"; then
        die "wrangler pages secret put 失敗（env=${env_name}）"
      fi
    done
  fi
  verify_nothing_lost "$TMP_DIR/before-secret.names"
}

# ---------- h. 部署 ----------
# ---------- h. staged 部署 ----------
# 準備 stage 目錄：靜態檔一律用 git HEAD 版本（唔會把未提交／未驗證嘅改動推上線），
# functions/ 用工作樹版本（今次 feature 嘅程式碼就喺度）。
# Layout：.deploy-stage/{site,functions}，wrangler 由 stage root 執行、部署 site/，
# 咁樣 cwd 下就有 functions/（實測 pages dev 由呢個 layout 起，/api/list 回 401 = functions 生效）。
build_stage() {
  local stage="$STAGE_ROOT" site="$STAGE_ROOT/$STAGE_SITE_NAME"

  if [ "$FULL_TREE" -eq 0 ] && [ "$GIT_OK" -ne 1 ]; then
    die "冇 git／唔係 git repo → 做唔到 staged 部署（要原樣部署工作樹就用 --full-tree）"
  fi

  rm -rf "$stage"
  mkdir -p "$site"
  local n_head=0 n_new=0 p rel

  if [ "$FULL_TREE" -eq 1 ]; then
    warn "--full-tree：直接部署工作樹 ${PAGES_DIR}（含未提交改動，請確認你知後果）"
    ( cd "$REPO_ROOT" && cp -a "${PAGES_DIR}/." "$site/" )
    n_new="$(find "$site" -type f | wc -l | tr -d ' ')"
  else
    # 1) tracked 檔案 → 一律 HEAD 版本
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      rel="${p#${PAGES_DIR}/}"
      mkdir -p "$site/$(dirname "$rel")"
      "${GIT[@]}" show "HEAD:$p" > "$site/$rel"
      n_head=$((n_head + 1))
    done < <("${GIT[@]}" ls-tree -r --name-only HEAD -- "$PAGES_DIR")
    # 2) 未 tracked（未 ignore）嘅新檔案 → 用工作樹版本（例如新加嘅 upload.html）
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      rel="${p#${PAGES_DIR}/}"
      mkdir -p "$site/$(dirname "$rel")"
      cp -a "$REPO_ROOT/$p" "$site/$rel"
      n_new=$((n_new + 1))
    done < <("${GIT[@]}" ls-files --others --exclude-standard -- "$PAGES_DIR")
    # 3) 講清楚邊啲未提交改動今次「唔會」上線
    local dirty
    dirty="$("${GIT[@]}" status --porcelain --untracked-files=no -- "$PAGES_DIR" | awk '{print $NF}')"
    if [ -n "$dirty" ]; then
      echo "ℹ️  以下檔案有未提交改動，今次會用 HEAD 版本（唔會上線）："
      printf '%s\n' "$dirty" | sed 's/^/      /'
    fi
  fi

  # 4) functions 唔放喺 stage：wrangler 由 cwd（部署時 = repo root）嘅 functions/ 攞，
  #    所以 stage 內一定要冇 functions/，否則會連源碼一齊當靜態檔上傳。
  [ -d "$REPO_ROOT/functions" ] || die "搵唔到 ${REPO_ROOT}/functions —— Pages Functions 一定要跟埋上"
  [ -e "$site/functions" ] && die "stage 內竟然有 functions/（會將源碼當靜態檔公開）→ 已中止"

  ok "stage 完成：$site（靜態檔：HEAD ${n_head} 個 + 新檔 ${n_new} 個；functions 由 ${REPO_ROOT}/functions 攞，$(find "$REPO_ROOT/functions" -type f | wc -l | tr -d ' ') 個檔案）"
}

# pre-flight：由 stage root 編譯 functions。呢一步係本地動作（唔會掂 production），
# 但可以喺部署之前就證明 wrangler 喺呢個 cwd 搵得到 functions/，避免推出一個冇 API 嘅站。
preflight_functions() {
  info "pre-flight：由 repo root 編譯 functions（wrangler 用 cwd/functions 解析，確認搵得到）"
  local out="$TMP_DIR/fn-build" attempt
  rm -rf "$out"; mkdir -p "$out"
  for attempt in 1 2; do
    if ( cd "$REPO_ROOT" && env "${WR_ENV[@]}" npx --yes wrangler@latest pages functions build --outdir "$out" ) \
         > "$TMP_DIR/fn-build.log" 2>&1; then
      ok "functions 編譯成功：$(ls -1 "$out" | tr '\n' ' ')"
      return 0
    fi
    if [ "$attempt" -eq 1 ]; then
      warn "pre-flight 第 1 次唔成功（可能係 npx／網絡）→ 重試一次"
      sleep 2
    fi
  done
  # 分辨「真係編譯錯」同「環境問題（npx／網絡）」
  if grep -qiE 'esbuild|transform failed|could not resolve|syntaxerror|build failed' "$TMP_DIR/fn-build.log"; then
    tail -25 "$TMP_DIR/fn-build.log" >&2
    die "functions 編譯失敗（唔似環境問題）→ 唔部署，避免推出一個冇 API 嘅站"
  fi
  warn "pre-flight 唔成功，但睇落係 npx／網絡問題（唔似編譯錯誤）："
  tail -3 "$TMP_DIR/fn-build.log" | sed 's/^/      /' >&2
  warn "照樣繼續部署；部署之後嘅 GET /api/list 必須 401 檢查會做最終判斷"
}

deploy_pages() {
  local src_type
  src_type="$(printf '%s' "$PROJECT_JSON" | python3 -c 'import json,sys;print((json.load(sys.stdin).get("result",{}).get("source") or {}).get("type",""))')"
  if [ "$src_type" = "github" ] || [ "$src_type" = "gitlab" ]; then
    warn "專案係 Git-connected（source.type=${src_type}）：wrangler 直接上傳唔會經 git，"
    warn "dashboard 會多一個 Direct Upload deployment。如果想保持純 git 流程，請用 git push 取代呢步。"
  fi

  build_stage
  preflight_functions

  echo
  info "部署（cwd = repo root，functions 由 cwd/functions 攞）："
  info "  cd ${REPO_ROOT} && npx --yes wrangler@latest pages deploy ${STAGE_DEPLOY_DIR_REL} --project-name ${PROJ} --branch ${PROD_BRANCH} --commit-dirty=true"
  info "wrangler 環境：npm_config_cache=${REPO_ROOT}/.npm-cache、XDG_CONFIG_HOME=${REPO_ROOT}/.config-home、WRANGLER_LOG_PATH=${REPO_ROOT}/.wrangler-logs（token 唔會顯示）"

  if ! ( cd "$REPO_ROOT" && env "${WR_ENV[@]}" \
          CLOUDFLARE_API_TOKEN="$CF_TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACC" \
          npx --yes wrangler@latest pages deploy "$STAGE_DEPLOY_DIR_REL" \
            --project-name "$PROJ" --branch "$PROD_BRANCH" --commit-dirty=true ) 2>&1 | tee "$TMP_DIR/wrangler.log"; then
    die "wrangler 部署失敗（睇上面輸出）"
  fi

  # 報告 wrangler 有冇處理 functions（方便事後核對）
  local fn_lines
  fn_lines="$(grep -inE 'function|compiled worker|uploading|bundle|routes' "$TMP_DIR/wrangler.log" | head -6 || true)"
  if [ -n "$fn_lines" ]; then
    echo "  wrangler 輸出內 functions／bundle 相關行："
    printf '%s\n' "$fn_lines" | sed 's/^/      /'
  else
    warn "wrangler 輸出內搵唔到 functions 相關字眼 → 靠下一步 HTTP 檢查確認"
  fi
  ok "部署指令完成"
}

# 部署完整性檢查（唔受 --no-verify 影響）：冇 token 嘅 /api/list 一定要 401。
# 如果係 200 + HTML 首頁，即係 functions 冇上到（Pages 對未知路徑會 fallback 去首頁）。
verify_functions_live() {
  echo
  info "確認 functions 有上到：GET ${SITE_BASE}/api/list（期望 401）"
  local code
  code="$(curl -sS -o "$TMP_DIR/api-probe.txt" -w '%{http_code}' --max-time 30 "${SITE_BASE}/api/list" || true)"
  if [ "$code" = "401" ]; then
    ok "/api/list → 401（functions 生效、auth 生效）"
    return 0
  fi
  if [ "$code" = "200" ] && grep -qiE '<!DOCTYPE|<html' "$TMP_DIR/api-probe.txt"; then
    echo "❌ /api/list 回 200 + HTML 首頁 → functions 冇生效（Pages fallback）" >&2
    echo "   檢查：① ${STAGE_ROOT}/functions 存在 ② 部署係由 stage root 執行 ③ 等 30 秒再試（propagation）" >&2
  else
    echo "❌ /api/list → HTTP ${code}（期望 401）" >&2
    print_body_head "$(cat "$TMP_DIR/api-probe.txt" 2>/dev/null || true)"
  fi
  exit 1
}

# ---------- i. 線上驗證 ----------
# 帶 upload token 嘅 curl：token 用 stdin config 傳，唔會出現喺 process args
site_curl() {  # $1=method $2=url [其他 curl 參數...]
  local method="$1" url="$2"
  shift 2
  curl -sS -X "$method" -K - -w $'\n%{http_code}' "$@" "$url" \
    <<< "header = \"x-upload-token: ${UPLOAD_TOKEN}\""
}

# 印 response body 頭 300 字。刻意唔用 `| head -c`：head 提早收工會令上游 printf 收到 SIGPIPE，
# 配合 set -euo pipefail 就會令成個腳本中途死（實測 exit 141），後面嘅驗證就唔會跑。
print_body_head() {
  printf '%s' "$1" | python3 -c '
import sys
d=sys.stdin.read()[:300]
print("\n".join("    body: "+l for l in d.splitlines()) if d.strip() else "    body: （空）")
' >&2 || true
}

site_call() {  # $1=method $2=url [curl 參數...] → SITE_STATUS / SITE_BODY（帶 token）
  local raw
  if ! raw="$(site_curl "$@" 2>&1)"; then
    die "連唔到 ${2}（線上驗證）"
  fi
  SITE_STATUS="${raw##*$'\n'}"
  SITE_BODY="${raw%$'\n'*}"
}

site_call_anon() {  # 同上但唔帶 token
  local raw
  if ! raw="$(curl -sS -X "$1" "$2" "${@:3}" -w $'\n%{http_code}' 2>&1)"; then
    die "連唔到 ${2}（線上驗證）"
  fi
  SITE_STATUS="${raw##*$'\n'}"
  SITE_BODY="${raw%$'\n'*}"
}

verify_online() {
  echo
  echo "──────── 線上驗證（${SITE_BASE}）────────"
  local failures=0

  # 1) /upload.html 期望 200（或者 3xx 跟 redirect 之後 200）
  local code page_ok=0
  code="$(curl -sS -o "$TMP_DIR/upload.html" -w '%{http_code}' --max-time 30 "${SITE_BASE}/upload.html" || true)"
  if [ "$code" = "200" ]; then
    page_ok=1
    ok "GET /upload.html → 200（$(wc -c < "$TMP_DIR/upload.html" | tr -d ' ') bytes）"
  elif [ "${code:0:1}" = "3" ]; then
    local code2
    code2="$(curl -sSL -o "$TMP_DIR/upload.html" -w '%{http_code}' --max-time 30 "${SITE_BASE}/upload.html" || true)"
    if [ "$code2" = "200" ]; then
      page_ok=1
      ok "GET /upload.html → ${code} → 跟 redirect → 200"
    else
      echo "❌ GET /upload.html：${code} → 跟 redirect → ${code2}（期望 200）" >&2
      failures=$((failures+1))
    fi
  else
    echo "❌ GET /upload.html → HTTP ${code}（期望 200）" >&2
    print_body_head "$(cat "$TMP_DIR/upload.html" 2>/dev/null || true)"
    failures=$((failures+1))
  fi

  # 1b) 防假陽性：Pages 對唔存在嘅路徑會 fallback 去首頁（照回 200 + index.html），
  #     所以「200」唔等於檔案真係存在 → 同首頁內容比對。
  if [ "$page_ok" -eq 1 ]; then
    local root_code
    root_code="$(curl -sS -o "$TMP_DIR/root.html" -w '%{http_code}' --max-time 30 "${SITE_BASE}/" || true)"  # 一定要接住 -w 輸出，否則會漏出「200」
    if [ -s "$TMP_DIR/root.html" ] && cmp -s "$TMP_DIR/upload.html" "$TMP_DIR/root.html"; then
      echo "❌ /upload.html 嘅內容同首頁一模一樣（Pages fallback）→ upload.html 其實未部署" >&2
      failures=$((failures+1))
    else
      ok "upload.html 唔係首頁 fallback（內容同 / 唔同）"
    fi
  fi

  # 2) /api/list 冇 token 期望 401
  site_call_anon GET "${SITE_BASE}/api/list"
  if [ "$SITE_STATUS" = "401" ]; then
    ok "GET /api/list（冇 token）→ 401 ✓"
  else
    echo "❌ GET /api/list（冇 token）→ HTTP ${SITE_STATUS}（期望 401）" >&2
    print_body_head "$SITE_BODY"
    failures=$((failures+1))
  fi

  # 3) /api/list 帶 token 期望 200 ok:true
  site_call GET "${SITE_BASE}/api/list?limit=5"
  if [ "$SITE_STATUS" = "200" ] && printf '%s' "$SITE_BODY" | grep -q '"ok":true'; then
    ok "GET /api/list（帶 token）→ 200 ok:true（count=$(printf '%s' "$SITE_BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("count"))' 2>/dev/null || echo '?')）"
  else
    echo "❌ GET /api/list（帶 token）→ HTTP ${SITE_STATUS}（期望 200 + ok:true）" >&2
    print_body_head "$SITE_BODY"
    failures=$((failures+1))
  fi

  # 4) 上傳 → raw sha256 對比 → 刪除（無論成敗都清走測試檔）
  local test_file test_sum key
  test_file="$TMP_DIR/selftest.png"
  python3 -c 'import os,sys;open(sys.argv[1],"wb").write(os.urandom(256))' "$test_file"
  test_sum="$(sha256_file "$test_file")"
  site_call POST "${SITE_BASE}/api/upload" -F "file=@${test_file};type=image/png"
  if [ "$SITE_STATUS" = "200" ]; then
    key="$(printf '%s' "$SITE_BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("file",{}).get("key",""))' 2>/dev/null || true)"
    if [ -n "$key" ]; then
      ok "POST /api/upload → 200（key=${key}）"

      local raw_url
      raw_url="${SITE_BASE}/api/raw?key=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$key")"

      # 4a) /api/raw 一定要 token：冇 token 期望 401
      site_call_anon GET "$raw_url" -o "$TMP_DIR/raw-anon.bin"
      if [ "$SITE_STATUS" = "401" ]; then
        ok "GET /api/raw（冇 token）→ 401 ✓"
      else
        echo "❌ GET /api/raw（冇 token）→ HTTP ${SITE_STATUS}（期望 401）" >&2
        print_body_head "$(cat "$TMP_DIR/raw-anon.bin" 2>/dev/null || true)"
        failures=$((failures+1))
      fi

      # 4b) 錯 token 都應該 401
      site_call_anon GET "$raw_url" -H 'x-upload-token: definitely-wrong-token' -o "$TMP_DIR/raw-bad.bin"
      if [ "$SITE_STATUS" = "401" ]; then
        ok "GET /api/raw（錯 token）→ 401 ✓"
      else
        echo "❌ GET /api/raw（錯 token）→ HTTP ${SITE_STATUS}（期望 401）" >&2
        failures=$((failures+1))
      fi

      # 4c) 帶 token 期望 200 + sha256 一致 + 安全 headers
      site_call GET "$raw_url" -D "$TMP_DIR/raw.headers" -o "$TMP_DIR/raw.bin"
      if [ "$SITE_STATUS" = "200" ]; then
        local got_sum
        got_sum="$(sha256_file "$TMP_DIR/raw.bin")"
        if [ "$got_sum" = "$test_sum" ]; then
          ok "GET /api/raw（帶 token）sha256 一致（${test_sum:0:16}…）"
        else
          echo "❌ GET /api/raw sha256 唔一致：期望 ${test_sum}，實際 ${got_sum}" >&2
          failures=$((failures+1))
        fi
        if grep -qi '^content-security-policy:.*default-src' "$TMP_DIR/raw.headers" 2>/dev/null \
           && grep -qi '^x-content-type-options: *nosniff' "$TMP_DIR/raw.headers" 2>/dev/null; then
          ok "GET /api/raw 有 CSP sandbox + nosniff ✓"
        else
          echo "❌ GET /api/raw 缺少 CSP sandbox 或 nosniff（睇 $TMP_DIR/raw.headers）" >&2
          failures=$((failures+1))
        fi
        if grep -qi '^access-control-allow-origin' "$TMP_DIR/raw.headers" 2>/dev/null; then
          echo "❌ GET /api/raw 出現 Access-Control-Allow-Origin（contract 唔准加）" >&2
          failures=$((failures+1))
        else
          ok "GET /api/raw 冇加 CORS header ✓"
        fi
      else
        echo "❌ GET /api/raw（帶 token）→ HTTP ${SITE_STATUS}（期望 200）" >&2
        print_body_head "$(cat "$TMP_DIR/raw.bin" 2>/dev/null || true)"
        failures=$((failures+1))
      fi
      local payload
      payload="$(python3 -c 'import json,sys;print(json.dumps({"key":sys.argv[1]}))' "$key")"
      site_call POST "${SITE_BASE}/api/delete" -H 'Content-Type: application/json' --data-binary "$payload"
      if [ "$SITE_STATUS" = "200" ]; then
        ok "POST /api/delete → 200（測試檔已清走）"
      else
        echo "❌ POST /api/delete → HTTP ${SITE_STATUS}（期望 200；測試檔 key=${key} 可能殘留）" >&2
        print_body_head "$SITE_BODY"
        failures=$((failures+1))
      fi
    else
      echo "❌ POST /api/upload 回 200 但攞唔到 key" >&2
      print_body_head "$SITE_BODY"
      failures=$((failures+1))
    fi
  else
    echo "❌ POST /api/upload → HTTP ${SITE_STATUS}（期望 200）" >&2
    print_body_head "$SITE_BODY"
    failures=$((failures+1))
  fi

  echo "──────────────────────────────"
  if [ "$failures" -gt 0 ]; then
    die "線上驗證有 ${failures} 項失敗（睇上面）"
  fi
  ok "線上驗證全部通過"
}

# ---------- main ----------
main() {
  parse_args "$@"
  tmp_dir
  echo "════ Kingshot 部署（$(date -u +%Y-%m-%dT%H:%M:%SZ)）════"
  if [ "$DRY_RUN" -eq 1 ]; then
    if is_mutate; then info "模式：--dry-run（會做 a–g 變更，但唔部署）"
    else info "模式：--dry-run（全唯讀，唔會改任何嘢）"; fi
  fi
  [ "$VERIFY_ONLY" -eq 1 ] && info "模式：--verify-only（只跑線上驗證）"

  check_deps

  if [ "$VERIFY_ONLY" -eq 1 ]; then
    load_upload_token
    verify_online
    return 0
  fi

  load_cf_token
  load_upload_token
  resolve_account      # b
  resolve_project      # c
  report_project       # d
  resolve_kv           # e（KV namespace）
  resolve_r2           # e2（R2 bucket）
  apply_bindings       # f（兩個 binding 都綁：UPLOADS + UPLOADS_KV）
  apply_secret         # g

  if [ "$DRY_RUN" -eq 1 ]; then
    echo
    info "（dry-run）準備 staged 部署目錄（只喺本機寫 .deploy-stage/，唔會部署）"
    build_stage
    preflight_functions
    echo "（dry-run）真正部署時會執行："
    echo "      cd ${REPO_ROOT} && npx --yes wrangler@latest pages deploy ${STAGE_DEPLOY_DIR_REL} --project-name ${PROJ} --branch ${PROD_BRANCH} --commit-dirty=true"
    echo "      （cwd = repo root ⇒ wrangler 用 cwd/functions 做 Pages Functions，唔需要 copy／symlink）"
    echo
    echo
    echo "──── 計劃中嘅最終 bindings（只列名／id，唔列 secret）────"
    printf '%s' "$PROJECT_JSON" \
      | PATCH_KV_ID="$KV_ID" PATCH_R2="$R2_BUCKET" build_project_patch bindings \
      | PATCH_TOKEN='***' build_project_patch secret \
      | print_bindings_report
    echo "─────────────────────────────────────────────"
    echo
    echo "════ dry-run 完成：a–g 檢查完成，未部署、未做線上驗證 ════"
    if ! is_mutate; then
      echo "（今次係全唯讀：冇建立 KV、冇 PATCH、冇設 secret。要照做 a–g 就用 CF_DRY_RUN_APPLY=1 bash deploy/deploy.sh --dry-run）"
    fi
    echo "下一步：bash deploy/deploy.sh   （或 --verify-only 先驗現有部署）"
    return 0
  fi

  echo
  echo "──────── 最終 bindings（已寫入，只列名／id，唔列 secret）────────"
  printf '%s' "$PROJECT_JSON" | print_bindings_report
  echo "────────────────────────────────────────────"

  deploy_pages          # h（staged：HEAD 靜態檔 + 工作樹 functions）
  verify_functions_live # h2：functions 有冇真係上到（--no-verify 都會跑）
  if [ "$DO_VERIFY" -eq 1 ]; then
    verify_online      # i
  else
    warn "已用 --no-verify：跳過線上驗證"
  fi

  echo
  echo "════ 完成 ════"
  echo "  站點：${SITE_BASE}"
  echo "  專案：${PROJ}（account ${ACC}）"
  echo "  KV  ：${KV_TITLE}（${KV_STATE}，id=${KV_ID}）"
  if [ -n "$R2_BUCKET" ]; then echo "  R2  ：${R2_BUCKET}（${R2_STATE}）"; else echo "  R2  ：（未綁，\$CF_R2_BUCKET 為空）"; fi
  echo "  測試檔已清走；upload token 存放喺 ${UPLOAD_TOKEN_FILE:-<env>}（唔會顯示內容）"
}

main "$@"
