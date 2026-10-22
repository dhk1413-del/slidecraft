#!/usr/bin/env bash
# SlideCraft 启动脚本（本机 :8640）
# 用法：bash server/run.sh          # 前台
#       bash server/run.sh --reload # 开发热重载
set -e
cd "$(dirname "$0")/.."

VENV=".venv"
if [ ! -d "$VENV" ]; then
  echo "== 创建虚拟环境（Python $(python3 -V 2>&1 | awk '{print $2}')）=="
  python3 -m venv "$VENV"
fi

if ! "$VENV/bin/python" -c 'import fastapi, httpx, PIL, yaml, pptx, docx, fitz, multipart' >/dev/null 2>&1; then
  echo "== 安装 Python 依赖 =="
  "$VENV/bin/pip" install -q --upgrade pip --index-url https://pypi.org/simple --no-cache-dir
  echo "== 安装依赖 =="
  "$VENV/bin/pip" install -q -r server/requirements.txt --index-url https://pypi.org/simple --no-cache-dir
fi

# 原生可编辑 PPTX 由 PptxGenJS 生成；首次启动自动安装锁定的 Node 依赖。
if ! (cd server/pptx && node -e "import('pptxgenjs')") >/dev/null 2>&1; then
  echo "== 安装原生 PPTX 导出器依赖 =="
  npm ci --prefix server/pptx
fi

# 「图片转可编辑」需要 agent 链（Harness CLI + editppt CLI + 第三方 skill）。
# 首次启动/缺件时后台自动安装：不阻塞启动，失败也不影响零 key 主流程，
# 装好后 /api/editable-engines 会自动变为可用。跳过：DECKFORGE_SKIP_AGENT_INSTALL=1
if [ "${DECKFORGE_SKIP_AGENT_INSTALL:-0}" != "1" ] && [ -f tools/install_agent.sh ]; then
  echo "== 检查/后台安装「图片转可编辑」所需 agent 链（Harness 等）=="
  bash tools/install_agent.sh --background || true
fi

export PYTHONPATH="$(pwd)/server"

# 默认仅监听本机。局域网访问时用 DECKFORGE_HOST=0.0.0.0 显式开启。
# 端口可用 .env 里的 DECKFORGE_PORT 覆盖（工作区根 .env / config/.env 都认，后者优先）
CONFIG_PORT="$(grep -hE '^DECKFORGE_PORT=' .env config/.env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')"
PORT="${DECKFORGE_PORT:-${CONFIG_PORT:-8640}}"
HOST="${DECKFORGE_HOST:-127.0.0.1}"

echo "== SlideCraft 启动：http://${HOST}:${PORT} =="
exec "$VENV/bin/python" -m uvicorn app.main:app --host "$HOST" --port "$PORT" "$@"
