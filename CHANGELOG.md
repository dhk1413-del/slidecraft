# 变更记录

本文件记录 SlideCraft 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

版本号**唯一真源**是仓库根的 [`VERSION`](VERSION) 文件：发版只改这一处，`web/package.json` 由
`tools/check_version_sync.py` 在门禁里强制对齐，`server/app/main.py` 直接读该文件（`/api/health` 可查）。
发版流程见 [AGENTS.md](AGENTS.md#发版流程)。

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
