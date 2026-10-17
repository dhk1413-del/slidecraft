# PPT 美化 v2 —— 预览式 · 逐页 AI 生图 · 精细重建转可编辑（实现契约）

> 状态：已实现。旧美化口径与 `/reskin` 端点已移除，首页 `mode=reskin` 保留并指向新链路。

## 0. 一句话流程

上传 PPTX/PDF → 前 1–3 页转图、逐页生图（并发上限 3）、合成 image.pptx 预览 → 用户确认 → 全部页转图、仅补未生图页 → 全量 image.pptx；**生成图片时不再自动重建可编辑版**，用户进入第⑥步「转可编辑」并点「开始精细重建」（POST /beautify/editable）才走 `editppt` 精细重建产出 full.pptx（2026-10-17 起移除 Codex 路径）。

## 1. 铁律（沿用仓库约定，违反即不通过）

1. **文字真源**：页面上的文字**只能**来自该页真源（原稿文本框 / PDF 文本层 / 视觉识别）。不许改写、漏字、编造。取不到 → 少画元素并如实写 warning。
2. **零 key 可跑**：没有生图 key 时，生图阶段降级为「原图直通」（`beauty/pNN.png` = 原图副本）并写 warning，流程不中断；精细重建引擎不可用时如实报错并**只**产出图片版，**不伪造**可编辑版。
3. **不伪造成功**：任一阶段失败都写进 `state.json` 的 `warnings`，导出件缺失就是缺失。
4. 中文界面；数字等宽；配色走风格包 tokens。
5. **预览只到生图与图片版合成**：不重建可编辑版，不产出 preview.pptx，exports 不含 editable；full 阶段同样只产图片版，转可编辑改为**按需**触发（`POST /api/projects/{id}/beautify/editable`，走 `editppt` skill）。
6. **两种生图模式**：img2img 以原页为参考；redesign 按该页标题、要点文字真源与风格令牌文生图，要求 16:9，不出现真源以外文字。缺文字真源写 warning 并退回 img2img；缺 key 复制原图、成本 0。
7. **不改** `web/dist/`；**不提交密钥**；**不做 `git commit`**。

## 2. 数据目录

```
data/files/<pid>/beautify/
├── origin/pNN.png       # 原稿该页渲染图（宽 1600，保持原比例）
├── beauty/pNN.png       # 生图产物（img2img 保持原比例；redesign 16:9）
├── text/pNN.json        # 该页文字真源 {title, points[], texts[], source}
├── work/                # 历史 Codex 工作区（已弃用；现由 editppt run 目录承载重建现场）
├── full.pptx            # 全量可编辑产物
├── image.pptx           # 图片版（整页美图铺底，兜底）
└── state.json           # 阶段状态（见 §4）
```

## 3. 历史模块 `server/app/codex_engine.py`（2026-10-17 已删除）

> 本节保留为历史设计记录；当前实现改为 `editppt` + Harness/Hermes 逐页精细重建，仓库内不再有 Codex 依赖。

```python
def binary() -> str                      # 探测 codex 可执行文件；找不到返回 ""
def proxy_url() -> str                   # 见下
def available() -> dict                  # {ok, binary, version, proxy, reason}
def run(prompt: str, workdir: str, images: list[str] | None = None,
        timeout: int = 900, model: str | None = None) -> dict
        # → {ok, code, stdout, stderr, seconds, cmd, artifacts:[workdir 下新生成的文件]}
```

实现要点：
- 命令：`[binary, "exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", workdir]`
  `+ (["-i", *images] if images else []) + ["--", prompt]`。
  **`--` 不能省**（`-i` 是可变参数，不吃分隔符会把 prompt 当成图片文件名）。
- 代理（**必需**，否则连不上 OpenAI）：`proxy_url()` 依次尝试
  ① DB setting `codex:proxy_url` ② `config.http_proxy_url()` ③ 常见端口 `65532/7897/1080/7890`；
  **每个都做 TCP 可达性探测（超时 1s），取第一个可达的**；都不通 → 返回 `""`（直连，让 codex 自己失败并如实上报）。
  环境变量注入：`HTTPS_PROXY = HTTP_PROXY = proxy`，`NO_PROXY = "127.0.0.1,localhost"`。
- `subprocess.run(..., capture_output=True, text=True, timeout=timeout, env=env, cwd=workdir)`；
  `TimeoutExpired` → `ok=False, reason="timeout"`。
- 本机实测：`codex exec` 冷启动约 20–40s，单次任务数分钟；**不可用于同步请求**，只能进作业（SSE）。

## 4. 新模块 `server/app/beautify.py`

```python
def render_origin(pid, src_path, limit: int | None = None, width: int = 1600) -> dict
    # .pptx → source_pages.ensure_pdf(pid, src) → PyMuPDF 逐页渲染（只渲前 limit 页）
    # .pdf  → PyMuPDF 逐页渲染
    # 图片  → Pillow
    # 缓存：source 指纹（name/size/mtime_ns）一致且已覆盖请求页数 → 复用，不重渲
    # → {ready, page_count, renderer, source, pages:[{page_no, path, width, height}]}

def page_text_source(src_path, page_no) -> dict
    # .pptx → python-pptx 读该页全部 shape 文本（含表格）；.pdf → PyMuPDF get_text
    # 取不到 → {title:"", points:[], texts:[], source:"none"}（绝不编造）
    # → {title, points[], texts[], source: "pptx"|"pdf"|"none"}

def beautify_prompt(tokens: dict) -> str
    # 图生图 prompt：**逐字保留原图所有文字与元素位置**，只换配色/质感/装饰到目标风格。
    # 必须含：不得增删/改写任何文字；输出与原图同长宽比。

def beautify_page(pid, page_no, tokens, mode="img2img", size="2K", text=None) -> dict
    # img2img：读 origin/pNN.png → providers.edit_image(bytes, prompt, size)
    # redesign：text 标题与要点逐字列出 + tokens → providers.generate_image(prompt, size)
    # 缺文字真源：warning + 退回 img2img；text 未传入时读取 text/pNN.json
    # 成功 → 写 beauty/pNN.png；失败 → 复制原图到 beauty/ 并 ok=False + warning

def convert_with_codex(pid, items, out_path, tokens, style_name) -> dict
    # items = [{"page_no": int, "image": path, "text": dict}]
    # 写 work/pNN.png、work/pNN.txt（真源文字）、work/style.json
    # 调 codex_engine.run(<重建 prompt>, workdir=work)
    # 期望 work/out.pptx → 校验存在且页数 == len(items) → 拷到 out_path
    # → {ok, path, seconds, message, warnings[]}
```

### 4.1 历史：Codex 重建 prompt（已移除，仅存档）

```
# 任务：把每页图片重建为「PowerPoint 原生可编辑页面」，输出 out.pptx

工作目录里有（每页一组，页号 N 两位数）：
- pages/pNN.png —— 第 N 页的【视觉参考图】（已美化，含版式/配色/装饰）
- pages/pNN.txt —— 第 N 页的【文字真源】（来自原稿，**必须逐字采用**）
- style.json     —— 配色令牌

硬性要求（违反任何一条都算失败）：
1. 用 python-pptx 生成 out.pptx。解释器固定用这个（已装 python-pptx 1.0.2）：
   /path/to/slidecraft/.venv/bin/python
2. 幻灯片尺寸 13.333 × 7.5 英寸（16:9），**每页一张幻灯片**，顺序与页号一致。
3. 页面上**所有文字**必须是**真正的文本框**（slide.shapes.add_textbox），内容**逐字取自 pages/pNN.txt**：
   不改写、不翻译、不精简、不漏字、不编造原文没有的文字。字号/位置/对齐参照 pNN.png。
4. 版式、配色、装饰（背景色块、色带、圆角卡片、线条、图标位）用**原生形状**还原，颜色取自 style.json。
5. **禁止把整页 pNN.png 铺满作为底图**（那是「图片版」，不是「可编辑版」）。
   局部插画/照片允许裁切后作为图片插入，但不得用整页图代替排版。
6. 只写工作目录内的文件，不做 git 提交，不修改工作目录以外的文件。
7. 完成后，最后一条消息输出一行：DONE out.pptx pages=<页数>
```

## 5. 作业编排 `pipeline.run_beautify(...)`

取消按检查点响应，不强杀 `asyncio.to_thread` 的线程；保留已完成页和已产出的图片版，不登记取消后的可编辑版，state 标记 cancelled=true 并保持 preview 阶段，可续跑并跳过已生图页。

```python
async def run_beautify(project_id: str, style_pack_id: str, phase: str = "preview",
                       mode: str = "img2img", preview_pages: int = 3, size: str = "2K") -> str
```

- `new_job(project_id, "beautify", total)`；`total` = 本阶段页数（preview=3，full=剩余页）。
- SSE 事件沿用既有形状：`{"type":"progress","page":n,"total":N,"stage":"render|beauty|codex|assemble","status":"running","message":"…"}`，终态 `{"type":"done","file":…}` / `{"type":"error","message":…}`。
- `phase="preview"`：渲染前 `preview_pages` 页 → 先提取逐页文字真源 → 逐页生图（并发 3）→ `image.pptx`；state.phase 保持 preview，最后 progress 为 assemble，无 codex 事件。
- `phase="full"`：渲染全部页（复用已渲的 origin 缓存）→ 对**尚未生图**的页逐页生图（并发 3，**不重跑预览页**）→ 全量 `image.pptx`，state.phase=done；可编辑版由 `beautify/editable` 按需触发（`editppt` 精细重建 → `full.pptx`）。
- 导出登记 `exports` 表：`kind='beautify_editable'`（仅 full 阶段，path=full.pptx）与 `kind='beautify_image'`。
- 成本：每张生图按 provider 单价记账（`usage_log`，action='beautify'）。DB 无 `price:<provider>` 覆盖且 yaml 的 `unit_price_cny` 为 null 时，金额记 0，不代表免费。状态接口通过只读 `cost_summary(pid)` 按 provider 汇总项目全部美化记账（含失败调用、重新预览），不写入 state.json。
- `state.json`（以下为 preview 示例；full 成功后 codex.ok=true，exports 增加 editable）：
  ```json
  {"phase":"preview|full|done","mode":"img2img|redesign","style_pack_id":"…","style_pack_name":"…",
   "source":[{"name":"…","size":1,"mtime_ns":1}],"page_count":12,"rendered":3,"confirmed":false,
   "pages":[{"page_no":1,"origin":"…","beauty":"…","beauty_ok":true,"provider":"guaihub",
             "model":"gpt-image-2","cost_cny":0.5,"latency_ms":98000,"text_source":"pptx"}],
   "codex":{"ok":false},"exports":{"image":"…"},
   "warnings":[],"updated_at":"…"}
  ```

## 6. API 端点（`server/app/main.py`，同步 `docs/API.md`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/projects/{pid}/beautify/origin` | 上传后渲染全部原页，复用缓存。返回 `{page_count, renderer, pages:[{page_no,image_url,width,height}]}`，URL 为 `/files/...`；缺项目或未上传 PPTX/PDF 返回 400。 |
| POST | `/api/projects/{pid}/beautify/preview` | body `{style_pack_id, mode:"img2img|redesign", preview_pages:3, page_nos:[1,2,4]}` → `{job_id, progress_url, page_count, message}` |
| POST | `/api/projects/{pid}/beautify/continue` | body `{style_pack_id, mode, page_nos:[1,2,4]}`；必须已有 `state.phase=="preview"`，否则 400 → `{job_id, progress_url, remaining_pages}` |
| GET | `/api/projects/{pid}/beautify` | 状态：`{phase, mode, page_count, rendered, confirmed, pages:[{page_no, origin_url, beauty_url, beauty_ok, text_source}], codex:{ok}, exports:{editable?,image?}, cost:{total_cny,image_calls,failed_calls,price_configured,by_provider:[{provider,cny,count,failed}],note}, warnings}` |
| GET | `/api/projects/{pid}/export?kind=beautify_editable` | 下载可编辑版（无 → 400 提示先跑美化） |
| GET | `/api/projects/{pid}/export?kind=beautify_image` | 下载图片版 |

成本 `cost` 中 `total_cny` 为元（float），`image_calls` 为全部调用数，`failed_calls` 为失败调用数；`by_provider` 包含供应商、金额、调用数与失败数。仅 `total_cny > 0` 时 `price_configured=true` 且 `note` 为空串；否则（含无记录）为 false，`note` 固定为「未配置生图单价，金额记 0，不代表免费」。无记录时金额为 0.0、调用数与失败数为 0、明细为空列表。预览展示当前调用数与已有金额；完成页展示总成本、供应商明细与 `codex.seconds` 秒，并显著显示未配置单价提示。

mode 仅允许 `img2img` / `redesign`，非法值返回 400。预览状态 exports 仅有 image；可编辑版仅 full 成功后可下载。旧 `/reskin` 端点已移除。

原稿格式：`.pptx` / `.pdf`（`.pptx` 走 `source_pages.ensure_pdf`）。不支持的格式 → 400。

## 7. 前端（HomePage 的 BeautifyPanel）

保留首页 `mode=reskin` 入口与「PPT美化」标签；旧口径已移除。

1. **上传内容**：拖入 PPTX/PDF 后自动 createProject → uploadSource → beautify/origin，显示「正在识别页面…」，完成后立即进入页面确认。
2. **页面确认**：圆形徽标三步条、文件卡、原页缩略图网格；默认全选，支持逐页勾选/移除、全选和取消全选。底部胶囊显示已选 N / M 页。保留风格包、自定义风格与生图方式设置，点击「开始生成前 3 页预览」携带 page_nos。预览并排显示原图/美图、成本、warnings，支持取消生成；确认后携带同一选择调用 continue，仅续跑缺页。
3. **生成结果**：按需精细重建成功后提供可编辑版，同时如实展示图片版、成本与警告。

## 8. 验收（离线，加入 `tools/verify_all.py`）

新增 `tools/test_beautify_v2.py`（**不联网、不调模型**）：
1. `render_origin`：对 `.pdf` 与 `.png` 正确产出 `origin/pNN.png`，页数、宽 1600、缓存复用正确。
2. `page_text_source`：对含文本的 `.pptx`/`.pdf` 抽到文字；对纯图片返回 `source="none"` 且**不编造**。
3. `editppt_engine.convert_items` 在引擎不可用时 `ok=False` 且**不产出**可编辑版（不伪造）。
4. `state.json` 读写幂等；`phase` 流转 preview→full 正确。
5. 零 key 降级：`beautify_page` 在无生图 key 时复制原图且 `ok=False` + warning。

`make verify-fast` 与 `make lint` 必须全绿。

`page_nos` 可选，缺省处理全部页；显式提供时须为非空整数列表且页号在 1..page_count 内，否则 400。去重并保持原稿顺序，preview 取所选前 preview_pages 页，continue 仅生成所选尚无生图文件的页。state.page_nos 记录本次选择，原稿指纹/风格/模式校验保持有效。
