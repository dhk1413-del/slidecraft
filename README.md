# SlideCraft

自托管的 PPT 生成工作台。上传 Markdown、TXT、DOCX、PDF 或 PPTX（也可以直接粘贴文本），
它会梳理页面、按选定风格逐页出图，最后导出图片版 PPTX 或原生可编辑 PPTX。

没有配置任何模型密钥时，大纲走本地规则切页、出图走本地兜底渲染，费用为 0，流程和导出都能走通。

当前版本 **v0.3.0** —— 仓库：<https://github.com/dhk1413-del/slidecraft> ·
版本发布页（下载 / 变更说明）：<https://github.com/dhk1413-del/slidecraft/releases> ·
变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。

## 安装

支持 macOS 和 Windows 原生安装。三种方式任选一种：

1. **DeepSeek Harness 帮装**：从 [DeepSeek 官方页面](https://www.deepseek.com/zh/harness/) 获取工具，在新会话里粘贴 [安装要求](docs/使用说明.md#1-用-ai-助手帮你安装)。
2. **WorkBuddy 帮装**：从 [腾讯官方下载页](https://www.codebuddy.cn/downloads/) 获取 WorkBuddy，使用同一段安装要求，让它完成下载、安装和启动。
3. **手动安装**：先准备 Python（推荐 3.12）、Node.js 22 系列最新版（至少 22.12）、Git；处理 PPTX 还需 LibreOffice。Windows 使用 PowerShell，详细步骤见 [手动安装](docs/使用说明.md#2-手动安装)。

macOS：

```bash
git clone https://github.com/dhk1413-del/slidecraft.git
cd slidecraft
npm --prefix web install
npm --prefix web run build
bash server/start-lan.sh
```

macOS 首次启动会自动安装其余依赖。Windows 按使用说明中的 PowerShell 命令安装依赖、构建前端并启动，无需 Ubuntu 或 WSL。

启动后打开 **http://127.0.0.1:8641**。Windows 运行时保持 PowerShell 窗口打开，按 Ctrl+C 停止。

[图文使用说明](docs/使用说明.md) · [PDF](docs/使用说明.pdf) · [Word](docs/使用说明.docx) · [HTML 阅读版](docs/使用说明.html) · [Markdown 配图包](docs/SlideCraft-使用手册-Markdown.zip)

## 能做什么

| 流程 | 输入 | 产出 |
|---|---|---|
| 文档导入生成 | Markdown / TXT / DOCX / PDF / PPTX / 粘贴文本 | 整套 PPT，图片版和原生可编辑版 |
| PPT 美化 | 已有的 .pptx / .pdf | 逐页生图（图生图或重新设计）→ 图片集 PPT 和可编辑版 |
| 图片转可编辑 | PDF / 图片 / PPTX | 独立三步：上传内容 → 页面确认 → 转换结果； 用第三方 skill 把页内**文字/图片/图形/背景分别拆分**：文字→文本框、图片与图标→资产表分离成透明 PNG、卡片线条箭头→原生形状、背景→clean base；约 6–13 分钟/页、默认 2 页并发；无文字真源时用离线 RapidOCR 补文字（可选 PaddleOCR-VL） |
| PPT 备注 | 已有的 .pptx | 逐页演讲者备注，写回备注栏，不动页面内容 |

另外还有风格库（7 套内置风格，也可以从样本实测生成）、我的项目（点进去回到上次的步骤）、用量账本和设置页。
用量页除了本机账本，还会直连供应商面板（New API 兼容，如 GuaiHub）读**面板侧累计已用额度**并对账；
面板接口只给累计值、不按日期过滤，所以只展示「累计 + 与上次快照的差额」，详见 `docs/API.md` §6。

## 界面

截图来自当前系统的隔离演示实例，原始视口截图为 **3840×2160**。
文档生成使用零密钥本地渲染；美化截图显示“已用原图”；转换和备注展示准备状态。

| 首页 | 页面确认 |
|---|---|
| ![首页](docs/screenshots/current/01-home.png) | ![页面确认](docs/screenshots/current/02-pages.png) |

| 生成结果 | 风格选择 |
|---|---|
| ![生成结果](docs/screenshots/current/05-result.png) | ![风格选择](docs/screenshots/current/04-style.png) |

| PPT 美化预览 | 演讲备注 |
|---|---|
| ![美化预览 使用原图](docs/screenshots/current/07-beautify.png) | ![备注工作台 准备状态](docs/screenshots/current/09-notes.png) |

[高清系统截图](docs/screenshots/current/) · [ImageGen 功能图解](docs/illustrations/)

## 架构

![系统架构](docs/diagrams/architecture.svg)

后端 FastAPI + SQLite(WAL)，前端 React 19 + TypeScript + Tailwind v4，构建产物由后端托管。
仓库里还有一个零依赖的单文件版本 `slidecraft-standalone.html`，双击就能离线用，数据存在浏览器里。

## 配置模型

在「系统设置」页填密钥即可，保存后立即生效，密钥存在本机数据库，不进仓库。
也可以用 `config/.env`（模板见 `config/.env.example`）。

| 用途 | 默认 | 没配密钥时 |
|---|---|---|
| 生图 | GuaiHub 或阿里百炼 | 本地兜底渲染，费用 0 |
| 文本 | DeepSeek | 本地规则切页，或提示未配置 |
| 视觉 | 阿里百炼 Qwen-VL，可指向任意 OpenAI 兼容端点 | 本地色板和插画分析 |

生图单价留空时账本金额记 0，界面会说明这不代表免费。

## 命令

第一次跑自检前先执行一次 `bash server/start-lan.sh`：它会装好 Python 依赖与 `server/pptx` 的
PptxGenJS（原生可编辑导出要用），否则相关用例会失败。`tools/verify_all.py` 检测到缺依赖时也会提示。

```bash
bash server/start-lan.sh        # 启动（脱离终端常驻）
bash server/stop-daemon.sh      # 停止
make verify                     # 14 套离线回归 + 前端构建 + 线上只读冒烟
make verify-fast                # 不联网、不调模型、不花钱
make lint                       # 后端编译 + 前端 tsc
```

局域网访问用 `HOST=0.0.0.0 PORT=8641 bash server/start-lan.sh`。服务没有登录鉴权，只在可信网络里用。

## 目录

```
VERSION          版本号唯一真源（发版只改这里，门禁校验其余各处一致）
CHANGELOG.md     变更记录（发版时必须写首条）
LICENSE          AGPL-3.0 全文
server/app/      FastAPI 后端：路由、流水线、渲染、导出、风格包、美化、备注、风格构建
server/pptx/     原生可编辑 PPTX 渲染器（PptxGenJS），排版真源
web/src/         React 前端
style-packs/     风格包与版式定义
ui-design/       设计令牌与组件规范
tools/           离线回归、端到端验收、流程图生成、文档转换
docs/            使用说明、API 契约、验收记录、截图、流程图
config/          供应商配置模板
```

## 说明

- 仓库里的界面截图取自中性演示数据；`style-packs/*/previews/` 里是各风格的真实样例页。
- 渲染器和前端不写死业务文案；图表只画有真源的数据，没有就不画并标注来源。
- 服务默认只监听 127.0.0.1，没有登录鉴权。

## 版本

版本号**唯一真源**是仓库根的 [`VERSION`](VERSION) 文件（当前 `0.3.0`）：

- `server/app/main.py` 直接读它，`GET /api/health` 返回的 `version` 就是它；
- `web/package.json` 的 `version` 受 npm 约束必须是字面量，由 `tools/check_version_sync.py` 在门禁里强制对齐（连同 `CHANGELOG.md` 首条版本一起校验），改漏一处就会报错；
- 发版流程（改版本 → 写 CHANGELOG → 打 tag → 建 Release）见 [`AGENTS.md` 的发版流程](AGENTS.md#发版流程)。

## 许可证

本项目以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布，全文见 [`LICENSE`](LICENSE)。

选 AGPL 而不是 MIT 的原因：本项目依赖 **PyMuPDF**（PDF 解析），它本身就是 **AGPL-3.0 / 商业双授权**——
也就是说即使本项目用 MIT，只要打包了 PyMuPDF 就同样要承担 AGPL 的义务。既然如此，直接用 AGPL-3.0 是一致的。

实际影响：

- 自用（含公司内部自建）**不受限**；
- 若你修改后**作为网络服务提供给他人使用**，AGPL §13 要求你向使用者提供修改后的完整源码；
- 商业闭源集成需另行向 PyMuPDF 购买商业授权，或替换掉 PyMuPDF 依赖。

主要第三方依赖的许可：PyMuPDF（AGPL-3.0/商业）、python-pptx / python-docx / FastAPI / Pillow / PyYAML（MIT 类）、
uvicorn / httpx（BSD-3-Clause）、PptxGenJS / React（MIT）。分发前请自行复核一遍。

## 名称兼容

项目现名为 **SlideCraft**。为保留已有项目、草稿和部署配置，内部数据库文件、浏览器存储键、运行文件及 `DECKFORGE_*` 环境变量继续沿用原有标识；无需迁移或清空数据。

## 密钥安全

模型 API key 只允许存在于两处：本机 `.env`（或 `config/.env`）与数据库设置表（界面「设置 → 模型与密钥」填的）。
这两处都已被 `.gitignore` 排除（`data/` 整个目录不入库），**不会、也不允许**进入 git 或上传到 GitHub。

仓库自带三道闸：

| 闸 | 触发 | 作用 |
|---|---|---|
| `.githooks/pre-commit` | `git commit` | 检查索引里有没有 key / `.env` / 数据库等 |
| `.githooks/pre-push` | `git push` | 检查**即将上传的提交**，数据离开本机前拦下 |
| `make guard` | 手动 / `make verify` | 索引 + HEAD + 全历史三层体检 |

新克隆先启用钩子（每个克隆一次）：

```bash
make hooks          # 等价于 bash tools/install_hooks.sh
```

检查器是 `tools/check_no_secrets.py`：既查密钥形态（`sk-`、`ghp_`、`AIza`、PEM、JWT、赋值式长串），
也把本机 `.env` 与数据库里的**真实 key 值**当字面量全文比对；命中只报 `文件:行号`，**不回显内容**。
它自身出错时失败关闭（exit 2），不会静默放行。若已确认某个提交安全，可 `git commit --no-verify` 临时跳过——不建议。
