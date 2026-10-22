#!/usr/bin/env bash
# 自动安装「图片转可编辑」需要的 agent 链（默认 Harness）：
#   1. Harness CLI   —— npm 全局包 @deepseek-ai/dsh（page worker 的实际执行者）
#   2. skill 仓库    —— ningzimu/image-to-editable-ppt-skill（MIT，第三方）
#   3. editppt CLI   —— 在 ~/.editppt-venv 里 editable 安装上面仓库的 cli
#   4. Harness 技能目录 —— 把 skill 链到 ~/.agents/skills/image-to-editable-ppt
#
# 用法：
#   bash tools/install_agent.sh --check       只检查，不改机器（部署诊断/回归用）
#   bash tools/install_agent.sh --install     安装缺失项（幂等、尽力而为，失败不阻断启动）
#   bash tools/install_agent.sh --background  后台安装（server/run.sh 部署时用，立即返回）
#
# 由 server/run.sh 在启动时自动后台调用；也可 `make install-agent` 手动执行。
# 装不好不会影响「零 key 本地兜底」主流程：界面会如实显示缺哪一件，不会伪造可用。
#
# 可跳过 / 可覆盖（环境变量）：
#   DECKFORGE_SKIP_AGENT_INSTALL=1    完全不装（整条 agent 链）
#   DECKFORGE_SKIP_HARNESS=1          只跳过 Harness CLI
#   DECKFORGE_EDITPPT_VENV=...        默认 ~/.editppt-venv
#   DECKFORGE_SKILL_REPO=...          默认 ~/Documents/skills-repos/image-to-editable-ppt-skill
#   DECKFORGE_SKILL_DIR=...           默认 <SKILL_REPO>/skills/image-to-editable-ppt
#   DECKFORGE_AGENTS_SKILL_DIR=...    默认 ~/.agents/skills/image-to-editable-ppt
#   DECKFORGE_NPM_PREFIX=...          默认 ~/.npm-global
#   DECKFORGE_NPM_CACHE=...           默认 <repo>/.npm-cache（避开 ~/.npm 历史 root 属主的坑）
#   DECKFORGE_DSH_VERSION=...         默认 latest
#   DECKFORGE_SKILL_REPO_URL=...      默认 https://github.com/ningzimu/image-to-editable-ppt-skill.git
#   DECKFORGE_GIT_PROXY=...           可选，git clone 走的 http 代理
#   DECKFORGE_AGENT_INSTALL_TIMEOUT=  每步上限秒数，默认 900
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${DECKFORGE_AGENT_LOG_DIR:-$ROOT/data/logs}"   # 可用环境变量重定向（测试用）
LOG="$LOG_DIR/agent-install.log"
STATUS_FILE="$LOG_DIR/agent-install.status"
LOCK_DIR="$LOG_DIR/.agent-install.lock"
mkdir -p "$LOG_DIR"

EDITPPT_VENV="${DECKFORGE_EDITPPT_VENV:-$HOME/.editppt-venv}"
SKILL_REPO="${DECKFORGE_SKILL_REPO:-$HOME/Documents/skills-repos/image-to-editable-ppt-skill}"
SKILL_DIR="${DECKFORGE_SKILL_DIR:-$SKILL_REPO/skills/image-to-editable-ppt}"
AGENTS_SKILL="${DECKFORGE_AGENTS_SKILL_DIR:-$HOME/.agents/skills/image-to-editable-ppt}"
NPM_PREFIX="${DECKFORGE_NPM_PREFIX:-$HOME/.npm-global}"
NPM_CACHE="${DECKFORGE_NPM_CACHE:-$ROOT/.npm-cache}"
DSH_VERSION="${DECKFORGE_DSH_VERSION:-latest}"
SKILL_REPO_URL="${DECKFORGE_SKILL_REPO_URL:-https://github.com/ningzimu/image-to-editable-ppt-skill.git}"
STEP_TIMEOUT="${DECKFORGE_AGENT_INSTALL_TIMEOUT:-900}"

log()  { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
say()  { printf '%s\n' "$*"; }
has()  { command -v "$1" >/dev/null 2>&1; }

# 跨平台超时（macOS 没有 timeout 命令）
run_timeout() {
  local secs="$1"; shift
  if has python3; then
    python3 -c 'import subprocess,sys; sys.exit(subprocess.run(sys.argv[2:], timeout=float(sys.argv[1])).returncode)' "$secs" "$@"
  else
    "$@"
  fi
}

# ── 检查（返回 0=就绪）────────────────────────────────────────────────
check_harness_cli() {
  local cand
  has dsh && { HARNESS_CLI="$(command -v dsh)"; return 0; }
  for cand in "$NPM_PREFIX/bin/dsh" "$HOME/.npm-global/bin/dsh" /opt/homebrew/bin/dsh /usr/local/bin/dsh; do
    [ -x "$cand" ] && { HARNESS_CLI="$cand"; return 0; }
  done
  HARNESS_CLI="dsh（未安装）"
  return 1
}
check_skill_repo() {
  [ -f "$SKILL_DIR/SKILL.md" ] && return 0
  return 1
}
check_editppt_cli() {
  [ -x "$EDITPPT_VENV/bin/editppt" ] && return 0
  return 1
}
check_harness_skill() {
  [ -f "$AGENTS_SKILL/SKILL.md" ] && return 0
  return 1
}
check_harness_login() {
  [ -s "$HOME/.dsh/.credentials.yaml" ] && return 0
  return 1
}

write_status() {  # $1=overall 其余为 component=state
  local overall="$1"; shift
  {
    echo "time=$(date '+%F %T')"
    echo "overall=$overall"
    printf '%s\n' "$@"
  } > "$STATUS_FILE" 2>/dev/null || true
}

finish_status() {  # 无论正常结束还是异常中止，都保证锁释放、状态不卡在 running
  rmdir "$LOCK_DIR" 2>/dev/null || true
  if [ -f "$STATUS_FILE" ] && grep -q '^overall=running$' "$STATUS_FILE" 2>/dev/null; then
    write_status partial note=aborted
  fi
}

print_check() {
  local ok=1
  say "[install-agent] 检查 agent 链（图片转可编辑）"

  if check_editppt_cli; then say "  editppt_cli    ok       $EDITPPT_VENV/bin/editppt"; else
    say "  editppt_cli    missing  $EDITPPT_VENV/bin/editppt"; ok=0; fi
  if check_skill_repo; then say "  skill_repo     ok       $SKILL_DIR"; else
    say "  skill_repo     missing  $SKILL_DIR"; ok=0; fi
  if check_harness_skill; then say "  harness_skill  ok       $AGENTS_SKILL"; else
    say "  harness_skill  missing  $AGENTS_SKILL"; ok=0; fi
  if check_harness_cli; then
    local ver; ver="$(run_timeout 20 "$HARNESS_CLI" --version 2>/dev/null | head -1)"
    say "  harness_cli    ok       $HARNESS_CLI${ver:+ ($ver)}"
  else
    say "  harness_cli    missing  npm 包 @deepseek-ai/dsh 未安装"; ok=0
  fi
  if check_harness_login; then say "  harness_login  ok       ~/.dsh/.credentials.yaml"; else
    say "  harness_login  missing  需在本机登录一次 Harness（安装器不代登录）"; fi

  if [ "$ok" = "1" ]; then say "  overall        ok"; else say "  overall        missing"; fi
  return $((1 - ok))
}

# ── 安装 ──────────────────────────────────────────────────────────────
install_harness_cli() {
  if check_harness_cli; then log "harness_cli: 已安装，跳过（${HARNESS_CLI}）"; return 0; fi
  if [ "${DECKFORGE_SKIP_HARNESS:-0}" = "1" ]; then log "harness_cli: DECKFORGE_SKIP_HARNESS=1，跳过"; return 2; fi
  if ! has npm; then log "harness_cli: 找不到 npm（需要 Node.js 22+），跳过"; return 1; fi
  log "harness_cli: npm install -g @deepseek-ai/dsh@${DSH_VERSION}（prefix=${NPM_PREFIX}）"
  mkdir -p "$NPM_PREFIX" "$NPM_CACHE"
  # --cache 必须显式给：~/.npm 可能有历史 root 属主文件，默认缓存会 EPERM。
  if run_timeout "$STEP_TIMEOUT" npm install -g --prefix "$NPM_PREFIX" --cache "$NPM_CACHE" \
       --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION" >>"$LOG" 2>&1; then
    if check_harness_cli; then
      log "harness_cli: 安装成功 → $HARNESS_CLI"
      case ":$PATH:" in
        *":$NPM_PREFIX/bin:"*) : ;;
        *) log "harness_cli: 提示 —— 把 $NPM_PREFIX/bin 加进 PATH，或直接用绝对路径（平台会自动探测该路径）" ;;
      esac
      return 0
    fi
  fi
  log "harness_cli: 安装失败（详见 ${LOG}）"
  return 1
}

install_skill_repo() {
  if check_skill_repo; then log "skill_repo: 已存在，跳过（${SKILL_DIR}）"; return 0; fi
  if ! has git; then log "skill_repo: 找不到 git，跳过"; return 1; fi
  mkdir -p "$(dirname "$SKILL_REPO")"
  log "skill_repo: git clone --depth 1 $SKILL_REPO_URL"
  local -a extra=()
  [ -n "${DECKFORGE_GIT_PROXY:-}" ] && extra=(-c "http.proxy=$DECKFORGE_GIT_PROXY" -c "https.proxy=$DECKFORGE_GIT_PROXY")
  if run_timeout "$STEP_TIMEOUT" git ${extra[@]+"${extra[@]}"} clone --depth 1 "$SKILL_REPO_URL" "$SKILL_REPO" >>"$LOG" 2>&1 \
     && check_skill_repo; then
    log "skill_repo: 安装成功 → $SKILL_DIR"
    return 0
  fi
  log "skill_repo: 安装失败（详见 ${LOG}；国内网络可设 DECKFORGE_GIT_PROXY）"
  return 1
}

install_editppt_cli() {
  if check_editppt_cli; then log "editppt_cli: 已安装，跳过（${EDITPPT_VENV}）"; return 0; fi
  if ! check_skill_repo; then log "editppt_cli: 缺 skill 仓库，跳过（先装 skill_repo）"; return 1; fi
  local py=""
  for cand in python3.12 python3.11 python3.10 python3; do
    if has "$cand" && "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then py="$cand"; break; fi
  done
  if [ -z "$py" ]; then log "editppt_cli: 需要 Python >=3.10，没找到可用的 python3，跳过"; return 1; fi
  log "editppt_cli: 用 $py 创建 $EDITPPT_VENV 并安装 $SKILL_DIR/cli"
  if ! run_timeout "$STEP_TIMEOUT" "$py" -m venv "$EDITPPT_VENV" >>"$LOG" 2>&1; then
    log "editppt_cli: 创建 venv 失败（详见 ${LOG}）"; return 1
  fi
  run_timeout "$STEP_TIMEOUT" "$EDITPPT_VENV/bin/pip" install -q --upgrade pip >>"$LOG" 2>&1 || true
  if run_timeout "$STEP_TIMEOUT" "$EDITPPT_VENV/bin/pip" install -q -e "$SKILL_DIR/cli" >>"$LOG" 2>&1 \
     && check_editppt_cli; then
    log "editppt_cli: 安装成功 → $EDITPPT_VENV/bin/editppt"
    return 0
  fi
  log "editppt_cli: 安装失败（详见 ${LOG}）"
  return 1
}

install_harness_skill() {
  if check_harness_skill; then log "harness_skill: 已存在，跳过（${AGENTS_SKILL}）"; return 0; fi
  if ! check_skill_repo; then log "harness_skill: 缺 skill 仓库，跳过"; return 1; fi
  mkdir -p "$(dirname "$AGENTS_SKILL")"
  if [ -e "$AGENTS_SKILL" ]; then
    log "harness_skill: 目标已存在但不是 skill（缺 SKILL.md），不覆盖：$AGENTS_SKILL"; return 1
  fi
  if ln -s "$SKILL_DIR" "$AGENTS_SKILL" 2>/dev/null || cp -R "$SKILL_DIR" "$AGENTS_SKILL" 2>/dev/null; then
    if check_harness_skill; then log "harness_skill: 已链接 → $AGENTS_SKILL"; return 0; fi
  fi
  log "harness_skill: 链接失败（详见 ${LOG}）"
  return 1
}

do_install() {
  if [ "${DECKFORGE_SKIP_AGENT_INSTALL:-0}" = "1" ]; then
    say "[install-agent] DECKFORGE_SKIP_AGENT_INSTALL=1，整条 agent 链跳过。"
    write_status skipped editppt_cli=skipped skill_repo=skipped harness_skill=skipped harness_cli=skipped
    return 0
  fi
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    say "[install-agent] 已有安装进程在跑，本次跳过。"
    return 0
  fi
  trap 'finish_status' EXIT
  write_status running

  local results=()
  local name state
  for name in harness_cli skill_repo editppt_cli harness_skill; do
    "install_$name" >>"$LOG" 2>&1
    case $? in
      0) state=ok ;;
      2) state=skipped ;;
      *) state=failed ;;
    esac
    results+=("$name=$state")
    say "[install-agent] $name: $state"
  done

  local overall=ok
  case " ${results[*]} " in *"=failed"*) overall=partial ;; esac
  case " ${results[*]} " in *"=skipped"*) [ "$overall" = "ok" ] && overall=partial ;; esac
  # 只有「全就绪」或「全跳过」才算 ok
  if check_editppt_cli && check_skill_repo && check_harness_skill && check_harness_cli; then overall=ok; fi
  write_status "$overall" ${results[@]+"${results[@]}"}
  say "[install-agent] 结果：${overall}（日志 ${LOG}）"
  if check_harness_login; then
    say "[install-agent] Harness 已登录 ✓"
  else
    say "[install-agent] 提示：Harness 需在本机登录一次（安装器不代登录），否则 page worker 会因无模型凭据失败。"
  fi
  bash "$ROOT/tools/install_agent.sh" --check || true
  return 0
}

background_install() {
  if [ "${DECKFORGE_SKIP_AGENT_INSTALL:-0}" = "1" ]; then say "[install-agent] 已跳过（DECKFORGE_SKIP_AGENT_INSTALL=1）"; return 0; fi
  if check_editppt_cli && check_skill_repo && check_harness_skill && check_harness_cli; then
    say "[install-agent] agent 链已就绪，无需安装。"; return 0
  fi
  # 用独立 session 脱离调用方（服务重启/终端关闭不影响安装）
  python3 - "$ROOT" "$LOG" <<'PY' 2>/dev/null || { log "background: 启动失败"; return 0; }
import os, subprocess, sys
root, log_path = sys.argv[1], sys.argv[2]
subprocess.Popen(["bash", os.path.join(root, "tools", "install_agent.sh"), "--install"],
                 cwd=root, stdin=subprocess.DEVNULL,
                 stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
                 start_new_session=True)
PY
  say "[install-agent] 已在后台开始安装（日志 ${LOG}）"
  return 0
}

case "${1:---check}" in
  --check)      print_check ;;
  --strict)     print_check ;;
  --install)    do_install ;;
  --background) background_install ;;
  -h|--help)    sed -n '2,30p' "$0" ;;
  *)            say "用法：bash tools/install_agent.sh [--check|--install|--background]"; exit 2 ;;
esac
