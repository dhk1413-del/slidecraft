# 变更记录

本文件记录 SlideCraft 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

版本号**唯一真源**是仓库根的 [`VERSION`](VERSION) 文件：发版只改这一处，`web/package.json` 由
`tools/check_version_sync.py` 在门禁里强制对齐，`server/app/main.py` 直接读该文件（`/api/health` 可查）。
发版流程见 [AGENTS.md](AGENTS.md#发版流程)。

## [0.6.0] - 2026-10-25

### 新增

- **内容梳理支持「删除此页」**：页面标题栏新增删除按钮，带确认弹窗与 **10 秒撤销**；删除后页码自动前移，
  至少保留 1 页。新增 `DELETE /api/projects/{pid}/slides/{slide_id}`（返回删除前的完整快照）与
  `POST /api/projects/{pid}/slides/restore`（按快照重建并放回原页码），已同步到 [`docs/API.md`](docs/API.md)。
  新增离线回归 `test_slide_delete`。

### 修复

- **编辑大纲与内容梳理不同步**：大纲里改的标题 / 摘要 / 原文不会同步到内容梳理——现在保存大纲会按页写入
  slides 并保留既有内容；新增回归 `test_outline_sync`。
- **编辑大纲里新增/删除页面不同步**：现在会做一次页面对账（新增/删除/重排页码），并同步到内容梳理与后续步骤；
  新增回归 `test_pages_reconcile`。
- **图片转可编辑多机 worker 丢掉平台约束**：远端原先直接把 skill 的 worker prompt 当提示，漏掉「先加载 skill /
  文字真源 / token 纪律」，实测远端页 token 高 3–6 倍；改为用平台包装提示（落 `platform-prompt.txt`），
  并排除回传污染。`test_editppt_engine` 补对应断言（66 项）。

### 升级

- **无新增 Python / Node 依赖**；`data/` 与 `DECKFORGE_*` 变量保持不变，替换代码后重启即可。
- 无数据迁移：删除页是真实删除（10 秒撤销窗口），撤销会以新 `slide_id` 重建该页。

## [0.5.0] - 2026-10-22

### 新增

- **未接模型引导**：不接模型也能进页面、上传和梳理内容；点「生成 / 转可编辑」时先弹引导——
  「去配置密钥」（跳设置页）或**显式选择**「先用本地演示」（`local_render`，费用 0、不代表真实设计）。
  引擎不可用时在页面上说明缺件与修法（`make install-agent` / Harness 登录一次）。提示条可「稍后」关闭。
- **部署自动安装 agent 链**：首次启动后台自动装「图片转可编辑」需要的四件——Harness CLI（npm `@deepseek-ai/dsh`）、
  editppt CLI、第三方 skill 仓库、以及把 skill 链进 Harness 技能目录。幂等、尽力而为、失败不阻断启动；
  `make install-agent` 手动重试、`make agent-status` 查看，`DECKFORGE_SKIP_AGENT_INSTALL=1` 可整条跳过。
  NAS 部署完成后也会顺带自愈同一套链。新增离线回归 `test_install_agent`（17 项）。
- **备注逐页复核显示 PPT 实际页面**：新增 `POST /api/notes/{nid}/render`（LibreOffice → PDF → PyMuPDF 逐页 PNG，
  幂等、按作业串行、磁盘缓存）；前端进入第②步按需自动渲染，预览区显示真实页面（可点开原图），
  渲染中提示、失败可重试并回退文字。
- **视觉识别复用 GuaiHub key**：只配了 GuaiHub 中转 key 的机器，备注识别 / 风格构建 / 图片重建也能做视觉识别
  （默认 `gemini-2.5-flash`，New API 兼容 `/chat/completions`）；单独填视觉 key 仍优先，返回 `fallback` 标记，
  设置页显示「复用 GuaiHub key」。新增离线回归 `test_vision_config`（24 项）。

### 变更

- **零 key 兜底改为「界面必须显式选择」**：接口层仍保留 `local_render` 兜底（`tools/e2e_mvp.py` 零 key 基线依赖它），
  但界面不再静默降级——必须经过引导并明确选择「先用本地演示」才会走兜底（用户 2026-10-22 要求）。

### 修复

- 备注生成在「只配了 GuaiHub、没单独配视觉 key」的机器上图片页必然失败（旧任务整批 failed）的问题。
- 逐页复核只能看提取文字、看不到上传 PPT 原页面的问题。
- 自动安装器在 macOS 自带 bash 3.2 下的两处兼容性问题（空数组展开、变量紧跟中文导致的非法变量名）。

### 升级

- **无新增 Python / Node 依赖**；`data/` 与 `DECKFORGE_*` 变量保持不变，替换代码后重启即可。
- 首次启动会在**后台**自动安装 agent 链（约 2–4 分钟，需联网）；不需要可用 `DECKFORGE_SKIP_AGENT_INSTALL=1` 跳过。
- 只配了 GuaiHub key 的机器：视觉识别会自动复用该 key，可在设置页覆盖模型名。

## [0.4.0] - 2026-10-21

### 新增

- **多机 page worker**：「图片转可编辑」的 page worker 可派到装了 Harness 的辅助机，与本机 worker 按槽位
  一起并发（settings `editppt.remote_workers`，JSON 数组；每项 `host/slots/workdir/dsh/profile/skill_dir/editppt_cli`）。
  派发时 rsync 页面目录过去、远端 `dsh --profile headless` 重建、回收产物并改写回本机路径，
  由**平台**统一 `run record`/`finalize` 做权威校验；远端不可用不影响本机兜底。默认关闭（`[]` 即单机）。
- **NAS 自动部署**：新增 `make sync-nas`（`tools/sync_to_nas.sh`）——rsync 代码到 NAS 生产实例
  （保留 VM 的 `data/`、`.env`、`.venv`、`node_modules`）→ VM 上重建前端 → 重启 `slidecraft.service`
  → 校验 `/api/health`。**安全闸**：VM 上有 `queued/running/cancelling` 作业或 headless page worker 时
  拒绝部署/重启（`SYNC_FORCE=1` 可强制），避免打断正在跑的生成或转换。
- **图片转可编辑独立流程完善**：②「选择页面」可全选/逐页勾选；③「转换结果」展示转换进度
  （缩略图状态浮层、逐页结果、停止/继续/下载）。从结果页进入时先到选页步。
- **生成结果页新增「生成全部页面」**：一次性提交全部参与页；底栏新增「下载图片集 PPT」「转可编辑 PPT」。
- **备注**：历史任务新增「查看」，可回到之前的任务查看已生成的备注；「选择生成方式」改为两个按钮并标注区别。
- **GET 自动重试**：服务重启或短暂断网时，GET 请求自动重试 3 次（指数退避）；写请求不重试，避免重复提交。

### 变更

- 生成页面去掉「生成结果 / 按图片版重建」页签，改为底栏按钮直达。
- 首页去掉三段说明文字；美化上传页去掉底部重复的格式提示。
- 结果页去掉成本展示。

### 修复

- 修复同一项目可同时提交多个「图片转可编辑」任务、并发写同一份现场的问题：现在会明确提示
  「该项目已有转换任务在跑，请等它结束或先停止后再提交」。

### 升级

- **无新增 Python / Node 依赖**；`data/` 与 `DECKFORGE_*` 变量保持不变，替换代码后重启即可。
- 多机 worker 默认关闭；需要时在设置里写 `editppt.remote_workers` JSON 数组，辅助机前置条件见 `AGENTS.md`。
- NAS 部署可选：`make sync-nas`，目标可用 `NAS_HOST` / `NAS_DIR` / `NAS_PORT` 覆盖。

## [0.3.0] - 2026-10-19

### 新增

- **图片转可编辑改为独立三步流程**：`#/editable/{id}`（① 上传内容 → ② 页面确认 → ③ 转换结果），
  不再套用生成向导的 5/6 步；第③步可选页、开始/停止/继续、下载（新增 `EditableFlowPage`）。
  项目列表里 `flow=editable` 的项目也恢复到这 3 步。
- **PPT 美化：转可编辑独立成第⑥步**，带进度、逐页状态、停止与下载。
- **上传上限 60MB → 200MB**：后端改为**流式落盘 + 字节校验**，不再整块读进内存；
  可按机器用 `DECKFORGE_MAX_UPLOAD_MB` 调整。
- **首页与品牌**：首页按参考版式改造（居中大标题 + 白色功能卡、上传框高度压缩），标题改为品牌名；
  品牌标重做（叠页 + 星芒 logo）并补 favicon（`BrandMark.tsx`、`web/public/favicon.svg`）。
- **6 套风格内容页预览重建**：版心留白 ≥7%、字号收敛，换掉此前由 PDF 复刻导致的坏图。
- 美化状态返回**并发上限**，面板如实提示分批处理。

### 变更

- **可编辑 PPTX 统一走 editppt 精细重建**，下线旧 PptxGenJS 原生导出：
  `/api/projects/{pid}/export-preview` 的 `kind` 只接受 `image`（`native` → 400），
  `pipeline.do_export(pid,'editable')` 同样下线；可编辑版请走「图片转可编辑」的 `kind=editable_hi`。
- 图片转可编辑与**单页重生成**不再弹报价确认框（报价仍走服务端，保证幂等与可审计）。
- 工作台移除「原稿 / 内容真源 + 原文数值核对清单」面板，结果页聚焦按页查看。
- 图片转可编辑结果页改为**左侧页列表 + 右侧预览**。
- 去掉多处技术性说明、徽标与元信息（首页、向导顶栏、选择风格页、生成页、转换结果页等）。

### 修复

- 修复局域网 HTTP 环境下 `crypto.randomUUID` 不可用导致提交失败。
- 修复转换进度提示卡被压成竖条（`max-w-md` 在设计令牌里等于 16px）。
- 修复错误面板在没有 HTTP 状态码时显示 `HTTP —`（改为「客户端错误」）。
- 精细重建 worker 在校验通过且产物稳定后主动结束收尾进程，避免残留。

### 文档

- 用户手册整体重写：10 张新截图 + 六步流程图，同步更新 Markdown / HTML / Word / PDF 与手册 zip。
- `AGENTS.md` 更新网络说明：代理 `65532` 实测已不转发，GitHub 直连当前可用。

### 升级

- **无新增 Python / Node 依赖**；`data/` 与 `DECKFORGE_*` 变量保持不变，替换代码后重启即可。
- **接口行为变更**：`export-preview` 的 `kind=native` 已下线（详见 [`docs/API.md`](docs/API.md)）。
- 上传上限默认 200MB；机器内存紧张时用 `DECKFORGE_MAX_UPLOAD_MB` 调小。

## [0.2.0] - 2026-10-17

### 新增

- **用量页接入供应商面板**：新增 `GET /api/provider-usage`，按 New API 兼容计费接口读取面板侧的
  「累计已用额度 + 额度上限」，按面板汇率折算人民币，并与上次成功快照做**差额**；
  服务端缓存 60 秒（`refresh=1` 绕过）。面板接口忽略日期区间、只给累计值，所以口径明确标注为
  「累计 + 与上次快照的差额」；**key 绝不出现在响应与日志**。新增离线回归
  `tools/test_provider_usage.py`（计费/币种折算/快照增量/缓存/脱敏），已挂进 `make verify`。
- **PPT 美化**：多页并发生成（上限 3 → 8）；新增「优化本页」（单页重生成可带修改要求，最长 400 字）
  与**页级历史版本**（每页最多 5 个，可回滚；回滚前自动归档当前图，因此可再切回）。
- **图片转可编辑**：接入 `image-to-editable-ppt` 的新状态机（`run next --json` 决策 + 并发 dispatch），
  默认 **2 页并发**（`editppt.max_concurrent_pages` 可配，skill 上限 6）；page worker 改用 Harness headless
  （`editppt.agent` 可切回 hermes）；新增无文字真源时的**离线 OCR 兜底** `server/pptx/editppt_ocr.py`
  （优先 skill 的 PaddleOCR hints，其次本机 RapidOCR）；失败保留已完成页与现场，可续跑。
- **首页**：风格库改为独立区块（标题 / 分类筛选 / 全部风格 / 4 列），「文档导入生成」下方直接展示风格模板并带进向导。
- **风格构建**：上传区支持截图直接粘贴上传（⌘V / Ctrl+V）。
- **风格库**：模板在「图片转可编辑」「PPT 美化」下也显示；双蓝绿 / 双蓝橙预览图整备
  （双蓝绿换成重新生成的 5 张统一风格样例图）。

### 变更

- 「转换与导出」模块整体移除（前端 `ExportPanel` 删除）。
- 移除 Codex 引擎：`server/app/codex_engine.py` 删除，`/api/codex-engine` 端点移除；
  美化状态字段 `codex` → `editable_engine`（[`docs/API.md`](docs/API.md) 已同步）。
- 向导顶栏卡片紧凑化（315px → 149px）；步骤条去掉锁定原因小字；大纲生成卡片改 16:9；
  大纲编辑弹窗「本页原文」输入框加大（顺带修掉所有文本域被压成 40px 的根因）；
  生成方式切换时功能框尺寸不再跳动。
- 图片转可编辑把「确认设计 → 生成页面」做成真门禁。

### 修复

- **回归测试口径**：m5 / m7 仍按 5 步时代断言 `resume_step=5`，而实现自 08d2d66「6 步流程」起已改为 6
  （⑥=生成页面）。已按当前 6 步口径修正测试——`make verify-fast` 据此**首次全绿**
  （此前 m5 一直失败并挡住 m6/m7，实际 m7 也有一处同类失败）。
- 修复风格卡「查看」灯箱一直闪（portal 到 body，逃出卡片 hover transform 的包含块）。

### 升级

- **无新增 Python / Node 依赖**，`data/` 与 `DECKFORGE_*` 变量保持不变，替换代码后重启即可。
- 离线 OCR 为可选项：需在 editppt 的 venv 里装 RapidOCR（未装时会跳过该兜底并如实提示，不影响主流程）。

## [0.1.0] - 2026-10-16

首个公开版本。

### 新增

- **四条主线**：文档生成（Markdown / TXT / DOCX / PDF / PPTX → 整套 PPT）、PPT 美化、图片转可编辑、讲稿备注。
- **两种导出**：图片版 PPTX（整页图铺底）与原生可编辑 PPTX（文本/形状/图表都是 PowerPoint 原生对象）。
- **零密钥可跑**：没有任何 API key 时，大纲走本地规则切页、出图走本地兜底渲染，成本 0，流程与导出都能走通。
- **风格库与风格构建**：上传模板/参考图 → 证据分层 → 令牌合成，落盘后即在风格库可见。
- **文档生成 6 步流程** + 章节式「编辑大纲」编辑器（DeepSeek 产出章节）。
- **我的项目页**：项目类别（PPT生成 / PPT美化 / 图片转可编辑 / 备注生成），封面可点进入项目。
- **零依赖单文件版** `slidecraft-standalone.html`：双击离线可用，数据存在浏览器里。

### 变更

- 项目显示名统一为 **SlideCraft**（原 DeckForge）。为保留既有项目与草稿，`DECKFORGE_*` 环境变量、
  `deckforge.db`、`deckforge.pid` 与浏览器存储键**刻意保持原名**，老数据无需迁移或清空。
- 仓库地址为 <https://github.com/dhk1413-del/slidecraft>（旧地址 301 跳转）。
- 上传上限 30MB → 60MB，并把上限收敛成一处常量。
- 版本号收敛为仓库根 `VERSION` 单一真源（此前 `main.py` 与 `package.json` 各写一份，容易漏改）。

### 修复

- 修复删除项目报错、删除弹窗被压成竖排（Tailwind `max-w-md` 解析问题）、步骤条窄屏折行。
- 修复前端 HTML 被浏览器缓存（改完仍看到旧界面）。
- 修复首次启动时依赖尚未装完就误报「启动失败」。
- 勾选「保留原图」的页面，原 PPT 里的图片按坐标原样贴回（不删不换）。

### 安全

- 新增密钥门禁：`tools/check_no_secrets.py`（路径 + 密钥形态 + 本机真实 key 真值三层）+ `pre-commit` /
  `pre-push` 钩子，模型 API key **绝不入库、绝不上传**；`.gitignore` 同步加固。
- 仓库历史与 GitHub 远端经全量扫描确认不含任何密钥。

### 许可证

- 以 **AGPL-3.0** 发布（`LICENSE`）。注意：依赖 PyMuPDF 本身是 AGPL-3.0 / 商业双授权，选 MIT 也无法规避
  其义务；详见 [README「许可证」](README.md#许可证)。

### 已知问题

- 内部回归 `server/tests/test_m5.py::test_interruption_is_terminal_and_reentrant` 目前失败
  （`resume_step` 期望 5、实际 6）。该失败在打本标签之前就已存在（干净检出可复现），尚未修复；
  其余 16 项离线检查与前端构建均通过。
  → **已在 [0.2.0] 修复**：属测试断言过时（实现自 6 步流程起就是 6），不是产品缺陷。
