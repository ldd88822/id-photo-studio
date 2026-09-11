#!/usr/bin/env bash
# 证件照工作台 · 一键跑全部测试
# 自动解析托管 node（versions/current 是存版本号的文本文件，不是目录软链）
set -u

# Bash 工具会话里 PATH 可能整段失效，显式补回来
export PATH="/usr/bin:/bin:/c/Windows/System32:/c/Windows:/usr/local/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

# --- 解析 node ---
# 不要硬编码用户名（含中文，且不应提交到公开仓库）
BIN="$HOME/.workbuddy/binaries/node"
# 转成 Windows 可执行路径：Git Bash 自带 cygpath，没有就手工替换盘符
if command -v cygpath >/dev/null 2>&1; then
  BIN_WIN="$(cygpath -m "$BIN")"   # -m = 混合模式，统一用正斜杠
else
  BIN_WIN="$(echo "$BIN" | sed 's|^/\([a-z]\)/|\1:/|')"
fi

NODE=""
if [ -f "$BIN/versions/current" ]; then
  VER="$(tr -d '[:space:]' < "$BIN/versions/current")"
  [ -f "$BIN/versions/$VER/node.exe" ] && NODE="$BIN_WIN/versions/$VER/node.exe"
fi
if [ -z "$NODE" ]; then
  # 兜底：取 versions 下第一个存在的 node.exe
  for d in "$BIN/versions/"*/; do
    if [ -f "$d/node.exe" ]; then
      NODE="$BIN_WIN/versions/$(basename "$d")/node.exe"
      break
    fi
  done
fi
[ -z "$NODE" ] && { echo "找不到 node.exe，请检查 $BIN/versions/"; exit 1; }
echo "node: $NODE ($("$NODE" -v 2>/dev/null))"
echo ""

# --- 服务器探测（E2E 需要）---
# 注意：Windows 原生 curl 写 /dev/null 会返回 exit 23，不能靠退出码判断，
# 必须看它输出的 HTTP 状态码。
BASE="${BASE:-http://127.0.0.1:8848}"
CODE="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE/index.html" 2>/dev/null || true)"
if [ "$CODE" = "200" ]; then
  echo "服务器在线: $BASE"
else
  echo "⚠️  服务器未响应 ($BASE，HTTP=${CODE:-无})。E2E 会失败，先双击「启动证件照工作台.bat」。"
fi
echo ""

total=0
fail=0

run() {
  local label="$1"; shift
  echo "=== $label ==="
  out="$("$@" 2>&1)"
  echo "$out" | grep -E "通过|失败" | tail -2
  if echo "$out" | grep -qE "失败 0|通过 [0-9]+ / 失败 0"; then
    echo "  -> OK"
  else
    echo "  -> FAIL"
    echo "$out" | grep -E "FAIL|失败" | head -10
    fail=$((fail + 1))
  fi
  total=$((total + 1))
  echo ""
}

run "单元测试" "$NODE" _test.mjs
run "像素测试" "$NODE" _test_pixel.mjs
run "端到端" "$NODE" _e2e/run.mjs

echo "===== 汇总：$((total - fail))/$total 个套件通过 ====="
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
