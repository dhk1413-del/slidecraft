# SlideCraft MVP — API 契约（前后端共同遵守）

> 后端：FastAPI `http://127.0.0.1:8640`，所有接口前缀 `/api`。前端 dev 时用 Vite proxy 把 `/api` 转发到 8640。
> 时间字段一律 ISO8601 字符串；金额单位「元」，保留 4 位小数；页号从 1 开始。

## 0. 通用约定

- 错误：`{"detail": "中文可读信息"}`，HTTP 4xx/5xx。
- 「模型未配置」统一返回 **HTTP 200 + 业务标记**（前端据此提示而非报错）：
  `{"configured": false, "reason": "缺少 OPENAI_API_KEY", "hint": "到「设置 → 模型与密钥」填写", "fellback": "local_render"}`
- 流式进度：`GET /api/jobs/{job_id}/stream`，`text/event-stream`，每行 `data: {json}`。
  事件类型：`{"type":"progress","page":3,"total":13,"stage":"generate","status":"running","message":"第 3 页生成中"}`
  、`{"type":"done","deck_id":"..."}`、`{"type":"error","message":"..."}`
- 作业详情：`GET /api/jobs/{job_id}`；`done` 表示已处理页数，会在每页处理完成后随页递增（失败页也计入）。

## 1. 健康与配置

| 方法 | 路径 | 说明 | 响应 |
|---|---|---|---|
| GET | `/api/health` | 存活 + 能力探测 | `{"ok":true,"version":"0.3.0","port":8640,"db":"ok","providers":{"image":{"guaihub":true,"dashscope":false,"local_render":true},"text":{"deepseek":false}},"network":{"mode":"http_proxy","http_proxy":"http://127.0.0.1:7897"}}` |
| GET | `/api/settings` | 读取设置（**key 掩码**） | `{"providers":[{"id":"guaihub","label":"GuaiHub · GPT Image 2","key_set":false,"key_masked":"","default_model":"gpt-image-2","default_size":"2K","needs_proxy":true,"unit_price_cny":null}],"text":{"id":"deepseek","key_set":false,"model":""},"network":{"mode":"http_proxy"}}` |
| PUT | `/api/settings` | 写 key/模型/Base URL/单价（**热加载，无需重启**） | body `{"provider_id":"guaihub","api_key":"sk-...","base_url":"https://api.guaihub.cc/v1","default_model":"gpt-image-2","default_size":"2K","unit_price_cny":"1.5"}` 或 `{"network":{"mode":"tun"}}` → 返回同 GET /api/settings。`unit_price_cny` 是**元/张**（字符串，空串=清除覆盖，存为 `price:<provider_id>` 覆盖 yaml）；**未填单价时账本金额记 0，不代表免费**。 |
| POST | `/api/settings/test` | 连通性测试（后端按 `needs_proxy` 自动决定走不走代理）。body：`{"provider_id":"guaihub"}`；可选 `api_key` 用于测试尚未保存的输入框密钥，**仅用于本次请求，绝不落库、不回显、不写日志**。 | `{"provider_id":"guaihub","ok":true,"status":200,"latency_ms":412,"message":"连通且鉴权通过"}` |

## 2. 风格包（读 `style-packs/`）

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/api/style-packs` | `{"items":[{"id":"tech-deepblue","name":"深蓝光感科技发布风","category":"科技/深色","tags":["科技","深色"],"badge":"热门","summary":"深底冷蓝渐变，发布会/技术方案气质","accent":"#3B82F6","bg":"#0B1220","layouts":["cover","section","cards_4","comparison_2col","data_chart","timeline","summary"],"preview_count":0,"source_type":"system","version":"1"}]}` |
| GET | `/api/style-packs/{id}` | 含 `style_md`（原文）、`prompt_md`（原文）、`tokens`（从 style.md front matter 解析出的颜色/字体） |
| GET | `/api/layouts` | `{"items":[{"key":"cover","title":"封面","best_for":"整册首页","slots":["title","subtitle","meta"]}]}` |

## 3. 项目 / 页面（工作台）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects` | `{"items":[{"id":"p_xxx","title":"三创汇报","source_type":"markdown","intake_mode":"doc","page_count":13,"status":"done","style_pack_id":"tech-deepblue","created_at":"...","updated_at":"...","resume_step":5,"flow":"wizard","cover_url":"/files/p_xxx/beautify/beauty/p01.png","exports":[{"id":"e_xxx","kind":"beautify_image","file":"/files/exports/…pptx","pages":3,"size_bytes":2837952,"created_at":"…"}]}]}`。<br>`flow` 表示项目真实所属流程：`beautify`（PPT 美化，判据是磁盘上存在 `data/files/<pid>/beautify/`）、`editable`（图片转可编辑，判据是 `data/files/<pid>/import/`）或 `wizard`（文档生成向导）；列表与详情（GET `/api/projects/{id}`）都返回。<br>`cover_url` 只取**成品类图片**（已生成结果 → 美化结果 `beautify/beauty/` → 导入成品页 `pages/`），取不到为空串；**原稿缩略图不算封面**。`exports` 为该项目导出记录摘要（按时间倒序，不含快照明细）；`file` 为可下载 `/files/…` 地址，磁盘资产缺失时为空串。 |
| POST | `/api/projects` | 创建：body `{"title":"…","source_type":"markdown","intake_mode":"doc"}` → `{"id":"…"}` |
| DELETE | `/api/projects/{id}` | **删除项目（不可撤销）**。与项目相关的 `slides`/`slide_versions`/`jobs`/`exports`/`operation_submissions`/`operation_quotes` 记录，以及磁盘上的 `data/files/<pid>/`（原稿、页图、美化现场、`native-charts`）、导出件 `data/files/exports/<eid>/` 与 `…_<kind>_<eid>.pptx`、精细重建现场 `data/files/editppt/<pid>-*`（含其冻结输入 `input_*`）一并删除。返回 `{"ok":true,"id":"p_x","title":"…","deleted":{"slides":13,"jobs":2,"exports":1,"projects":1,"slide_versions":13,"operation_submissions":0,"operation_quotes":0},"files":{"project_dir":1,"editppt_runs":1,"frozen_inputs":1,"export_files":1,"export_dirs":1},"usage_log_kept":13,"note":"…"}`。<br>**409**：项目还有任务在跑（`jobs.status ∈ queued/running/cancelling`，含美化/生成/精细重建）或原稿缩略图正在后台构建——先取消或等结束；**404**：项目不存在。<br>**用量账本（`usage_log`）保留**：成本记录是可审计的账，删项目不抹账；之后 `GET /api/projects/{id}/usage` 与全局用量页仍能看到这些记录（项目名回退为「已删除项目」）。 |
| POST | `/api/projects/{id}/upload` | `multipart/form-data`，字段 `file`（.md/.txt/.docx/.pdf/.pptx）。返回 `{"parsed_text":"…","char_count":1234,"suggested_pages":13,"warnings":[]}` |
| POST | `/api/projects/{id}/import-pages` | **图片转可编辑（首页模式②）**：`multipart/form-data`，字段 `files`（可多份：PDF / PNG / JPG / JPEG / WEBP / PPTX，多张图片按上传顺序拼成一册）。逐页渲染成原页图（宽 1600，PDF→PyMuPDF、图片→Pillow、PPTX→复用 LibreOffice 转出的 PDF 缓存），并**登记成 slides**，使既有的「导出图片版」与「转可编辑」直接可用。返回 `{"page_count":3,"renderer":"PyMuPDF","pages":[{"page_no":1,"image_url":"/files/p_x/pages/p01.png","width":1600,"height":900}],"image_deck":"/api/projects/p_x/export?kind=image","editable":"/api/projects/p_x/editable"}`；不支持的格式 400，转换器故障 503。 |
| GET | `/api/projects/{id}/source-pages` | 仅 PPTX 原稿：原稿页缩略图状态，`{"page_count":18,"ready":true,"generating":false,"pages":[{"page_no":1,"thumb_url":"/files/p_x/source-pages/p01.png","width":420,"height":237}]}`。PPTX 上传后后台转换，失败时 `ready:false,generating:false,error:"…"`，不影响生成。 |
| POST | `/api/projects/{id}/source-pages/build` | 仅 PPTX 原稿：幂等触发后台构建；已有完整缓存或正在构建时直接返回当前状态，不重跑转换。 |
| GET | `/api/projects/{id}/source-pages/{page_no}?w=1100` | 仅 PPTX 原稿：按需返回该页 1100px 宽 PNG 大图；PDF 与逐页大图按原稿文件名、mtime、大小落盘缓存，重传/原稿变化时共同失效。 |
| POST | `/api/projects/{id}/outline` | 内容梳理（DeepSeek；无 key 时本地兜底切页）。body `{"target_pages":13,"page_minutes":1.5}` → `{"pages":[{"page_no":1,"title":"…","role":"cover","outline":"…","points":["…"]}]}` 返回每页含 `chapter_no`/`chapter_title`，并额外返回 `chapters:[{chapter_no,title,page_from,page_to,page_count}]`（章节按素材真实标题层级归纳，无 key 时用本地标题规则）|
| PUT | `/api/projects/{id}/pages` | 人工确认/编辑页清单：`{"pages":[{"page_no":1,"title":"…","keep":true,"layout":"cover"}]}` 每页可带 `chapter_no`/`chapter_title`（大纲编辑器的章节归属），一并落库与草稿 |
| POST | `/api/projects/{id}/generate` | 开始生成：`{"style_pack_id":"tech-deepblue","size":"2K","page_nos":[1,2,3]}` → `{"job_id":"j_xxx","configured":true,"progress_url":"/api/jobs/j_xxx/stream"}` |
| POST | `/api/projects/{id}/reskin` | **已移除**；改用下方美化 v2 的 beautify/preview 与 beautify/continue。 |
| GET | `/api/projects/{id}/slides` | 每页：`{"page_no":1,"title":"…","image_url":"/files/p_x/1.png","width":2048,"height":1152,"status":"done","editable":false,"provider":"local_render","model":"local","size":"2K","cost_cny":0.0,"latency_ms":0,"verify":{"text_accuracy":1.0,"issues":[]}}`。`image_url` 由 `image_path` 推导，兼容生成的 `<页号>.png` 与导入的 `pages/pNN.png`（导入页 `provider="import"`）。`native_status` 口径：`pending`/`failed`/`building` **原样返回**（从未构建 / 构建失败 / 构建中），只有 `ready`/`legacy_overlay` 且场景与当前图片对不上时才是 `stale`——避免把"从未构建"显示成「待按图片重建」。 |
| POST | `/api/projects/{id}/slides/{page_no}/regenerate` | 单页重生成 → `{"job_id":"…"}` body 还可带 `instruction`（用户的修改要求，最长 400 字）：带上它就按「优化本页」处理——提示词在逐字保留与不编造规则内尽量满足该要求，并在重生成前把当前图归档为历史版本。 |
| GET | `/api/editable-engines` | **「图片转可编辑」唯一的引擎**：`{"engines":[{"id":"editppt","ok":true,"seconds_per_page":780,"cli":"…","skill_dir":"…","reason":"可用"}]}`。内置引擎（一次视觉识别 + 本地渲染）已于 2026-09-21 下线：`ok=false` 时 `reason` 说明缺哪一件（CLI / skill 目录 / agent CLI：默认 Harness `dsh`，可用 `editppt.agent=hermes` 切回 Hermes），界面如实报错且**不回退**。 |
| POST | `/api/projects/{id}/editable` | **图片转可编辑**：body `{"page_nos":[1,2],"engine":"editppt","resume":false}`（engine 只接受 `editppt`，传 `builtin` → 400 提示已下线）→ `{"job_id":"…","engine":"editppt","estimate":{…},"mode":"editppt_skill"}`。<br>驱动第三方 skill `image-to-editable-ppt` 的状态机（prepare → **用 `run next --json` 决策** → 并发 dispatch → Harness headless 作 page worker 写 manifest → `page build/validate` → `run record` → `run finalize`）；默认并发 2 页（`editppt.max_concurrent_pages` 可配，skill 上限 6）、实测约 13 分钟/页、产物自带 `validation.json` 校验，**只含所转页面**；任一页校验不过 → 保留已完成页与现场、如实报错（可续跑），失败明细含页码/阶段/原因。`resume=true` 复用最近一次未完成的 run 现场（跳过已记录页）。<br>**文字真源**：有真源（生成/美化）写标准 `text_hints.json` 的 `text`；没有真源时依次尝试 skill 的 PaddleOCR hints、本机 **RapidOCR** 离线 OCR（`server/pptx/editppt_ocr.py`）；全不可用时如实失败并提示配置 OCR。<br>**前端**：首页「图片转可编辑」上传原页后进入独立的 **`#/editable/{id}` 三步流程**（① 上传内容 → ② 页面确认 → ③ 转换结果），不再套用生成向导的 5/6 步；项目列表里 `flow=editable` 的项目也恢复到这 3 步。第③步由 `EditableWorkbench` 选页并开始精细重建，可停止/继续/下载。 |
| GET | `/api/projects/{id}/export?kind=image` | 导出**图片版 PPTX**（同步返回文件）：`{"kind":"image","file":"/files/exports/xxx_image.pptx","size_bytes":123456,"pages":13,"editable_pages":[]}` |
| GET | `/api/projects/{id}/export?kind=editable` | **已下线**（随内置引擎一并移除）：请求该 kind → **400** 并提示改用「图片转可编辑」模块（`#/editable`）的 `kind=editable_hi` 产物。旧 `pipeline.do_export(pid,'editable')` 也已下线，同样提示走 editppt 精细重建。 |
| GET | `/api/projects/{id}/export?kind=editable_hi` | 取**精细重建产物**（第三方 skill，仅含已转页）：`{"kind":"editable_hi","engine":"editppt","file":"…","pages":2,"editable_pages":[1,2],"size_bytes":…,"note":"…仅含已转换页面…"}`；未转换过 → **400** 并提示先去「图片转可编辑」转换。 |
| GET | `/files/{path}` | 静态文件（原稿、页面图、导出件） |

## 5. PPT 备注模块（独立于生成流程）

上传一份**已有的** .pptx，按每页内容写演讲者备注，再写回备注栏导出。**只写备注栏，不改动页面内容/版式/母版。**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/notes` | 任务列表 `{items:[NotesJob]}` |
| POST | `/api/notes/upload` | 表单字段 `file`（**仅 .pptx**）→ 落地文件 + 解析页清单，**秒回、不花钱**：`{id,title,pages,image_pages,notes_existing,pages_detail:[…],hint}` |
| GET | `/api/notes/{nid}` | 任务详情：job 字段 + `pages_detail[]`（含 `text_source`/`vision`/`note`/各状态）+ `notes_done`/`notes_failed` |
| DELETE | `/api/notes/{nid}` | 删除任务与页记录（上传的原文件留在 `data/files/notes/{nid}/`） |
| POST | `/api/notes/{nid}/analyze` | body `{vision_mode:"auto"\|"all"\|"off", page_nos?:[]}` → `{job_id}`，**SSE 订阅 `/api/jobs/{job_id}/stream`**。渲染 pptx→PDF→逐页 PNG（缓存），再调视觉模型建立每页「内容真源」 |
| POST | `/api/notes/{nid}/generate` | body `{page_nos?, instruction?, only_missing?}` → `{job_id}`（SSE）。`instruction` = 「写提示词让 AI 重写」；`only_missing=true` = 只补未完成的页（续跑，不重跑已完成的页） |
| POST | `/api/notes/{nid}/pages/{page_no}/regenerate` | body `{instruction?}` → `{job_id}`：单页重写 |
| PATCH | `/api/notes/{nid}/pages/{page_no}` | body `{note}`：人工修改并保存（置 `note_edited=1`） |
| POST | `/api/notes/{nid}/export` | body `{keep_original?:true}` → `{file,name,pages,skipped_pages,kept_original,size_bytes}`；`file` 走 `/files/exports/*` 下载 |

**页状态**：`vision_status` = pending/done/failed/skipped；`note_status` = pending/running/done/failed。
**vision_mode**：`auto` 只识别文字 <30 字的图片页（推荐）；`all` 每页都识别；`off` 只用文本框文字。

**硬约定**（规范来源 `server/app/slide_notes.py`）：
1. 备注内容只能来自该页的 `text_source`（文本框/表格）+ `vision`（画面识别）。两者皆空 → **不生成**，标 `note_status=failed` 并说明原因，不允许模型凭常识补全。
2. 渲染 PDF 页数必须等于 pptx 页数，否则**拒绝继续**（防备注错页）；导出前也会再校验一次。
3. `note_original` 非空时默认保留原文，AI 备注以 `【演讲备注】` 分隔追加在下方（`keep_original:false` 可覆盖）。
4. 零 key 时：上传/解析/页清单全可用；`analyze` 报「未配置视觉模型」；`generate` 报「未配置 DeepSeek」。

## 6. 用量账本

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/api/usage?range=month` | `range` 默认 `month`（本地时间当月 1 日 00:00 起），`all` 为全部记录；总额与分组汇总覆盖范围内全部记录，`items` 最多返回最近 500 条。 `{"total_cny":12.86,"by_action":[{"action":"generate","cny":12.5,"count":26}],"by_provider":[{"provider":"local_render","cny":0.0,"count":26}],"items":[{"id":"u_1","ts":"…","action":"generate","provider":"local_render","model":"local","size":"2K","cny":0.0,"latency_ms":120,"ok":true,"detail":"P3"}]}` |
| GET | `/api/provider-usage?refresh=0` | **供应商面板侧用量**（New API 兼容计费接口，当前 `guaihub`，由 `config/providers.yaml` 的 `usage_api: "new_api"` 开启）。用同一个 sk- key 读 `GET {root}/api/status`（币种/汇率）+ `GET {root}/v1/dashboard/billing/usage`（累计已用）+ `GET {root}/v1/dashboard/billing/subscription`（额度上限），**只读、不产生模型费用**；服务端缓存 60 秒（币种/汇率来自公开 `/api/status`，另缓存 5 分钟），`refresh=1` 绕过缓存；链路偶发慢，主用量请求超时会重试一次。返回 `{"items":[{"provider_id":"guaihub","label":"GuaiHub · GPT Image 2","ok":true,"cached":false,"currency":"USD","total_usage":120.0,"used_usd":1.2,"used_cny":8.76,"exchange_rate":7.3,"unlimited":true,"limit_usd":null,"limit_remaining_usd":null,"quota_per_unit":500000.0,"fetched_at":"…","duration_ms":5300,"error":"","scope_note":"累计值（面板忽略日期范围）；若面板开启令牌统计则为该 key 累计，否则为该账号累计","delta":{"total_usage":5.0,"used_usd":0.05,"used_cny":0.365,"previous_ts":"…","previous_total":115.0},"first_snapshot":false}],"fetched_at":"…","cache_seconds":60,"note":"…"}`。<br>**口径（实测 2026-10-17）**：`total_usage` 是**累计**值，`start_date/end_date` 被面板忽略（换区间返回同一个数），所以只能报「累计 + 与上次成功快照的差额」（差额落库在 `provider_usage` 表，差值可能包含该账号在本机之外的使用）；单位是面板展示货币的 0.01（`quota_display_type=USD` 时即美分），人民币按面板 `usd_exchange_rate` 折算；`hard_limit_usd` 为面板「不限量」时返回 ≥1e8，按 `unlimited:true` 处理。**key 绝不出现在响应/日志**；查询失败（超时/401/404）不抛 5xx，返回 `ok:false + error`，统计页照常可用。 |

## 7. 前端页面清单（MVP）

1. **生成向导**（六步）：① 输入内容 → ② 编辑大纲 / 页面确认（无结构化内容时含梳理子步骤）→ ③ 内容确认 → ④ 选择风格 → ⑤ 确认设计（先跑前 3 页预览）→ ⑥ 生成页面。生成完成后第⑥步底部提供 **「转可编辑 PPT」**（直达 `#/editable/{id}` 转换页）与 **「下载图片集 PPT」**（按页整页图铺底导出 PPTX；若还有未核对页，会先弹一次确认并把这些页标记为已核对）。项目步骤路由与解锁条件见文末 M1 契约。
2. **PPT 备注**（`#/notes`）：① 拖拽上传已有 .pptx（秒回页清单）→ ② 画面识别（auto/all/off，逐页可核验识别结果）→ ③ 写备注（可填一句要求）→ ④ 导出（写回备注栏的副本）→ ⑤ 逐页复核/手改/**写提示词让 AI 重写这一页**
3. **项目**：列表 + 按实际阶段恢复工作区（向导项目恢复 ⑤/⑥，第⑥步可直接「转可编辑 PPT」/「下载图片集 PPT」；`flow=editable` 的项目进 `#/editable/{id}` 三步流程）；卡片「…」菜单可重命名 / 查看用量 / **删除项目**（二次确认弹窗，删除不可撤销；有任务在跑时后端 409 拒绝）
4. **风格**：风格卡网格（分类筛选）+ 详情（布局/预览/色板）
5. **用量**：本月成本 + 按动作/供应商汇总 + 明细表（数字等宽）
6. **设置**：供应商 key 填写（掩码回显）+ 连通性测试 + 网络模式（http_proxy/tun/none）+ 文本模型

> 首页模式②「图片转可编辑」= 内嵌上传（渲染原页）→ 进入独立的 `#/editable/{id}` 三步流程（① 上传内容 → ② 页面确认 → ③ 转换结果）；生成向导第⑥步的「转可编辑 PPT」也直达该页第③步。
> 该流程只有一条引擎（第三方 skill 精细重建），内置引擎（本地渲染）已于 2026-09-21 下线。

## 8. MVP 的降级约定（必须实现，验收 17）

- **零 key 可启动**：无任何 API key 时，`/api/health` 正常，上传/解析/页面确认/风格/项目/用量全部可用；
  「开始生成」走 **本地兜底渲染**（Pillow 把结构化内容画成 16:9 PNG，`provider=local_render`、`cost=0`），**全套流程可跑通、可导出 PPTX**。
- 文案梳理无 DeepSeek key 时：按段落/字数本地切页 + 规则抽取标题（`fellback: "local_split"`），并在响应里给出 `hint`。
- 填 key 后**无需改代码、无需重启**（`PUT /api/settings` 热加载）。
- 每个页面/导出的记录都带 `provider / model / size / cost / latency`（D19 模型可见）。

## PPT 美化 v2（旧 reskin 端点已移除）

原稿只接受 `.pptx` / `.pdf`；项目不存在返回 404，格式、参数或状态无效返回 400。

| 方法 | 路径 | 请求 / 响应 |
|---|---|---|
| POST | `/api/projects/{pid}/beautify/origin` | 上传后渲染全部原页，复用缓存。返回 `{page_count, renderer, pages:[{page_no,image_url,width,height}]}`，URL 为 `/files/...`；缺项目或未上传 PPTX/PDF 返回 400。 |
| POST | `/api/projects/{pid}/beautify/content` | 页面确认后抽取原文，不调用模型。body `{page_nos:[1,2],keep_material_page_nos:[1]}`；返回 `{source_revision,page_nos,pages:[{page_no,title,points,texts,source,keep_material}]}`。页序按原稿排序，保留原图页必须属于已选页；空文字 `source="none"`，不补写内容。同一原稿的已保存文字优先复用。 |
| PUT | `/api/projects/{pid}/beautify/content` | 保存用户确认的文字，body 为上行返回结构。`title` 为字符串，`points` 为字符串数组，`keep_material` 为布尔值；页码必须与 `page_nos` 按序一致，单页文字最多 50000 字符。`texts/source` 由服务端按原稿与用户输入重新确定（修改后 `source="user"`）。返回保存后的结构；原稿版本变更返回 400，运行中的美化作业返回 409。 |
| POST | `/api/projects/{pid}/beautify/preview` | `{style_pack_id, mode:"img2img|redesign", preview_pages:3, page_nos:[1,2,4], size:"2K"}`；预览页数 1–3。返回 `{job_id, progress_url, page_count, message}` |
| POST | `/api/projects/{pid}/beautify/continue` | `{style_pack_id, mode:"img2img|redesign", page_nos:[1,2,4], size:"2K"}`；必须已有完成图片版的 preview，原稿、风格、模式一致。返回 `{job_id, progress_url, remaining_pages}` |
| POST | `/api/projects/{pid}/beautify/pages/{page_no}/regenerate` | **单页重生成（非破坏性）**：body `{style_pack_id?, mode?, size?}`（缺省沿用现场记录的风格与模式）→ `{job_id, progress_url, page_no, message}`，SSE 复用 `/api/jobs/{job_id}/stream`。只重写该页的 `beauty/pNN.png` 与 `text/pNN.json`，**其它页文件不重写、导出记录不被清空**；完成后按现有结果重新装配 `image.pptx` 并替换 `beautify_image` 导出记录，账本按该页号记一条 `action="beautify"`。前置条件：已有美化现场（phase 非空）、原稿指纹一致、该页在本次所选页面内、该项目没有别的美化作业在跑；不满足分别返回 400（如「请先生成美化预览，再重生成单页」「原稿已变更，请重新生成预览」「该页不在本次所选页面内」「该项目还有美化作业在跑，请等它结束」）。生成期间可 `POST /api/jobs/{job_id}/cancel` 取消，取消时**不发布**本次结果、不改 state |
| GET | `/api/projects/{pid}/beautify/pages/{page_no}/versions` | 该页历史版本列表：`{page_no, current, versions:[{id,created_at,instruction,size_bytes,url}]}`；`current` 是正在使用的图，不在 versions 里（界面单独标注「当前使用」）。每页最多保留 5 个历史版本 |
| POST | `/api/projects/{pid}/beautify/pages/{page_no}/versions/{version_id}/restore` | 把该页恢复到指定历史版本 → `{job_id,progress_url,page_no,message}`（SSE 复用 `/api/jobs/{job_id}/stream`）。恢复前会先把当前图归档，因此可再切回；完成后重装配 `image.pptx` 并更新导出记录 |
| POST | `/api/projects/{pid}/beautify/editable` | **按需**把已生成的美化图片版转成原生可编辑版（body `{style_pack_id?}`，缺省沿用现场风格）→ `{job_id, progress_url, message}`，SSE 复用 `/api/jobs/{job_id}/stream`（阶段 `prepare/page/page_done/finalize`，与「图片转可编辑」同一套 `editppt` 精细重建引擎）。**生成图片时不再自动执行**：full 阶段只产出图片版，`editable_engine.message` 为「尚未转换」，用户进入第⑥步「转可编辑」并点「开始精细重建」才跑。前置条件：`phase=done`（图片版已生成）、原稿指纹一致、精细重建引擎可用、该项目没有别的美化作业在跑；不满足分别返回 400。成功后写 `exports.editable` 与 `editable_engine`，并登记 `beautify_editable` 导出记录 |
| GET | `/api/projects/{pid}/beautify` | `{phase, mode, page_count, page_nos, rendered, confirmed, content_saved, updated_at, pages:[{page_no,origin_url,beauty_url,beauty_ok,text_source,keep_material,preserved_pictures}], editable_engine, exports:{editable?,image?}, cost:{total_cny,image_calls,failed_calls,price_configured,by_provider:[{provider,cny,count,failed}],note}, warnings}`；尚未运行时 phase 为空。`content_saved` 表示内容梳理是否**已保存并确认**（磁盘上存在与当前原稿匹配的 `content.json`）——恢复项目时用它判断第③步是否已完成；`confirmed` 仍只表示「已确认预览、正在做全量」。`keep_material` 表示该页勾选了「保留原图」：**勾了它的页在生图后会把原页里的图片元素按坐标原样贴回**（`preserved_pictures` 是实际贴回的图片张数），坐标来自源文件解析（pptx 读形状坐标、pdf 用 PyMuPDF），所以「原 PPT 里的图片不删、不换、不被重绘」是坐标级保证，不依赖模型自觉。`updated_at` 是美化现场最后更新时间，前端据此给结果图加 `?v=` 版本参数，避免单页重生成后看到旧缓存 |
| GET | `/api/projects/{pid}/export?kind=beautify_editable` | 直接下载 PPTX（仅 full.pptx，预览阶段不提供可编辑版）；不存在返回 400 |
| GET | `/api/projects/{pid}/export?kind=beautify_image` | 直接下载 image.pptx；不存在返回 400 |

作业使用现有 `/api/jobs/{job_id}/stream`：progress 含 `page,total,stage,status,message`，preview 的 stage 为 render/beauty/assemble，最后一步为 assemble；full 同样只产出图片版，不自动转可编辑。可编辑版由 `beautify/editable` 按需触发，阶段为 prepare/page/page_done/finalize。成功终态 done 含 file；失败 error 含 message，若图片版可用同时含 file 和 warnings。精细重建失败不会登记可编辑导出，作业标为 failed；已完成的图片预览允许用户继续全量。

`cost` 只读汇总项目全部 `action="beautify"` 记账，包含失败调用；金额单位为元，`by_provider` 按供应商汇总。仅 `total_cny > 0` 时 `price_configured=true`、`note=""`；否则 `note="未配置生图单价，金额记 0，不代表免费"`。DB 无 `price:<provider>` 覆盖且 yaml 单价为 null 时金额记 0。无记录返回 `total_cny=0.0`、调用数与失败数为 0、`price_configured=false`、明细为空列表及同一提示。

文件位于 `data/files/{pid}/beautify/`，state.json 持久保存阶段、原稿指纹、逐页成本与警告。全量复用预览页，不重复生图；确认后 phase=full，完成后 phase=done。未配置生图 key 时复制原图，beauty_ok=false、成本 0 并记录警告。精细重建引擎缺失、产物校验失败只保留图片版（且**不再在生成图片时自动执行**，改由 `beautify/editable` 按需触发）。新预览会清理旧美图与导出；同项目同时运行美化返回 400。

六步界面流程为：上传内容 → 页面确认 → 内容梳理 → 选择风格 → 生成结果 → 转可编辑（独立进度页，可停止/继续/下载）。文件选择后由「开始 PPT 美化」上传并识别原页；「开始梳理内容」抽取原文；确认内容时保存 `content.json`。有已保存内容时，生成使用该页标题与正文：`keep_material=true` 以原页画面为输入做图生图（保留原页图片和版式），否则按确认文字重新设计；无文字时仍回落图生图。用户修改的文字会同时用于生图提示和最终可编辑重建。未准备内容的旧调用继续使用原有 `mode` 语义。`content_signature` 记录确认内容与保留设置指纹；内容变更后必须重新预览，禁止续跑或复用旧页。选页与已保存内容不一致时返回 400。

mode 仅允许 `img2img` 与 `redesign`，非法值返回 400。img2img 参考原图并保留原文与位置；redesign 使用该页文字真源（标题与要点逐字列出）及风格令牌调用文生图，设计 16:9 演示页，不添加真源以外文字。无文字真源时写 warning 并退回 img2img；无 key 时复制原图、成本 0。mode 持久化在 state.json，continue 默认沿用预览模式。preview 完成保持 phase=preview，exports 仅 image，jobs 成功；full 仍只产出图片版；可编辑版由 `beautify/editable` 按需重建，成功时 exports 增加 editable。jobs done/total 仍按本阶段生图页数计算。

### 风格构建上传

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/style-builder/upload` | multipart 字段 `files`（兼容 `file`），支持 .pptx / .pdf / .png / .jpg / .jpeg / .webp；解析优先级 pptx > pdf > image。返回 `{builder_id, kind, files, pages, warnings}`，PDF 直接渲染并缓存逐页 PNG。 |

同一 builder 的 warnings 按首次出现顺序去重并写回 state；重复 analyze 不叠加相同警告。GET `/api/style-builder/{bid}` 的 result.warnings 与持久化警告一致。PDF/图片的 evidence 省略空 theme/structure（包括空字段占位）；已有非空证据保留，并在 warnings 说明其来源，未标注来源时如实注明。

### 作业取消

`POST /api/jobs/{job_id}/cancel` → `{ok:true, job_id, status:"cancelling", message:"正在取消"}`。不存在返回 404；终态（done/failed/cancelled）返回 400，detail 说明当前状态。`GET /api/jobs/{job_id}` 如实返回状态：running/cancelling/done/failed/cancelled。

生成向导与美化作业在检查点响应取消，不强杀正在运行的线程；保留已完成页。SSE 取消终态为 `{"type":"cancelled","message":"已取消生成"}`，随后关闭流；取消不属于 error。美化取消保持 preview 阶段，可重新预览或 continue 续跑，跳过已完成生图的页。

`page_nos` 可选，缺省处理全部页；显式提供时须为非空整数列表且页号在 1..page_count 内，否则 400。去重并保持原稿顺序，preview 取所选前 preview_pages 页，continue 仅生成所选尚无生图文件的页。state.page_nos 记录本次选择，原稿指纹/风格/模式校验保持有效。

## M1 项目配置与五步工作区

- `GET /api/projects/{id}`：不存在返回 404；返回项目原字段（含 `parsed_text`、`source_type`、`source_path`、`size`、`target_pages`），增加 `page_drafts`（保存的 `{page_no,title,keep,layout}` 清单）、`pages_confirmed`、`content_confirmed`、`resume_step`（1–5）。实际图片/运行中页面恢复到⑤，已确认内容恢复到④，已确认页面到③，仅上传到②。旧项目依据已有 slides / 风格 / 图片兼容恢复。
- `PATCH /api/projects/{id}`：可选 `{title,style_pack_id,size,target_pages,confirm_content,page_drafts}`；尺寸为 `1K|2K|4K`，目标页数 1–80，名称非空、风格必须存在。`confirm_content:true` 需已确认页面。返回同 GET；纯配置保存，不提交任务、不调用模型。`page_drafts` 保存页面范围/标题/布局草稿，同时清除页面与内容确认；页面勾选/布局修改和标题失焦时保存，继续按钮正式确认。
- `PUT /api/projects/{id}/pages`：保存整个待确认清单与保留页数，更新已有 slides，确认页面并清除内容确认。没有保留页返回 400。清单即使尚未创建 slides 也会落库。
- `POST /api/projects/{id}/outline`：显式执行梳理；已有同页记录保留 id，继承待确认清单的标题/布局/保留标记；保留已有图片资产，不自动重新生成。梳理后需重新确认页面、内容。
- `GET /api/projects/{id}/slides`：每页增加 `slide_id`（slides.id，稳定身份）、`source_page_no`（可空；未知映射不推测）、`display_order`（旧记录回退 page_no）。保留 `page_no` 用于展示、排序与既有任务接口。新文档切页记录没有可验证的原稿页映射，因此 source_page_no 为 NULL。
- 新列通过幂等迁移追加，旧记录均允许 NULL。项目账本仍关联 project_id；改名后的下一次图片/精细重建导出使用当前项目名称。
- 工作区步骤：生成向导六步 ① 输入内容 → ② 编辑大纲 / 页面确认（无结构化内容时包含显式梳理子步骤）→ ③ 内容确认 → ④ 选择风格 → ⑤ 确认设计 → ⑥ 生成页面。路径 `#/wizard/{id}/{1..6}` 可刷新/直链；`#/projects/{id}` **按项目真实所属流程恢复上一次执行到的步骤**——`flow=beautify` 的项目进入 PPT 美化六步（有已生成页 → ⑤生成结果，跑过但无产出 → ③内容梳理，从未跑过 → ②页面确认，作业运行中则订阅同一作业；⑤完成后可进⑥「转可编辑」），其它项目进入生成向导并按 `resume_step` 跳步；两条入口的布局与「PPT 生成」里对应步骤完全一致。图片转可编辑的入口为 `#/editable/{id}`（三步）；保留 `#/?style={id}` 预选风格入口（仍需输入和确认）。

## M2 页面、内容修订与人工核对

- 新上传的 PPTX 直接按原页提取文字和二维表格，保存真实 `source_page_no` 与不可变原文 `source_content`；原页无任何形状时 `source_available=0`，默认仅选择有效页，按源顺序展示。已有无映射的文档切页不会推测源页号。PPTX `/outline` 复用逐页原文和表格，不重新拆分原稿；图片页需人工补齐内容。
- `PATCH /projects/{id}` 的 `page_drafts` 允许所有页 `keep=false`（保存零选草稿）；正式 `PUT /pages` 仍要求至少一页。取消勾选只更新 keep，不删除页面。页条目可带 `revision`；改标题时修订不匹配返回 409。项目详情与 PUT 响应增加 `content_revisions:{slide_id:revision}`。名称、范围、顺序不会递增内容修订。选中页的素材策略只有 `reference`：内容参考并重新排版，不能保证保留原图；排除页不参与生成策略。
- `PATCH /api/projects/{pid}/slides/{slide_id}/content`：body `{revision,title?,outline?,points?:string[],modules?:[],source_note?,material_strategy?:"reference"}`。模块保留已有字段；表格模块 `{type:"table",title?,unit?,cells:[[string|number|null]]}` 必须为完整矩形。空串 / null / 待统计均不得推断为 0。响应为保存后的完整 Slide。事务内检查修订，冲突 409；实际内容变化递增 `content_revision`，相同内容不递增。保存清除内容确认，保留图片，不调用模型、不启动任务。
- `POST /api/projects/{pid}/slides/{slide_id}/outline-retry`：body `{revision}`；只使用此页已存原文重新梳理，复用 DeepSeek / 零 key 本地降级，返回保存后的 Slide，不改其他页、不生成图片。无文字真源 400，用户可补齐或排除。
- `PATCH /projects/{id}` 的 `confirm_content:true` 必须有选中页，且每页有标题和正文 / 要点 / 有内容的模块。内容确认只保存人工确认状态，不生成。`POST /generate` 支持 `content_revisions:{slide_id:revision}`：不匹配 409，未人工确认 / 不完整 / 已排除页返回 400；整套生成要求所有选中页就绪。旧接口未传修订仍兼容；旧项目 NULL 确认字段保留兼容口径，新向导必须明确确认。单页 regenerate 也检查内容确认与该页就绪状态。
- Slide 增加 `content_revision`、`generated_revision`、`modules`、`source_note`、`source_content`、`generated_content`、`source_available`、`content_ready`、`content_stale`、`config_stale`、`review_required`、`material_strategy`。源侧 `verify` 增加 `scope:"source_only",image_verified:false`，历史 `text_accuracy` 不代表生成图片已验证。老项目图片基线以初始修订 1 比较；风格 / 尺寸不一致通过生成时保存的配置判断，旧图片无配置记录则不猜测。
- 生图记录使用独立资产文件名，保存生成时的内容修订与输入快照。编辑内容保留当前旧图；生成不删除旧资产。这里只支持当前结果与原文核对，不提供 M5 的完整历史版本管理。数据页 `data_chart` 复用 `render_native.mjs` 绘制同单位原文数值与坐标轴，再通过 LibreOffice + PyMuPDF 转 PNG，不调用生图模型。转换器不可用时呈现原文文字、来源和未绘制图表的提示，费用 0；其它图片布局只允许模型呈现原文数据文字，不绘制数据坐标轴。缺失 / 待统计系列不画，绝不 `Number(null)` 变成 0。
- `POST /api/projects/{pid}/slides/{slide_id}/review`：body `{image_url}`，用户逐项核对原文与图片后确认。尚无结果 400，图片已更新 409，成功 `{ok:true}`；绑定当前资产路径，重新生成后失效。`export?kind=image|editable_hi` 在任何选中生成图片尚未核对时返回 400；导入原稿图片不要求生成核对，美化独立路由保持原逻辑。图片版导出仅包含 keep=1 的页。**前端**：第⑥步「下载图片集 PPT」在还有未核对页时弹一次确认（提示需逐页核对），确认后调用本接口批量标记，再请求 `export?kind=image`。
- 前端逐页与项目配置分别显示未保存 / 正在保存 / 已保存 / 保存失败；已保存仅来自服务端确认。保存队列串行，旧响应不覆盖更新的编辑；下一步、页面切换、导航（含后退）等待保存，失败停留并可重试，关闭 / 刷新有 beforeunload 保护。本机草稿按 `local-account + project_id + slide_id` 隔离，配置草稿使用 project 槽位；本系统无登录账户，`local-account` 明确指当前安装的本机使用身份，不声称具备跨账号身份隔离。内容冲突草稿保留，可重新加载后显式采用草稿；保存重试不提交生成。
- 数值清单仅比较原文与生成输入中的数字 / 单位 / 年份 / 待统计；图片文字没有 OCR 自动核验。结果始终先标「待核对」，用户对照原稿 / 真源与图片后手工确认。

## M3 风格与任务恢复

- `GET /api/projects/{pid}/jobs`：按创建顺序倒序返回 `{items:[Job]}`，包含持久化任务；工作台先恢复最新 generate 的 id，再查询该任务，刷新不提交生成。
- Job 保留现有 status 枚举，增加 `version`（服务端递增事件版本）、`pages_json`（按真实页号记录最后事件）、`counts:{queued,running,succeeded,failed}` 与 `task_status`。逻辑映射：页 queued/running/done/failed → queued/running/succeeded/failed；批次 done 且有成功与失败 → partial_success，全成功 → succeeded，全失败 → failed；取消 → cancelled。`done` 仍为已处理页数，包含失败。成功事件仅在非空资产落盘、尺寸有效且 slides 保存成功后发出。
- SSE 事件附带 `job_id,version,server_time`；前端只接纳当前订阅任务且非旧版本，断线保持最后确认状态并查询同一任务。GET 任务快照为恢复依据，不依赖页面完成顺序；轮询只读取实际状态。
- 生成中禁止相交页重复提交、修改内容；整册配置、页面清单、重新梳理亦拒绝冲突，HTTP 409，项目改名允许。排队页同样锁定。离开工作区不取消后台任务。
- `PATCH /projects/{pid}` 支持可选 `expected_updated_at`，不匹配返回 409。配置保存串行检查；时间戳提高至微秒 ISO8601。重新聚焦读取项目配置、任务与内容修订；未保存草稿保留，冲突由用户比较并明确选择本地或服务器版本。内容冲突可另存 JSON 副本。
- 图片列表的 image_url 仅在资产存在且非空时返回。`export?kind=image` 生成任务运行中返回 409，选中页缺资产返回 400 并报告数量；本阶段不支持部分图片版导出。生成中已有图仍可查看，标为上一版本；完整历史版本列表仍属 M5。
- 风格仅支持整册配置，首次生成覆盖全部参与页；单页重生成与失败页重试明确标明页号，保留成功页。图片生成按页，尺寸为实际输出配置；按图片版重建为独立已有图片转换能力。没有积分冻结/退款机制，失败调用的实际成本由用量账本记录；不声称自动退款。
- 保存 clean/dirty/saving/saved/save_failed 与结果核对 unreviewed/verified/needs_attention 独立于任务状态：现有中文保存状态维持原映射；review_required 为待核对，reviewed_image 绑定有效当前资产为已核对，内容/配置过期或缺资产需处理。本阶段没有新增自动 OCR 核验或 M4 计费确认。

M3 补充：上传替换原稿与 import-pages 在生成中同样返回 409，避免替换任务输入。Slide 额外提供独立 `task_state` 与 `result_check`，不将生成成功等同于人工核对通过。恢复查询失败时生成入口保持禁用；重新聚焦可重试只读恢复。重开遗留的配置草稿时先展示版本选择，不自动将未带服务器时间基线的旧草稿覆盖到项目。


## M5：中断终态、结果状态与单页版本

- 作业 `status` / `task_status` 增加 `interrupted`，表示进程在完成前退出，区别于供应商/生成失败 `failed`。中文原因：「服务重启，作业已中断；未完成页未生成，可重新生成」。启动恢复只处理无存活进程拥有的 `running` / `queued` / `cancelling`，不会改动 `done` / `failed` / `cancelled`，重复执行无副作用。新作业记录内部 `owner_pid`，存活进程及当前内存 worker 受到保护；本系统不支持自动续跑。
- `GET /api/jobs/{id}`：`pages_json` 中未完成页转为 `interrupted`，保留已完成/失败页；`counts.interrupted` 为明确中断页数，`version` 递增。缺少历史逐页记录时不虚构页数。SSE 终态事件新增 `{"type":"interrupted","job_id":"…","version":1,"message":"…","job":{…}}`，客户端关流并显示中断原因。
- `GET /api/projects/{pid}/slides`：新增 `current_version_id` 与 `versions` 数组。每项 `{id, number, current, created_at, generated_revision, image_url}`。编号来自实际存储记录的顺序；资产缺失时 `image_url=""`，历史记录保留，不能回退到不可访问资产。页状态明确区分 `done` / `failed` / `running|queued` / `pending` / `interrupted`；失败或中断页可能仍显示上一版本缩略图，不能视作当前任务成功。
- 每次成功的单页生成/重生成创建独立版本，保存资产路径、输入修订、输入内容、风格、尺寸、任务与渲染元数据。旧项目已有图片在启动时幂等登记一个真实历史版本；不会推断已丢失的更早版本。生成失败不覆盖旧资产或删除版本。
- 新增 `POST /api/projects/{pid}/slides/{slide_id}/versions/{version_id}/restore`，无请求体，返回 `{ok:true,current_version_id:"…"}`。仅切换此页结果，不修改当前内容，不删除任何版本，不调用模型、不计费。页不存在 404；版本不存在或资产不可访问 400；页面正在生成时 409。跨项目/跨页版本不能恢复。回退后根据该版本 `generated_revision` 重新计算 `content_stale`，界面显示「基于旧内容」。
- 单页重试与「按新内容重新生成」复用 `/quote` 的 `regenerate` 操作与既有 `/slides/{page_no}/regenerate` 的报价、确认、幂等提交；只处理指定页。一个失败页不会把其他已完成结果变成失败，项目可为 `partial_success`，作业终态仍按本次范围如实返回。
- 图片版导出只纳入 `keep=1`、`status=done` 且资产存在/非空的页；未就绪、失败、中断、运行中页面不进入范围。前端仍要求全部参与页完成并核对后开放导出（部分导出交互属 M6）。
- `GET /api/projects` 每项补齐与 `GET /api/projects/{pid}` 相同的 `resume_step` / 确认信息；项目列表与最近项目共用这一恢复阶段，不另行猜测。阶段 5 包括生成中、生成失败、中断和已有结果。

离线门禁 `make verify` / `make verify-fast` 为测试进程设置独立临时 `DECKFORGE_DATA`，进程环境优先于 `.env` 数据目录；不复制生产密钥，不改变真实数据库。测试与断言保持原样。

## M6：转换与导出快照

保留所有既有路由（含美化、旧 `GET /export`、`POST /editable` 与续跑）。新增：

| 方法 | 路径 | 契约 |
|---|---|---|
| POST | `/api/projects/{pid}/export-preview` | body `{kind:"image", page_nos?:number[]}`，省略范围为全部 `keep` 页；所选范围不能为空且只允许参与页。返回 `project_id,kind,page_nos,included[],excluded[],snapshot_token,capabilities[],note`。**`kind=native` 已下线**（旧 PptxGenJS 原生场景打包）；可编辑版请走「图片转可编辑」的 `kind=editable_hi`。 |
| POST | `/api/projects/{pid}/exports` | body `{kind,page_nos:number[]\|null,snapshot_token}`，必须提交预览 token；范围/版本/核对状态变化返回 409，重新预览确认。成功返回导出记录。 |
| GET | `/api/projects/{pid}/exports` | `{items:导出记录[]}`，按时间倒序，以项目 ID 关联，改名不影响查询。 |

`included[]` / `excluded[]`：`slide_id,page_no,display_order,version_id,version_number,content_stale,config_stale`；排除项另含中文 `reason`。按展示序号排序。未就绪、失败、中断、排队、运行、资产缺失、版本缺失、未核对页均明确排除。内容/配置过期保留旧成果并提示，导出不重新生成。

`capabilities[]`：`kind,label,available,reason`。图片版为本机装配；`editable_hi` 为第三方 `image-to-editable-ppt`（Harness 逐页精细重建，文字/图片/图形/背景分别拆分）能力，探测缺失原因如实返回。**不再有原生场景导出**：可编辑 PPTX 只能由 editppt 产出。转换仍走 M4 报价与幂等，费用未知为 `null`，不声明免费。

导出记录：`id,project_id,kind,pages,file,size_bytes,created_at,snapshot[],editable_pages[],passthrough_pages[]`。`file` 为可下载 `/files/...` URL；磁盘资产缺失时为空。历史无快照记录 `snapshot=[]`，不得推断版本。新图片产物在独立导出 ID 目录下，文件名含导出时的项目名与唯一 ID；装配使用图片裁片副本。此后重生成、回退、改内容、改名不修改已导出的 PPTX。重复装配不调用模型、不写模型费用，生成独立记录。

转换新现场保存 `deckforge_snapshot.json`（输入页 ID、版本 ID、版本序号与图片副本）；续跑复用该现场的版本，不读取新图片。无快照的旧现场保留原续跑能力，但成果 `snapshot=[]`，明确标为版本不可追溯；不推断旧版本。转换成功发布独立且含项目名的文件，并将版本快照写入 `exports.snapshot_json`。M4 转换指纹增加当前版本 ID。旧 GET 图片导出仍保留全页就绪/核对闸，成功装配改用不可变导出记录；部分导出使用新增接口。

M4 报价响应新增可选 `page_versions[]`（转换报价返回）：`page_no,display_order,version_id,version_number`，用于报价确认框显示版本绑定。续跑仍按原现场页清单/快照执行；报价框提示旧现场版本不可追溯。其他操作返回空数组。

## M7：列表筛选、键盘与异常恢复入口

- 不新增或更改服务端接口。项目列表与最近项目继续使用 `GET /api/projects` 返回的 `resume_step` 与 `status`，沿用与详情相同的阶段判断及恢复路由。
- 列表客户端筛选复用现有列表响应，hash 查询串为 `#/projects?q={项目名称}&stage={1..5}&status={服务端状态}`：名称不区分大小写并忽略首尾空格，阶段与状态精确匹配，缺省为全部。刷新、直链与后退从 query 恢复；空结果明确提示，清除按钮移除筛选。阶段/状态不由前端猜测。
- 向导已有按钮、表单与步骤导航沿用原生 Tab / Shift+Tab / Enter 操作（文本域 Enter 保持换行，不全局拦截）。风格大图与页面预览圈定焦点，Esc 关闭并回到触发元素；报价原生 dialog 明确模态语义并恢复焦点。导出在范围勾选确认后新增版本快照确认对话框，Esc / 返回不提交，确认后仍传原预览 token，漂移仍由服务端返回 409。
- 工作台失败/中断页复用 M5 单页重生成入口与修改内容入口；未就绪页提供内容确认/排除入口，内容就绪但无结果时提供单页生成入口。作业中断提示读取实际任务 `message`，不自动重提交；内容过期入口仍复用查看新内容与按新内容重新生成。
- 本轮验证记录见 `docs/acceptance-matrix.md`。浏览器键盘/窄屏验证尚未执行，不能将静态构建或隔离后端测试视作浏览器验收。
