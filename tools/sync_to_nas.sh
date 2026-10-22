#!/usr/bin/env bash
# 把本机（Mac）工作区同步到 NAS 虚拟机并重启服务。
#
# 用户 2026-10-20 要求：后面在 Mac 上开发的，都同步到 NAS。
# 默认目标 root@nas-ubutu-02:/opt/slidecraft，可用 NAS_HOST / NAS_DIR / NAS_PORT 覆盖。
#
# 保留 VM 上的运行数据（不会被 --delete 删掉）：
#   data/、.env、.venv/、web/node_modules/、server/pptx/node_modules/、.dep-stamp、.sync-commit
# 步骤：安全检查（有任务在跑就不重启）→ rsync → VM 上 npm build → systemctl restart → /api/health 校验。
set -euo pipefail

HOST="${NAS_HOST:-root@nas-ubutu-02}"
DIR="${NAS_DIR:-/opt/slidecraft}"
PORT="${NAS_PORT:-8641}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15)

echo "==> 目标：$HOST:$DIR"
"${SSH[@]}" "$HOST" "test -d '$DIR' && test -f '$DIR/VERSION'" \
  || { echo "连不上或目标目录不存在：$HOST:$DIR （检查 Tailscale / SSH）" >&2; exit 1; }

# 部署会重启服务：有任务在跑时先不部署，避免把正在跑的生成/转换作业打断。
BUSY_JSON="$("${SSH[@]}" "$HOST" bash -s -- "$DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
python3 - <<'PY'
import json, os, sqlite3
con = sqlite3.connect("data/deckforge.db")
active = con.execute("select count(*) from jobs where status in ('queued','running','cancelling')").fetchone()[0]
workers = 0
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        cmd = open("/proc/%s/cmdline" % pid, "rb").read().replace(b"\0", b" ").decode("utf-8", "ignore")
    except OSError:
        continue
    if "dsh" in cmd and "--profile" in cmd and "headless" in cmd:
        workers += 1
print(json.dumps({"active_jobs": active, "page_workers": workers}))
PY
REMOTE
)"
ACTIVE="$(printf '%s' "$BUSY_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["active_jobs"] + d["page_workers"])' 2>/dev/null || echo 0)"
if [ "${SYNC_FORCE:-0}" != "1" ] && [ "${ACTIVE:-0}" != "0" ]; then
  echo "==> VM 上有任务在跑（${BUSY_JSON} ），本次不部署、不重启，避免打断作业。" >&2
  echo "    等任务结束后重跑 make sync-nas；确实要强制覆盖用 SYNC_FORCE=1 make sync-nas" >&2
  exit 2
fi
echo "==> VM 空闲（无运行中任务）"

echo "==> 同步代码（保留 data/、.env、.venv、node_modules）"
rsync -az --delete --no-owner --no-group \
  --exclude='.git/' --exclude='.venv/' --exclude='.env' --exclude='.env.*' \
  --exclude='data/' --exclude='web/node_modules/' --exclude='web/dist/' \
  --exclude='server/pptx/node_modules/' --exclude='node_modules/' \
  --exclude='__pycache__/' --exclude='*.pyc' \
  --exclude='.dep-stamp' --exclude='.sync-commit' \
  --exclude='.DS_Store' --exclude='.pycache-lint/' --exclude='skill-output/' \
  "$ROOT/" "$HOST:$DIR/"

LOCAL_HEAD="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git -C "$ROOT" status --porcelain 2>/dev/null || true)"
STAMP="$LOCAL_HEAD"
[ -n "$DIRTY" ] && STAMP="$LOCAL_HEAD-dirty"

echo "==> 在 VM 上重建前端并重启服务（版本标记 ${STAMP}）"
"${SSH[@]}" "$HOST" bash -s -- "$DIR" "$PORT" "$STAMP" <<'REMOTE'
set -euo pipefail
DIR="$1"; PORT="$2"; STAMP="$3"
cd "$DIR"
npm --prefix web run build
systemctl restart slidecraft.service
sleep 2
systemctl is-active slidecraft.service
printf '%s (deployed %s)\n' "$STAMP" "$(date '+%F %T')" > .sync-commit
echo "VERSION=$(cat VERSION)"
curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/api/health"
echo
# 顺带自愈「图片转可编辑」agent 链（幂等；已就绪时秒回，缺件时后台补装，不阻塞部署）
if [ -f tools/install_agent.sh ]; then
  bash tools/install_agent.sh --background || true
fi
REMOTE

echo "==> 完成：$HOST 已更新"
