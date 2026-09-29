#!/usr/bin/env bash
#
# Kingshot 上傳 API 助手 — 取「最近上傳」清單、下載新檔到 workspace，可選分析完刪除遠端
#
# 用法：
#   ./deploy/fetch-uploads.sh --list
#   ./deploy/fetch-uploads.sh --download
#   ./deploy/fetch-uploads.sh --download --since 2026-09-29T00:00:00Z
#   ./deploy/fetch-uploads.sh --download --key 2026-09-29/1790661604-hero.jpg
#   ./deploy/fetch-uploads.sh --download --delete --yes      # 下載成功嘅就刪遠端（分析完清理）
#   ./deploy/fetch-uploads.sh --delete --key <key> --yes
#
# Token 來源（順序）：
#   1) 環境變數 $UPLOAD_TOKEN
#   2) $UPLOAD_TOKEN_FILE（預設 deploy/.upload-token，單行）
# 註：/api/list、/api/raw（下載原始檔）、/api/delete 全部都需要呢個 token ——
#     /api/raw 唔係公開連結（key 內含 epoch-ms 可被枚舉），所以下載一樣會帶 token。
# Base URL：$UPLOAD_BASE（預設 https://avgkingshot.85200852.xyz）
#
# 任何 API 回應唔係 200 都會印出錯誤並以非 0 結束。Token 唔會顯示喺輸出。

set -euo pipefail

# ---------- 預設值 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BASE="${UPLOAD_BASE:-https://avgkingshot.85200852.xyz}"
BASE="${BASE%/}"                       # 去掉尾斜線
TOKEN_FILE="${UPLOAD_TOKEN_FILE:-${SCRIPT_DIR}/.upload-token}"
OUT_DIR="${REPO_ROOT}/uploads"
LIMIT=100
SINCE=""
KEY=""
DO_LIST=0
DO_DOWNLOAD=0
DO_DELETE=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Kingshot 上傳助手

用法：fetch-uploads.sh [動作] [選項]

動作（唔指定動作 = --list）：
  --list                印出遠端上傳清單（新到舊）
  --download            下載符合條件嘅檔案到 --out 目錄（本地已存在且大小相同就跳過）
  --delete              刪除遠端檔案；配 --download 時只會刪「今次成功下載」嘅檔案

選項：
  --since <ISO>         只處理比呢個時間新嘅檔案（ISO 8601，例：2026-09-29T00:00:00Z）
                        --download 而冇指定 --since 時，會用上次成功下載嘅時間（state file）
  --key <key>           只處理單一 object key（配 --download 或 --delete；呢個模式唔會查清單）
  --out <dir>           下載目錄（預設 <repo>/uploads）
  --limit <n>           清單最多幾筆（預設 100，最大 500）
  --yes                 唔問確認（非互動環境做 --delete 必須加）
  -h, --help            顯示呢個說明

環境變數：
  UPLOAD_TOKEN          直接提供 token（優先）
  UPLOAD_TOKEN_FILE     token 檔案路徑（預設 deploy/.upload-token，單行）
  UPLOAD_BASE           API base URL（預設 https://avgkingshot.85200852.xyz）

例子：
  ./deploy/fetch-uploads.sh --list --limit 20
  ./deploy/fetch-uploads.sh --download --since 2026-09-28T00:00:00Z
  ./deploy/fetch-uploads.sh --download --delete --yes
EOF
}

# ---------- 參數解析 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --list) DO_LIST=1 ;;
    --download) DO_DOWNLOAD=1 ;;
    --delete) DO_DELETE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --since) SINCE="${2:-}"; [ -n "$SINCE" ] || { echo "❌ --since 需要一個 ISO 日期" >&2; exit 2; }; shift ;;
    --key) KEY="${2:-}"; [ -n "$KEY" ] || { echo "❌ --key 需要一個 key" >&2; exit 2; }; shift ;;
    --out) OUT_DIR="${2:-}"; [ -n "$OUT_DIR" ] || { echo "❌ --out 需要一個目錄" >&2; exit 2; }; shift ;;
    --limit) LIMIT="${2:-}"; [ -n "$LIMIT" ] || { echo "❌ --limit 需要一個數字" >&2; exit 2; }; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ 唔認識嘅參數：$1" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# 冇指定任何動作 → 預設列清單
if [ "$DO_LIST" -eq 0 ] && [ "$DO_DOWNLOAD" -eq 0 ] && [ "$DO_DELETE" -eq 0 ]; then
  DO_LIST=1
fi
# --delete 單獨出現（唔配 --download）時，佢自己就係動作，唔需要額外列清單
if [ "$DO_DELETE" -eq 1 ] && [ "$DO_DOWNLOAD" -eq 0 ]; then
  DO_LIST=0
fi

if ! command -v curl >/dev/null 2>&1; then echo "❌ 需要 curl" >&2; exit 1; fi
if ! command -v python3 >/dev/null 2>&1; then echo "❌ 需要 python3（解析 JSON）" >&2; exit 1; fi

# ---------- Token ----------
TOKEN=""
if [ -n "${UPLOAD_TOKEN:-}" ]; then
  TOKEN="$UPLOAD_TOKEN"
elif [ -f "$TOKEN_FILE" ]; then
  # 只取第一行，順手去掉 CR/LF 同前後空白
  TOKEN="$(head -n 1 "$TOKEN_FILE" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
fi
if [ -z "$TOKEN" ]; then
  echo "❌ 冇 token：請設定 \$UPLOAD_TOKEN，或將 token 寫入 $TOKEN_FILE（單行）" >&2
  exit 1
fi

# ---------- HTTP helper ----------
HTTP_STATUS=""
HTTP_BODY=""

# api_call <method> <url> [curl 額外參數...] → 設定 HTTP_STATUS / HTTP_BODY
api_call() {
  local method="$1" url="$2"
  shift 2
  local raw
  if ! raw="$(curl -sS -X "$method" -H "x-upload-token: ${TOKEN}" -w $'\n%{http_code}' "$@" "$url" 2>&1)"; then
    echo "❌ 連唔到 API：$url" >&2
    echo "$raw" >&2
    exit 1
  fi
  HTTP_STATUS="${raw##*$'\n'}"
  HTTP_BODY="${raw%$'\n'*}"
}

# 檢查 API 回應：非 200 就印錯誤（唔會 show token）並 exit 非 0
expect_200() {
  local what="$1"
  if [ "$HTTP_STATUS" != "200" ]; then
    echo "❌ $what 失敗：HTTP $HTTP_STATUS" >&2
    echo "   回應：$HTTP_BODY" >&2
    exit 1
  fi
}

# URL-encode（query 參數用；key 內含 '/' 一定要 encode）
urlencode() {
  python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"
}

# JSON → TSV（key, size, type, uploadedAt, name）；欄位內嘅 tab/換行會換成空白
json_files_to_tsv() {
  python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    sys.stderr.write("❌ 回應唔係合法 JSON：%s\n" % e)
    sys.exit(1)
if not isinstance(d, dict) or not d.get("ok"):
    sys.stderr.write("❌ API 回報錯誤：%s\n" % json.dumps(d, ensure_ascii=False))
    sys.exit(1)
def clean(s):
    return str(s).replace("\t", " ").replace("\n", " ").replace("\r", " ")
for f in d.get("files", []):
    sys.stdout.write("\t".join([
        clean(f.get("key", "")), clean(f.get("size", 0)), clean(f.get("type", "")),
        clean(f.get("uploadedAt", "")), clean(f.get("name", "")),
    ]) + "\n")
'
}

# ---------- 取得清單（單 key 模式除外） ----------
declare -a FILE_KEYS=() FILE_SIZES=() FILE_TYPES=() FILE_TIMES=() FILE_NAMES=()

load_selection() {
  if [ -n "$KEY" ]; then
    # 單 key 模式：唔查清單，直接鎖定一個 key
    FILE_KEYS=("$KEY"); FILE_SIZES=(""); FILE_TYPES=(""); FILE_TIMES=(""); FILE_NAMES=("")
    return 0
  fi
  local url="${BASE}/api/list?limit=${LIMIT}"
  if [ -n "$SINCE" ]; then
    url="${url}&since=$(urlencode "$SINCE")"
  fi
  api_call GET "$url"
  expect_200 "取清單"
  local tsv
  if ! tsv="$(printf '%s' "$HTTP_BODY" | json_files_to_tsv)"; then
    exit 1
  fi
  while IFS=$'\t' read -r k s t u n; do
    [ -n "$k" ] || continue
    FILE_KEYS+=("$k"); FILE_SIZES+=("$s"); FILE_TYPES+=("$t"); FILE_TIMES+=("$u"); FILE_NAMES+=("$n")
  done <<< "$tsv"
}

# ---------- 動作 1：列清單 ----------
do_list() {
  load_selection
  if [ "${#FILE_KEYS[@]}" -eq 0 ]; then
    echo "（冇符合條件嘅檔案）"
    return 0
  fi
  if [ -n "$KEY" ]; then
    # 單 key 模式：冇查清單，所以冇 size / uploadedAt 可以顯示
    echo "key：${FILE_KEYS[0]}"
    echo "raw URL：${BASE}/api/raw?key=$(urlencode "${FILE_KEYS[0]}")"
    echo "（/api/raw 需要 token：curl -H \"x-upload-token: \$UPLOAD_TOKEN\" … 或用 &token=…）"
    echo "（單 key 模式唔會查清單 → 冇 size/uploadedAt；要 metadata 就單獨用 --list）"
    return 0
  fi
  printf '%-52s %10s  %-24s %s\n' "KEY" "SIZE" "UPLOADED_AT" "NAME"
  printf '%s\n' "----------------------------------------------------------------------------------------------------"
  local i human
  for i in "${!FILE_KEYS[@]}"; do
    human="$(python3 -c 'import sys
n=float(sys.argv[1])
for u in ("B","KiB","MiB","GiB"):
    if n < 1024 or u == "GiB":
        print(("%.0f %s" % (n, u)) if u == "B" else ("%.1f %s" % (n, u)))
        break
    n /= 1024' "${FILE_SIZES[$i]:-0}")"
    printf '%-52s %10s  %-24s %s\n' "${FILE_KEYS[$i]}" "$human" "${FILE_TIMES[$i]}" "${FILE_NAMES[$i]}"
  done
  echo
  echo "共 ${#FILE_KEYS[@]} 個檔案"
}

# ---------- 動作 2：下載 ----------
DOWNLOADED_KEYS=()      # 今次真正下載成功嘅 key（--delete 只會刪呢批）
SKIPPED=0
STATE_FILE=""

do_download() {
  mkdir -p "$OUT_DIR"
  STATE_FILE="${OUT_DIR}/.fetch-state"

  # --download 冇明講 --since → 用上次成功下載嘅時間，做到增量抓取
  if [ -z "$SINCE" ] && [ -z "$KEY" ] && [ -f "$STATE_FILE" ]; then
    local last
    last="$(head -n 1 "$STATE_FILE" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [ -n "$last" ]; then
      SINCE="$last"
      echo "ℹ️  用上次下載時間做 since：$SINCE"
    fi
  fi

  load_selection
  if [ "${#FILE_KEYS[@]}" -eq 0 ]; then
    echo "（冇新檔案要下載）"
    return 0
  fi

  local i key dest url want_size tmp got_size
  for i in "${!FILE_KEYS[@]}"; do
    key="${FILE_KEYS[$i]}"
    want_size="${FILE_SIZES[$i]}"
    dest="${OUT_DIR}/${key}"
    mkdir -p "$(dirname "$dest")"

    # 已經有同 size 嘅檔 → 跳過（key 內含 epoch，唔會撞名）
    if [ -f "$dest" ] && [ -n "$want_size" ]; then
      got_size="$(wc -c < "$dest" | tr -d ' ')"
      if [ "$got_size" = "$want_size" ]; then
        echo "⏭️  已存在，跳過：$key"
        SKIPPED=$((SKIPPED + 1))
        continue
      fi
    fi

    url="${BASE}/api/raw?key=$(urlencode "$key")"
    # /api/raw 需要 token（header 或 ?token=）；用 stdin config 傳 header，token 唔會出現喺 process args。
    # 先落 .part，成功驗證後才 mv（避免半截檔當成完整）
    if ! curl -sS -f -K - -o "${dest}.part" "$url" <<< "header = \"x-upload-token: ${TOKEN}\""; then
      rm -f "${dest}.part"
      echo "❌ 下載失敗：$key（HTTP 錯誤、token 唔啱，或連線問題）" >&2
      exit 1
    fi
    got_size="$(wc -c < "${dest}.part" | tr -d ' ')"
    if [ -n "$want_size" ] && [ "$got_size" != "$want_size" ]; then
      rm -f "${dest}.part"
      echo "❌ 下載大小唔對：$key（拿到 $got_size，預期 $want_size）" >&2
      exit 1
    fi
    mv -f "${dest}.part" "$dest"
    DOWNLOADED_KEYS+=("$key")
    echo "✅ 已下載：$key（$got_size bytes）→ $dest"
  done

  echo
  echo "下載完成：新檔 ${#DOWNLOADED_KEYS[@]} 個、跳過 ${SKIPPED} 個 → $OUT_DIR"

  # 記錄今次「睇到最新嘅 uploadedAt」做下次增量基準。
  # 刻意唔用 now：如果用 now，就喺 list 之後、寫 state 之前上傳嘅檔案會永遠被跳過。
  if [ -z "$KEY" ] && [ "${#FILE_TIMES[@]}" -gt 0 ]; then
    local newest="" u
    for u in "${FILE_TIMES[@]}"; do
      [ -n "$u" ] || continue
      if [ -z "$newest" ] || [[ "$u" > "$newest" ]]; then newest="$u"; fi
    done
    if [ -n "$newest" ]; then printf '%s\n' "$newest" > "$STATE_FILE"; fi
  fi
}

# ---------- 動作 3：刪除遠端 ----------
do_delete() {
  local -a targets=()
  if [ "$DO_DOWNLOAD" -eq 1 ]; then
    # 只刪今次真係下載成功嘅（本地已有副本，穩陣）
    if [ "${#DOWNLOADED_KEYS[@]}" -eq 0 ]; then
      echo "（今次冇新下載，冇嘢刪）"
      return 0
    fi
    targets=("${DOWNLOADED_KEYS[@]}")
  else
    load_selection
    if [ "${#FILE_KEYS[@]}" -eq 0 ]; then
      echo "（冇符合條件嘅檔案，冇嘢刪）"
      return 0
    fi
    targets=("${FILE_KEYS[@]}")
  fi

  echo "將會刪除 ${#targets[@]} 個遠端檔案："
  for k in "${targets[@]}"; do echo "  - $k"; done

  if [ "$ASSUME_YES" -ne 1 ]; then
    local ans=""
    if [ -r /dev/tty ]; then
      # 非互動環境（CI／agent）開唔到 /dev/tty，當作未確認處理。
      # 注意：2>/dev/null 要放喺 < /dev/tty 之前，先可以連「開唔到 tty」嘅錯誤都靜音。
      read -r -p "確認刪除？(yes/no) " ans 2>/dev/null < /dev/tty || ans=""
    fi
    if [ "$ans" != "yes" ]; then
      echo "❌ 未確認，已取消（非互動環境請加 --yes）" >&2
      exit 1
    fi
  fi

  local k payload deleted=0
  for k in "${targets[@]}"; do
    payload="$(python3 -c 'import json,sys;print(json.dumps({"key":sys.argv[1]}))' "$k")"
    api_call POST "${BASE}/api/delete" -H 'Content-Type: application/json' --data-binary "$payload"
    if [ "$HTTP_STATUS" = "200" ]; then
      deleted=$((deleted + 1))
      echo "🗑️  已刪除：$k"
    elif [ "$HTTP_STATUS" = "404" ]; then
      echo "❌ 刪除失敗：$k → HTTP 404（遠端已經冇呢個 key）" >&2
      exit 1
    else
      echo "❌ 刪除失敗：$k → HTTP $HTTP_STATUS" >&2
      echo "   回應：$HTTP_BODY" >&2
      exit 1
    fi
  done
  echo
  echo "刪除完成：$deleted / ${#targets[@]}"
}

# ---------- 執行 ----------
if [ "$DO_LIST" -eq 1 ]; then do_list; fi
if [ "$DO_DOWNLOAD" -eq 1 ]; then do_download; fi
if [ "$DO_DELETE" -eq 1 ]; then do_delete; fi
