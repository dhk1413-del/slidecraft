# SlideCraft 工作台 —— 仓库约定（coding agent 一律按这份来）

## 是什么

自托管「输入内容 → 一整套风格统一 PPT」的工作台。后端 FastAPI + SQLite(WAL)；前端 React 19 + TS + Tailwind v4（构建产物由后端托管）。
导出两类 PPTX：**图片版**（整页图铺底）与**原生可编辑版**（文本/形状/图表都是 PowerPoint 原生对象，PptxGenJS 生成）。

## 目录

| 路径 | 内容 |
|---|---|
| `server/app/` | `paths` `config` `db` `stylepacks` `providers` `render` `export_pptx` `pipeline` `main` |
| `server/pptx/render_native.mjs` | 原生可编辑 PPTX 渲染器（**唯一排版真源**） |
| `web/src/` | `pages/`（Wizard/Styles/Projects/Usage/Settings）、`components/`（`ProjectWorkbench` 等）、`hooks/`、`api.ts`、`types.ts` |
| `style-packs/` | 风格包（`styles/<名>/{style.md,prompt.md}`）与版式（`layouts/*.md`） |
| `ui-design/` | 设计令牌：**浅色为主**，底 `#F5F6FC`、白卡、主色 `#1E78FA` |
| `tools/` | `e2e_mvp.py`（零 key 端到端 34 项）、`test_native_render.py`、`test_vision_parse.py` |
| `docs/API.md` | 前后端接口契约（**改接口必须同步此文件**） |
| `config/providers.yaml` | 生图/文本/网络配置模板（key 由用户在设置页填，存 DB，不进仓库） |

## 铁律

1. **内容归 LLM、格式归代码**：渲染器与前端**不得写死业务文案**。任何文字与数值都必须来自该页真源（`title`/`outline`/`points`/`vision`）；取不到就少画一个元素，**不许编造**（含「项目 1/2/3」这类占位标签）。
2. **不伪造数据**：图表只画「视觉识别结果」或「要点原文里的同单位数值」；无可用数据时不画图表，并在页面上标注数据来源。
3. **零 key 可跑**：没有任何 API key 时，全流程走 `local_render` 本地兜底（成本 0），这条底线不能破。
4. 中文界面；数字用等宽 `num` 类；配色走 `ui-design/` 令牌（浅色为主）。
5. **不改** `web/dist/`（由 `npm run build` 生成）。**模型 key 红线（用户 2026-10-16 明确）**：
   key 只许待在 `.env`（已 gitignore）或数据库设置表里；**任何情况下都不许进入 git、更不许推到 GitHub**。
   禁止把 key 写进 `config/providers.yaml`（该文件入库，`api_key` 必须留空）、文档、截图或提交信息。
   新克隆先 `make hooks` 启用钩子；提交/推送由 `tools/check_no_secrets.py` 强制拦截（命中只报
   `文件:行号`，**不回显内容**），`make verify` / `make verify-fast` 已内置 `--head` 检查，`make guard` 可单独全历史体检。
   若发现历史上不慎提交过 key：**第一优先是撤销并轮换该 key**（改写历史要 force push，不擅自做）。
6. 提交前必须跑门禁并做对应验证；**GitHub 推送只在用户明确要求时做**（2026-10-20 明确：不主动 push），
   NAS 部署则按「同步到 NAS」自动执行。推送前确认远端与提交内容，别把 `data/`、`web/dist/` 带进去。

## 自检命令（每次改完都要跑，并把真实输出贴出来）

```bash
make verify        # 规范验收：17 套离线回归 + 前端构建 + 线上只读冒烟（一条命令，本仓无 pytest/CI）
make verify-fast   # 同上但跳过网络冒烟（不写库、不调模型、不花钱）
make lint          # 后端字节码编译 + 前端 tsc（改完随手跑）
make guard         # 密钥门禁：索引 + HEAD + 全历史（verify/verify-fast 已自动带 --head）
make hooks         # 新克隆启用 pre-commit / pre-push 密钥钩子（每个克隆执行一次）

# 需要单独跑某一套时：
#   .venv/bin/python tools/test_reskin_rebuild.py   # 换皮 B 口径（原文抽取/容量核算/重排）
#   .venv/bin/python tools/test_native_render.py    # 渲染器不得伪造内容与数据
#   .venv/bin/python tools/e2e_mvp.py               # 端到端（要求「零 key 状态」；已填 key 时口径不成立）
#     建议在隔离实例上跑（不碰正式库）：先 `DECKFORGE_DATA=/tmp/df-e2e PORT=8660 bash server/start-lan.sh`，
#     再 `DECKFORGE_DATA=/tmp/df-e2e DF_BASE=http://127.0.0.1:8660 .venv/bin/python tools/e2e_mvp.py`
#     覆盖：上传 → 梳理 → 页面确认 → **内容确认** → 生成(SSE) → **逐页核对** → 导出 → 账本（后两步是导出的硬前置）
```

## 发版流程

版本号**唯一真源**是仓库根 `VERSION`：发版只改这一处；`web/package.json` 的 `version`（npm 要求字面量）
与 `CHANGELOG.md` 首条由 `tools/check_version_sync.py` 强制对齐，`server/app/main.py` 直接读 `VERSION`
（`GET /api/health` 的 `version` 即它），门禁里也会拦「main.py 又写死版本号」。

```bash
# 1) 改版本号（唯一真源）+ 同步前端包版本 + 写 CHANGELOG 首条
#    VERSION / web/package.json / CHANGELOG.md
# 2) 发版前检查
make release-check        # 版本一致 + key 门禁（含全历史）
make verify-fast          # 离线回归，应当全绿；不绿就不要发版（含 m5/m6/m7 与 17 套工具）
# 3) 提交推送
git add -A && git commit -m "release: v$(cat VERSION)"
git -c http.proxy= -c https.proxy= push origin main     # 直连可用；失败再试 -c http.proxy=http://127.0.0.1:65532
# 4) 打附注标签（不可变）并推标签
git tag -a v$(cat VERSION) -m "SlideCraft v$(cat VERSION)"
git -c http.proxy= -c https.proxy= push origin --follow-tags
# 5) 建 Release：本机没装 gh，用网页 Releases → Draft a new release，说明粘 RELEASE_NOTES.md
```

规则：

- **tag 不可变**：发布过的 tag 不要移动或复用。打错了先删本地+远端再重打，并在发布说明里讲清楚。
- **Release 附件是公开可下载的**：只挂构建产物；**绝不挂 `.env`、数据库、`data/` 或任何含密钥/用户数据的文件**。
  `tools/check_no_secrets.py` 只管 git 对象，**管不到 Release 附件**，这一步只能靠人守。
- 版本语义（0.x 阶段）：修 bug → 补丁位；加功能 → 次版本位；改数据格式/配置且不兼容 → 次版本位并在
  CHANGELOG 写明迁移步骤。1.0 之前的版本号不承诺兼容。
- 分支策略：单人 0.x 阶段「直推 `main` + 打 tag」就够；等出现外部贡献者或多版本并行维护，再引入短生命
  周期功能分支与发布分支。**不要提前上 git-flow**。
- 许可证：AGPL-3.0（`LICENSE`）。改动依赖后要复核许可兼容（PyMuPDF 是 AGPL/商业双授权，是本项目选
  AGPL 的直接原因）。

## 环境

- 风格预览图：`style-packs/styles/<id>/previews/` 里放的就是各风格的真实样例页（随仓库公开）。
  若某台机器想用另一套图（例如不想公开的自制预览），放到同级的 `previews-local/`（已被 `.gitignore` 排除），服务端会**优先**用它：
  ```bash
  style_id=tech-deepblue
  mkdir -p "style-packs/styles/$style_id/previews-local/"
  cp /path/to/your/previews/* "style-packs/styles/$style_id/previews-local/"
  ```
- 服务常驻：bash server/start-lan.sh（:8641，脱离终端）；停：bash server/stop-daemon.sh
- **同步到 NAS（2026-10-20 起，自动执行）**：Mac 上的开发改动要**自动**同步到 NAS 虚拟机 `nas-ubutu-02`
  上的生产实例（用户 2026-10-20 明确：NAS 自动推送、GitHub 仅在明确要求时推送）。
  一条命令：`make sync-nas`（= `bash tools/sync_to_nas.sh`）——rsync 代码（**保留** VM 上的 `data/`、`.env`、
  `.venv/`、`node_modules/`）→ VM 上重建前端 → 重启 `slidecraft.service` → 校验 `/api/health`。
  默认目标 `root@nas-ubutu-02:/opt/slidecraft`，可用 `NAS_HOST` / `NAS_DIR` / `NAS_PORT` 覆盖；
  **每轮改完、跑完门禁后直接执行**，并在交付里贴出 VM 的版本与 health 结果。
  **安全闸**：VM 上有 `queued/running/cancelling` 作业或 headless page worker 时脚本会直接退出（不部署、不重启），
  避免打断正在跑的生成/转可编辑作业；确需强制覆盖用 `SYNC_FORCE=1 make sync-nas`。
- **agent 链自动安装（2026-10-22 起）**：`server/run.sh` 启动时会后台调用
  `tools/install_agent.sh --background`，自动装「图片转可编辑」需要的四件：Harness CLI（npm `@deepseek-ai/dsh`）、
  editppt CLI（`~/.editppt-venv`）、第三方 skill 仓库（`~/Documents/skills-repos/image-to-editable-ppt-skill`）、
  以及把 skill 链到 Harness 的 `~/.agents/skills/`。**幂等、尽力而为、失败不阻断启动**（零 key 主流程不受影响）。
  状态/日志：`data/logs/agent-install.status` / `agent-install.log`；`make install-agent` 手动重试，
  `make agent-status` 查看；`DECKFORGE_SKIP_AGENT_INSTALL=1` 整条跳过、`DECKFORGE_SKIP_HARNESS=1` 只跳过 Harness。
  npm 一律带可写 `--cache`（默认 `<repo>/.npm-cache`），避开 `~/.npm` 历史 root 属主导致的 EPERM。
  **Harness 登录仍需人工一次**（自助安装不代登录）；装好后 `GET /api/editable-engines` 应返回 `ok=true`。
- **多机 worker（2026-10-20 起）**：`editppt.remote_workers`（settings 里的 JSON 数组）可把「图片转可编辑」的 page worker
  派到装了 Harness 的辅助机，与平台本机 worker 一起并发。每项：
  `{"host","slots","workdir","dsh","profile","skill_dir","editppt_cli"}`，默认 workdir `/opt/editppt-workers`。
  辅助机前置：dsh headless + `image-to-editable-ppt` skill + editppt venv/config（生图 key、PaddleOCR token）、
  平台 → 辅助机 SSH 免密；派发时平台 rsync `pages/page_XXX/` 过去、远端 `dsh --profile headless` 重建、
  回收产物（路径改回本机）后由**平台** `run record`/`finalize` 做权威校验。远端不可用时不影响本机兜底。
  当前辅助机：`root@192.168.110.13`（nas-ubutu-04，2 槽）。`editppt.remote_workers=[]` 即回到单机。
- **重启的正确姿势（踩过坑，务必照做）**：改完后端代码后，用
  `bash server/stop-daemon.sh && bash server/start-lan.sh`；
  **绝对不要**在 exec/终端会话里前台起服务（`bash server/run.sh` 直接跑）——实测会话结束时进程会被一起带走，
  用户的网页随即打不开（ERR_CONNECTION_REFUSED）。重启后用
  `ps -o pid,ppid -p $(cat data/logs/deckforge.pid)` 确认 **PPID=1**，并
  `curl -s --noproxy '*' http://127.0.0.1:8641/api/health` 确认 `ok=true`。
- **看门狗（服务掉了自动拉起）**：`server/watchdog.sh` 每 60s 探活，健康检查非 200 就用**当前 HOST/PORT**（默认 127.0.0.1:8641）重新拉起；日志 `data/logs/watchdog.log`。
  启动（macOS 没有 `setsid`，用新会话 spawn，别用 `nohup ... &`，会话结束会被带走）：
  ```bash
  python3 - <<'PY'
  import os, subprocess
  subprocess.Popen(["bash", "server/watchdog.sh"], cwd=os.getcwd(), stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
  PY
  # 停：pkill -f 'server/watchdog.sh'
  ```
  实测：手动 `stop-daemon.sh` 后 30 秒内被自动拉起。
- **改代码的分工**：由当前 agent **直接改**（用户 2026-10-14 明确：不必再委派 Codex CLI）。
  改动前先读相关文件与契约，改完必须跑 `make lint` / `make verify-fast`，涉及界面还要实机验证（截图或 DOM 断言）再交付。
  （历史背景：Codex CLI 在 `~/.npm-global/bin/codex`，非交互用法需要 `--sandbox workspace-write`；
  但当前流程不再依赖它，仅当用户临时要求时才用。）
- **首次自检前先装依赖**：干净检出上直接跑 `make verify` 会因缺 `.venv` 与 `server/pptx/node_modules`
  出现失败。先执行一次 `bash server/start-lan.sh`（它经 `server/run.sh` 装 Python 依赖与 PptxGenJS），
  再跑自检；`tools/verify_all.py` 已会在缺依赖时打印这条提示。
- **远端仓库**：`https://github.com/dhk1413-del/slidecraft`（public）。原名 `deckforge`，2026-10 在 GitHub 改名，
  旧地址 301 跳转到新地址；本机 `origin` 已指向新地址，`main` 与 `origin/main` 同步。
  项目**显示名**是 SlideCraft，但 `DECKFORGE_*` 环境变量、`deckforge.db`、`deckforge.pid`、浏览器 localStorage 键
  一律**保持原名不动**（见 README「名称兼容」）——改名只改看得见的文案，动标识会丢用户数据。
- 代理：**7897 已失效**；`http://127.0.0.1:65532` 曾长期可用，但 **2026-10-19 实测已不转发**
  （TCP 能连、HTTPS 出站超时，git push 报 SSL_ERROR_SYSCALL / HTTP2 framing layer）。
  目前 **GitHub 直连可用**（实测 1 秒内 200）：推送先直连
  `git -c http.proxy= -c https.proxy= push origin main`，失败再试带代理。
- GitHub 推送凭据存在 macOS 钥匙串：`security find-generic-password -a dhk1413-del -s deckforge-github-token -w`
  （钥匙串条目名沿用了旧名，是登录凭据、与密钥红线无关；token 不落明文，撤销走 GitHub Settings → Applications）。
- `web/node_modules` 已存在，构建**不需要联网**
