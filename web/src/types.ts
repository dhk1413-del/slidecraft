/**
 * SlideCraft 前端类型定义 —— 字段名逐字对齐 docs/API.md（唯一权威）
 * 约定：时间 ISO8601 字符串；金额单位「元」；页号从 1 开始。
 */

/* ---------------- 1. 健康与配置 ---------------- */

export type ImageProviderId =
  | 'guaihub'
  | 'dashscope'
  | 'local_render'

export type TextProviderId = 'deepseek'

export type NetworkMode = 'http_proxy' | 'tun' | 'none'

export interface HealthResponse {
  ok: boolean
  version: string
  port: number
  db: string
  providers: {
    /** 各生图供应商是否已配置（local_render 为本地兜底，通常恒 true） */
    image: Record<ImageProviderId, boolean>
    text: Record<TextProviderId, boolean>
  }
  network: {
    mode: NetworkMode
    http_proxy?: string | null
  }
}

export interface ProviderSetting {
  id: ImageProviderId | 'qwen_vl'
  label: string
  base_url: string
  key_set: boolean
  key_masked: string
  default_model: string
  default_size: string
  needs_proxy: boolean
  unit_price_cny: number | null
  /** 视觉模型兜底：没单独填视觉 key，当前复用 GuaiHub 中转 key */
  fallback?: boolean
}

export interface TextSetting {
  id: TextProviderId
  key_set: boolean
  key_masked: string
  model: string
}

export interface SettingsResponse {
  providers: ProviderSetting[]
  text: TextSetting
  vision?: ProviderSetting
  network: { mode: NetworkMode; http_proxy?: string | null }
}

/** PUT /api/settings 的两种 body 形态：写 key/模型，或写网络模式 */
export interface SettingsKeyPayload {
  provider_id: ImageProviderId | 'qwen_vl'
  api_key?: string
  base_url?: string
  default_model?: string
  default_size?: string
  /** 单价（元/张）。传空字符串 = 清除覆盖，回落 yaml；未填时账本金额记 0，不代表免费。 */
  unit_price_cny?: string
}

export interface SettingsTextPayload {
  provider_id: TextProviderId
  api_key?: string
  model?: string
}

export interface SettingsNetworkPayload {
  network: { mode: NetworkMode }
}

export type SettingsPayload =
  | SettingsKeyPayload
  | SettingsTextPayload
  | SettingsNetworkPayload

export interface SettingsTestResponse {
  provider_id: string
  ok: boolean
  status: number
  latency_ms: number
  message: string
}

/* ---------------- 2. 风格包 ---------------- */

export type LayoutKey = string

export interface StylePack {
  id: string
  name: string
  category: string
  tags: string[]
  badge: string
  summary: string
  /** 主色（#RRGGBB） */
  accent: string
  /** 底色（#RRGGBB） */
  bg: string
  layouts: LayoutKey[]
  /** 封面缩略图 URL（style-packs/styles/<id>/previews/cover.png），没有则为空串 */
  cover?: string
  /** 全部预览图 URL（含封面）；没有则为空数组 */
  previews?: string[]
  preview_count: number
  source_type: string
  version: string
}

export interface LayoutInfo {
  key: LayoutKey
  title: string
  best_for: string
  slots: string[]
}

/** style.md front matter 解析出的颜色/字体令牌（形状由后端定，前端防御式读取） */
export type StyleTokens = Record<string, unknown>

export interface StylePackDetail extends StylePack {
  style_md: string
  prompt_md: string
  tokens: StyleTokens
}

export interface StylePackListResponse {
  items: StylePack[]
}

export interface LayoutListResponse {
  items: LayoutInfo[]
}

/* ---------------- 3. 项目 / 页面 ---------------- */

export type SourceType = 'markdown' | 'text' | 'docx' | 'pdf' | 'pptx' | 'image'

/** 「图片转可编辑」导入结果：每页一张原页图，已登记成 slides，可直接导出图片版或转可编辑。 */
export interface ImportPagesResponse {
  page_count: number
  renderer: string
  pages: Array<{ page_no: number; image_url: string; width: number; height: number }>
  image_deck: string
  editable: string
}
export type IntakeMode = 'doc' | 'paste'

export type ProjectStatus = 'draft' | 'parsed' | 'outlined' | 'generating' | 'done' | 'failed'

/** 列表页「下载」用的导出摘要（GET /api/projects 的 exports 字段，不含快照明细） */
export interface ProjectExportBrief {
  id: string
  kind: ExportKind | string
  /** 可下载的 /files/... 地址；磁盘资产缺失时为空串 */
  file: string
  pages: number
  size_bytes?: number
  created_at?: string
}

export interface Project {
  content_revisions?: Record<string,number>
  parsed_text?: string | null
  size?: string
  target_pages?: number
  page_drafts?: PageEditItem[]
  pages_confirmed?: boolean
  content_confirmed?: boolean
  resume_step?: number
  /** 项目封面：只取成品类图片（生成结果 / 美化结果 / 导入成品页），没有则为空 */
  cover_url?: string
  /** 该项目属于哪条流程：beautify（PPT 美化五步）/ wizard（文档生成向导） */
  flow?: 'beautify' | 'editable' | 'wizard' | string
  /** 已上传原稿在磁盘上的路径（美化流程恢复时用来取原稿文件名） */
  source_path?: string | null
  /** 该项目的历史导出记录，按时间倒序 */
  exports?: ProjectExportBrief[]

  id: string
  title: string
  source_type: SourceType | string
  /** 录入方式：doc（上传文档）/ paste（粘贴文本） */
  intake_mode?: IntakeMode | string
  page_count: number
  status: ProjectStatus | string
  style_pack_id: string
  created_at: string
  updated_at: string
}

export interface ProjectListResponse {
  items: Project[]
}

export interface CreateProjectPayload {
  title: string
  source_type: SourceType
  intake_mode: IntakeMode
}

export interface UploadResponse {
  parsed_text: string
  char_count: number
  suggested_pages: number
  warnings: string[]
  /** 降级提示（无 key 时后端可能附带） */
  hint?: string
  fellback?: string
}

/** 上传 PPTX 原稿的逐页预览（与目标页清单没有映射关系）。 */
export interface SourcePage {
  page_no: number
  thumb_url: string
  width: number
  height: number
}

export interface SourcePagesResponse {
  page_count: number
  ready: boolean
  generating: boolean
  pages: SourcePage[]
  /** 预览转换失败时的降级原因；不影响原稿生成流程。 */
  error?: string
}

export interface OutlinePage {
  page_no: number
  title: string
  /** cover / section / content / data / summary ... */
  role: string
  outline: string
  points: string[]
  /** 该页所属章节号（1 起；后端按素材真实标题层级归纳） */
  chapter_no?: number
  chapter_title?: string
}

/** 章节区间汇总：大纲编辑器左侧章节栏用之（页码为真实页序） */
export interface OutlineChapter {
  chapter_no: number
  title: string
  page_from: number
  page_to: number
  page_count: number
}

export interface OutlineResponse {
  pages: OutlinePage[]
  chapters?: OutlineChapter[]
  /** 无 DeepSeek key 时为 false + fellback: "local_split" */
  configured?: boolean
  reason?: string
  hint?: string
  fallback?: string
  fellback?: string
}

/** 人工确认/编辑页清单的条目 */
export interface PageEditItem {
  revision?: number
  page_no: number
  title: string
  keep: boolean
  layout: LayoutKey
  /** 章节归属：大纲编辑器里可改，随 PUT /pages 一并落库 */
  chapter_no?: number
  chapter_title?: string
}

export interface PagesPayload {
  pages: PageEditItem[]
}

export interface GenerationJob {
  job_id: string
  configured: boolean
  progress_url: string
  reason?: string
  hint?: string
  fellback?: string
}

export interface ContentModule { type?: string; title?: string; text?: string; unit?: string; cells?: (string | number | null)[][] }
export interface SlideVersion {id:string;number:number;current:boolean;created_at:string;generated_revision:number|null;image_url:string}

export interface Slide {
  current_version_id?: string
  versions?: SlideVersion[]
  source_available?: number
  content_revision?: number
  generated_revision?: number
  content_stale?: boolean
  config_stale?: boolean
  review_required?: boolean
  content_ready?: boolean
  source_note?: string
  modules?: ContentModule[]
  source_content?: unknown
  generated_content?: unknown
  slide_id: string
  source_page_no?: number | null
  display_order?: number
  keep?: boolean | number
  role?: string
  layout?: string
  outline?: string
  points?: string[]
  /** 所属章节（幻灯片行自带的章节列，用于大纲编辑器分栏） */
  chapter_no?: number
  chapter_title?: string

  page_no: number
  title: string
  image_url: string
  width: number
  height: number
  /** done / running / failed / pending */
  status: string
  editable: boolean
  /** 原生 PPTX 场景的构建状态；legacy_overlay 表示旧版 PNG 叠字，不能算完整可编辑。 */
  native_status?: 'pending' | 'building' | 'ready' | 'failed' | 'legacy_overlay' | 'stale' | string
  native_object_count?: number
  native_warnings?: string[]
  provider: string
  model: string
  size: string
  cost_cny: number
  latency_ms: number
  /** 降级/失败原因（后端 slides 行原样返回）：生图失败降级到本地渲染时会写明尝试次数与链路。 */
  error?: string
  verify: {
    text_accuracy: number
    issues: string[]
  }
}

export interface SlidesResponse {
  items: Slide[]
}

export interface EditableEstimate {
  pages: number
  seconds: number
  cost_cny: number | null
}

export type EditableEngineId = 'editppt'

export interface EditableEngine {
  id: EditableEngineId
  name: string
  ok: boolean
  reason?: string
  seconds_per_page: number
  cost_note?: string
  note?: string
  cli?: string
  skill_dir?: string
}

export interface EditableResponse {
  job_id: string
  estimate: EditableEstimate
  engine?: EditableEngineId
  mode?: 'native_pptx' | 'editppt_skill' | string
  message?: string
  resume?: boolean
}

/** 高精度转换的现场状态（GET /projects/{id}/editppt） */
export interface EditpptStatus {
  has_run: boolean
  run_name?: string
  run_dir?: string
  pages: { page_id: string; status: string }[]
  /** 现场记录的页清单：续跑要按同一顺序映射，界面据此预选 */
  page_nos: number[]
  recorded: number
  total: number
  resumable: boolean
  cancelled: boolean
  note?: string
}

/** `editable`（内置引擎整册可编辑）已于 2026-09-21 下线，后端对该 kind 直接 400，故不再列入。 */
export type ExportKind = 'image' | 'editable_hi'

export interface ExportResponse {
  kind: ExportKind
  file: string
  size_bytes?: number
  pages: number
  editable_pages: number[]
  passthrough_pages?: number[]
  native_pages?: number[]
  skipped_pages?: number[]
  engine?: EditableEngineId
  note?: string
  created_at?: string
  path?: string
}

/* ---------------- SSE 事件 ---------------- */

export interface JobProgressEvent {
  job_id?: string
  version?: number
  type: 'progress'
  page: number
  total: number
  /** generate / vision / assemble / editable / verify ... */
  stage: string
  /** running（页内某阶段开始）/ done / failed */
  status: string
  message: string
  /** 后端页号（与「勾选页」一致）；`page` 是本次任务内的第几页 */
  page_no?: number
  /** 已完成页数（skill 引擎的任务级事件用这个推进度；generate/builtin 用逐页 status 事件） */
  done?: number
  /** 该页从开始处理到这条事件的累计耗时（毫秒） */
  elapsed_ms?: number
  fellback?: string
  image_url?: string
}

export interface JobDoneEvent {
  type: 'done'
  deck_id?: string
}

export interface JobErrorEvent {
  type: 'error'
  message: string
}

export interface JobCancelledEvent {
  type: 'cancelled'
  message: string
}

/* ---------------- 4. 用量账本 ---------------- */

export interface UsageItem {
  project_id?:string
  page_no?:number
  job_id?:string
  id: string
  ts: string
  action: string
  provider: string
  model: string
  size: string
  cny: number
  latency_ms: number
  ok: boolean
  detail: string
}

export interface UsageResponse {
  by_project?:Array<{project_id:string|null;title:string;cny:number;count:number}>
  total_cny: number
  by_action: Array<{ action: string; cny: number; count: number }>
  by_provider: Array<{ provider: string; cny: number; count: number }>
  items: UsageItem[]
}

export type UsageRange = 'today' | 'week' | 'month' | 'all'

/** 供应商面板侧累计用量（New API 计费接口）：只给累计值 + 与上次快照的差额 */
export interface ProviderUsageDelta {
  total_usage: number
  used_usd: number | null
  used_cny: number | null
  previous_ts: string
  previous_total: number
}

export interface ProviderUsageItem {
  provider_id: string
  label: string
  ok: boolean
  cached: boolean
  /** 面板展示币种：USD | CNY | TOKENS */
  currency: string
  total_usage: number | null
  used_usd: number | null
  used_cny: number | null
  exchange_rate: number | null
  unlimited: boolean | null
  limit_usd: number | null
  limit_remaining_usd: number | null
  quota_per_unit: number | null
  fetched_at: string
  duration_ms: number
  error: string
  scope_note: string
  delta: ProviderUsageDelta | null
  first_snapshot: boolean
}

export interface ProviderUsageResponse {
  items: ProviderUsageItem[]
  fetched_at: string
  cache_seconds: number
  note: string
}

/* ---------------- 6. PPT 备注（上传已有 pptx → 逐页讲稿备注 → 写回备注栏） ---------------- */

export interface NotesPage {
  id: string
  job_id: string
  page_no: number
  /** 幻灯片文本框/表格里提取到的文字 */
  text_source: string
  pic_count: number
  /** 原文件该页已有的备注（导出时默认保留在 AI 备注上方） */
  note_original: string
  has_original_note: boolean
  /** 1 = 文字极少的图片页，必须靠画面识别 */
  low_info: number
  image_url: string
  vision_status: 'pending' | 'done' | 'failed' | 'skipped'
  vision_model?: string
  vision_ms?: number
  vision_cost_cny?: number
  /** 视觉识别结果：{title, text_on_page[], visual, data[]} */
  vision: { title?: string; text_on_page?: string[]; visual?: string; data?: Array<{ label?: string; value?: string; unit?: string }> }
  note: string
  note_status: 'pending' | 'running' | 'done' | 'failed'
  note_model?: string
  note_ms?: number
  note_cost_cny?: number
  /** 1 = 人工改过 */
  note_edited: number
  note_prompt?: string
  error?: string
}

export interface NotesJob {
  id: string
  title: string
  source_name: string
  source_path: string
  pages: number
  /** 文字极少的图片页数量 */
  image_pages: number
  notes_existing: number
  status: 'uploaded' | 'analyzing' | 'analyzed' | 'generating' | 'done' | 'failed'
  export_path?: string
  cost_cny: number
  error?: string
  created_at: string
  updated_at: string
}

/** POST /api/notes/{nid}/render：按需渲染原页（幂等；第二次 rendered=false） */
export interface NotesRenderResponse {
  rendered: boolean
  page_count: number
  pages: Array<{ page_no: number; image_url: string }>
}

export interface NotesJobDetail extends NotesJob {
  pages_detail: NotesPage[]
  notes_done: number
  notes_failed: number
  size_bytes?: number
  hint?: string
}

export interface NotesListResponse {
  items: NotesJob[]
}

/** auto = 只识别文字少的图片页（推荐）；all = 每页都识别；off = 不识别 */
export type VisionMode = 'auto' | 'all' | 'off'

export interface NotesJobResponse {
  job_id: string
  progress_url: string
  vision_mode?: VisionMode
}

export interface NotesExportResponse {
  file: string
  name: string
  pages: number
  skipped_pages: number[]
  kept_original: boolean
  size_bytes: number
}

/* ---------------- PPT 美化 v2（docs/BEAUTIFY_V2.md §6） ---------------- */
export interface BeautifyPage {
  page_no: number
  origin_url: string
  beauty_url: string
  beauty_ok: boolean
  text_source: string
  /** 该页是否勾选「保留原图」：勾了会按坐标把原页图片原样贴回 */
  keep_material?: boolean
  /** 实际贴回的图片张数（0 表示该页没有页内图片元素） */
  preserved_pictures?: number
  /** 上一次「优化本页」填写的修改要求（空串表示没填过） */
  instruction?: string
  /** 已归档的历史版本数 */
  version_count?: number
  /** 当前图来自哪个历史版本（恢复过才有） */
  restored_from?: string
}

/** 单页历史版本（GET /beautify/pages/{no}/versions） */
export interface BeautifyVersionsResponse {
  page_no: number
  /** 正在使用的图；没有结果时为空串 */
  current: string
  versions: Array<{ id: string; created_at: string; instruction: string; size_bytes: number; url: string }>
}

export interface BeautifyContentPage {
  page_no: number
  title: string
  points: string[]
  texts: string[]
  source: 'pptx' | 'pdf' | 'none' | 'user'
  keep_material: boolean
}

export interface BeautifyContentPlan {
  source_revision: string
  page_nos: number[]
  pages: BeautifyContentPage[]
}

export interface BeautifyStatus {
  page_nos?: number[]
  /** 内容梳理是否已保存并确认（磁盘上存在与当前原稿匹配的 content.json） */
  content_saved?: boolean
  /** 美化现场最后更新时间：单页重生成后用它给图片加版本参数，避免浏览器用到旧缓存 */
  updated_at?: string
  mode: 'img2img' | 'redesign'
  phase: '' | 'preview' | 'full' | 'done'
  page_count: number
  rendered: number
  confirmed: boolean
  /** 服务端逐页生成并发上限（前端据此提示分批，不写死数字） */
  concurrency?: number
  pages: BeautifyPage[]
  /** 按需精细重建（image-to-editable-ppt）的最近一次结果 */
  editable_engine?: { ok: boolean; engine?: string; path?: string; seconds?: number; message?: string; warnings?: string[]; run_dir?: string; pages?: number }
  exports: { editable?: string; image?: string }
  cost: {
    total_cny: number
    image_calls: number
    failed_calls: number
    price_configured: boolean
    by_provider: Array<{ provider: string; cny: number; count: number; failed: number }>
    note: string
  }
  warnings: string[]
}

export interface BeautifyJobResponse {
  job_id: string
  progress_url: string
  page_count?: number
  message?: string
  remaining_pages?: number
}
