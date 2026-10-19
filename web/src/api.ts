/**
 * SlideCraft API 客户端 —— 全部请求走 /api（标准部署由 8641 后端托管；开发模式由 Vite proxy 转 127.0.0.1:8640）
 * 错误统一抛 ApiError（含后端 {detail} 中文信息 + 网络层可读信息）。
 */
import { BACKEND_HINT } from './lib/format'
import type {
  BeautifyJobResponse,
  BeautifyStatus,
  BeautifyVersionsResponse,
  CreateProjectPayload,
  EditableResponse,
  ExportKind,
  ExportResponse,
  GenerationJob,
  HealthResponse,
  ImportPagesResponse,
  LayoutListResponse,
  NotesExportResponse,
  NotesJobDetail,
  NotesJobResponse,
  NotesListResponse,
  OutlineResponse,
  PagesPayload,
  Project,
  ProjectListResponse,
  ProviderUsageResponse,
  EditableEngine,
  EditableEngineId,
  EditpptStatus,
  SettingsPayload,
  SettingsResponse,
  SettingsTestResponse,
  Slide,
  SlidesResponse,
  SourcePagesResponse,
  StylePackDetail,
  StylePackListResponse,
  UploadResponse,
  UsageRange,
  UsageResponse,
  VisionMode,
} from './types'

const API_BASE = '/api'

/** 业务错误：带 HTTP 状态与中文 detail，便于前端给出「缺什么 + 去哪 + 怎么重试」 */
export class ApiError extends Error {
  readonly status: number
  readonly detail: string
  readonly offline: boolean

  constructor(message: string, status: number, offline = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = message
    this.offline = offline
  }
}

/** 用户在操作确认框点「返回」或按 Esc 取消：不是失败，调用方应给中性提示而非错误态。 */
export class SubmissionCancelled extends Error {
  constructor() {
    super('已取消，未提交')
    this.name = 'SubmissionCancelled'
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let detail = `请求失败（HTTP ${res.status}）`
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'detail' in body) {
      const d = (body as { detail: unknown }).detail
      if (typeof d === 'string' && d.trim()) detail = d
    }
  } catch {
    /* 非 JSON 响应，保留默认文案 */
  }
  return new ApiError(detail, res.status)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, init)
  } catch {
    // 服务未启动或网络中断时，使用共享的标准部署提示。
    throw new ApiError(BACKEND_HINT, 0, true)
  }
  if (!res.ok) throw await toApiError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/* ---------------- 1. 健康与配置 ---------------- */

export const getHealth = () => request<HealthResponse>('/health')

export const getSettings = () => request<SettingsResponse>('/settings')

export const putSettings = (payload: SettingsPayload) =>
  request<SettingsResponse>('/settings', jsonInit('PUT', payload))

export const testProvider = (provider_id: string, api_key?: string) =>
  request<SettingsTestResponse>(
    '/settings/test',
    jsonInit('POST', { provider_id, ...(api_key ? { api_key } : {}) }),
  )

/* ---------------- 2. 风格包 ---------------- */

export const listStylePacks = () => request<StylePackListResponse>('/style-packs')

export const getStylePack = (id: string) =>
  request<StylePackDetail>(`/style-packs/${encodeURIComponent(id)}`)

export const listLayouts = () => request<LayoutListResponse>('/layouts')

/* ---------------- 3. 项目 / 页面 ---------------- */

export const listProjects = () => request<ProjectListResponse>('/projects')

export const createProject = (payload: CreateProjectPayload) =>
  request<{ id: string }>('/projects', jsonInit('POST', payload))

export const getProject = (id: string) => request<Project>(`/projects/${encodeURIComponent(id)}`)

/** 删除项目：记录、原稿/成图、导出件、转换现场一并删除；用量账本的成本记录保留（不抹账）。 */
export interface DeleteProjectResponse {
  ok: boolean
  id: string
  title: string
  deleted: Record<string, number>
  files: Record<string, number>
  usage_log_kept: number
  note: string
}
export const deleteProject = (id: string) =>
  request<DeleteProjectResponse>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const configureProject = (id: string, payload: { expected_updated_at?:string; title?: string; style_pack_id?: string; size?: string; target_pages?: number; confirm_content?: boolean; page_drafts?: PagesPayload['pages'] }) =>
  request<Project>(`/projects/${encodeURIComponent(id)}`, jsonInit('PATCH', payload))

/** 「图片转可编辑」：上传 PDF / 图片 / pptx，逐页渲染并登记成 slides（多张图片按顺序拼成一册）。 */
export async function importPages(id: string, files: File[]): Promise<ImportPagesResponse> {
  const form = new FormData()
  files.forEach((f) => form.append('files', f))
  let res: Response
  try {
    res = await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}/import-pages`, { method: 'POST', body: form })
  } catch {
    throw new ApiError(BACKEND_HINT, 0, true)
  }
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as ImportPagesResponse
}

/** 上传原稿；粘贴文本场景前端包成 File 复用同一接口 */
export async function uploadSource(id: string, file: File): Promise<UploadResponse> {
  const form = new FormData()
  form.append('file', file)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}/upload`, {
      method: 'POST',
      body: form,
    })
  } catch {
    throw new ApiError(BACKEND_HINT, 0, true)
  }
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as UploadResponse
}

export const postOutline = (id: string, target_pages: number, page_minutes: number) =>
  request<OutlineResponse>(
    `/projects/${encodeURIComponent(id)}/outline`,
    jsonInit('POST', { target_pages, page_minutes }),
  )

export const putPages = (id: string, payload: PagesPayload) =>
  request<{ ok?: boolean } & Record<string, unknown>>(
    `/projects/${encodeURIComponent(id)}/pages`,
    jsonInit('PUT', payload),
  )

export const getSourcePages = (id: string) =>
  request<SourcePagesResponse>(`/projects/${encodeURIComponent(id)}/source-pages`)

export const generate = (
  id: string,
  payload: { style_pack_id: string; size: string; page_nos: number[]; content_revisions?: Record<string,number> },
) =>
  confirmedSubmission<GenerationJob>(id, `/projects/${encodeURIComponent(id)}/generate`, 'generate', payload)

/** /slides 后端可能返回 {items:[...]} 或裸数组，这里做一次兼容归一 */
export async function getSlides(id: string): Promise<Slide[]> {
  const raw = await request<SlidesResponse | Slide[]>(`/projects/${encodeURIComponent(id)}/slides`)
  if (Array.isArray(raw)) return raw
  return raw.items ?? []
}

export const regenerateSlide = (id: string, page_no: number, content_revisions?:Record<string,number>) =>
  confirmedSubmission<GenerationJob>(id, `/projects/${encodeURIComponent(id)}/slides/${page_no}/regenerate`, 'regenerate', {content_revisions,page_nos:[page_no]})

/** 「图片转可编辑」的引擎：只有第三方 skill 的精细重建（内置引擎/本地渲染已下线） */
export const editableEngines = () => request<{ engines: EditableEngine[] }>('/editable-engines')

/** 精细重建的现场状态（已记录/总页数、是否可续跑） */
export const editpptStatus = (id: string) =>
  request<EditpptStatus>(`/projects/${encodeURIComponent(id)}/editppt`)

/** 停止正在跑的高精度转换：已完成的页与现场都保留，之后可「继续转换」 */
export const cancelEditable = (id: string) =>
  request<{ ok: boolean; message: string }>(
    `/projects/${encodeURIComponent(id)}/editable/cancel`,
    jsonInit('POST', {}),
  )

export type SubmissionPhase = 'quote' | 'submit'
export const toEditable = (
  id: string,
  page_nos: number[],
  engine: EditableEngineId = 'editppt',
  resume = false,
  onPhase?: (phase: SubmissionPhase) => void,
) =>
  confirmedSubmission<EditableResponse>(id, `/projects/${encodeURIComponent(id)}/editable`, 'editable', {page_nos,engine,resume}, onPhase)

export const exportDeck = (id: string, kind: ExportKind) =>
  request<ExportResponse>(`/projects/${encodeURIComponent(id)}/export?kind=${kind}`)

/* ---------------- 4. 用量账本 ---------------- */

export const getUsage = (range: UsageRange = 'month') =>
  request<UsageResponse>(`/usage?range=${range}`)

/** 供应商面板侧累计用量（New API 计费接口）。只读、不花钱；refresh=true 绕过 60 秒缓存 */
export const getProviderUsage = (refresh = false) =>
  request<ProviderUsageResponse>(`/provider-usage${refresh ? '?refresh=1' : ''}`)

/* ---------------- 6. PPT 备注（上传已有 pptx → 讲稿备注 → 写回备注栏） ---------------- */

export const listNotes = () => request<NotesListResponse>('/notes')

/** 上传 .pptx：秒回页清单（页数/图片页数量/已有备注页），不做任何花钱的调用 */
export async function uploadNotesPptx(file: File): Promise<NotesJobDetail> {
  const form = new FormData()
  form.append('file', file)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/notes/upload`, { method: 'POST', body: form })
  } catch {
    throw new ApiError(BACKEND_HINT, 0, true)
  }
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as NotesJobDetail
}

export const getNotesJob = (nid: string) =>
  request<NotesJobDetail>(`/notes/${encodeURIComponent(nid)}`)

export const deleteNotesJob = (nid: string) =>
  request<{ ok: boolean }>(`/notes/${encodeURIComponent(nid)}`, { method: 'DELETE' })

/** 建立内容真源：渲染 + 画面识别（vision_mode: auto / all / off） */
export const analyzeNotes = (nid: string, vision_mode: VisionMode = 'auto', page_nos?: number[]) =>
  request<NotesJobResponse>(
    `/notes/${encodeURIComponent(nid)}/analyze`,
    jsonInit('POST', { vision_mode, ...(page_nos ? { page_nos } : {}) }),
  )

/** 写备注；instruction 为「用提示词让 AI 重写」的自由要求。
 *  only_missing=true 表示「续跑」：只补没写成功的页，不重跑已完成页。 */
export const generateNotes = (nid: string, page_nos?: number[], instruction = '', only_missing = false) =>
  request<NotesJobResponse>(
    `/notes/${encodeURIComponent(nid)}/generate`,
    jsonInit('POST', { ...(page_nos ? { page_nos } : {}), instruction, only_missing }),
  )

export const regenerateNote = (nid: string, page_no: number, instruction = '') =>
  request<NotesJobResponse>(
    `/notes/${encodeURIComponent(nid)}/pages/${page_no}/regenerate`,
    jsonInit('POST', { instruction }),
  )

export const saveNote = (nid: string, page_no: number, note: string) =>
  request<{ ok: boolean; note: string; note_status: string }>(
    `/notes/${encodeURIComponent(nid)}/pages/${page_no}`,
    jsonInit('PATCH', { note }),
  )

export const exportNotes = (nid: string, keep_original = true) =>
  request<NotesExportResponse>(
    `/notes/${encodeURIComponent(nid)}/export`,
    jsonInit('POST', { keep_original }),
  )

/* ---------------- 5. 任务进度 SSE ---------------- */

export const cancelJob = (jobId: string) =>
  request<{ ok: boolean; job_id: string; status: 'cancelling'; message: string }>(`/jobs/${encodeURIComponent(jobId)}/cancel`, jsonInit('POST', {}))

export interface JobStreamHandlers {
  onInterrupted?: (evt: {message:string;job_id?:string;version?:number}) => void
  onCancelled?: (evt: import('./types').JobCancelledEvent) => void
  onEvent?: (evt: unknown) => void
  onProgress?: (evt: import('./types').JobProgressEvent) => void
  onDone?: (evt: import('./types').JobDoneEvent) => void
  onError?: (evt: import('./types').JobErrorEvent) => void
  /** 连接层失败（后端没起 / 连接断开） */
  onTransportError?: () => void
}

/**
 * 订阅任务进度：GET /api/jobs/{job_id}/stream（text/event-stream）
 * 返回关闭函数。契约里事件名为默认 message + JSON 内的 type 字段；
 * 同时兼容后端使用具名事件（event: progress）。
 */
export function openJobStream(jobId: string, handlers: JobStreamHandlers): () => void {
  const es = new EventSource(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/stream`)
  let closed = false

  const dispatch = (raw: string) => {
    if (!raw || closed) return
    let evt: unknown
    try {
      evt = JSON.parse(raw)
    } catch {
      return
    }
    handlers.onEvent?.(evt)
    const type = (evt as { type?: string }).type
    if (type === 'done' || type === 'error' || type === 'cancelled' || type === 'interrupted') {
      closed = true
      es.close()
    }
    if (type === 'progress') handlers.onProgress?.(evt as import('./types').JobProgressEvent)
    else if (type === 'done') handlers.onDone?.(evt as import('./types').JobDoneEvent)
    else if (type === 'interrupted') handlers.onInterrupted?.(evt as {message:string;job_id?:string;version?:number})
    else if (type === 'cancelled') handlers.onCancelled?.(evt as import('./types').JobCancelledEvent)
    else if (type === 'error') handlers.onError?.(evt as import('./types').JobErrorEvent)
  }

  es.onmessage = (e) => dispatch(e.data)
  for (const name of ['progress', 'done', 'error', 'cancelled', 'interrupted']) {
    es.addEventListener(name, (e) => dispatch((e as MessageEvent<string>).data))
  }
  es.onerror = () => {
    if (closed) return
    // done 之后后端会关流，这里统一交给上层判断是否已结束
    handlers.onTransportError?.()
  }
  es.onopen = () => {
    /* 连接建立，无需额外提示 */
  }

  return () => {
    closed = true
    es.close()
  }
}

/* ---------------- PPT 美化 v2 ---------------- */
export const prepareBeautifyContent = (id: string, body: { page_nos: number[]; keep_material_page_nos: number[] }) =>
  request<import('./types').BeautifyContentPlan>(`/projects/${id}/beautify/content`, jsonInit('POST', body))

export const saveBeautifyContent = (id: string, body: import('./types').BeautifyContentPlan) =>
  request<import('./types').BeautifyContentPlan>(`/projects/${id}/beautify/content`, jsonInit('PUT', body))

export const beautifyPreview = (id: string, body: { style_pack_id: string; mode: 'img2img' | 'redesign'; preview_pages?: number; page_nos?: number[] }) =>
  request<BeautifyJobResponse>(`/projects/${id}/beautify/preview`, jsonInit('POST', body))

export const beautifyContinue = (id: string, body: { style_pack_id: string; mode: 'img2img' | 'redesign'; size?: string; page_nos?: number[] }) =>
  request<BeautifyJobResponse>(`/projects/${id}/beautify/continue`, jsonInit('POST', body))

/** 按需把已生成的美化图片版转成原生可编辑版（生成图片时**不再自动执行**） */
export const beautifyEditable = (id: string, body: { style_pack_id?: string } = {}) =>
  request<BeautifyJobResponse>(`/projects/${id}/beautify/editable`, jsonInit('POST', body))

/** 只重生成指定一页（非破坏性：其它页的美图与导出不动）。
 *  带 `instruction` 即「优化本页」：在逐字保留与不编造规则内尽量满足用户的修改要求。 */
export const beautifyRegeneratePage = (id: string, pageNo: number, body: { style_pack_id?: string; mode?: 'img2img' | 'redesign'; size?: string; instruction?: string }) =>
  request<BeautifyJobResponse>(`/projects/${id}/beautify/pages/${pageNo}/regenerate`, jsonInit('POST', body))

/** 该页历史版本：current 是正在使用的图，versions 是已归档的旧版 */
export const beautifyVersions = (id: string, pageNo: number) =>
  request<BeautifyVersionsResponse>(`/projects/${id}/beautify/pages/${pageNo}/versions`)

/** 恢复到某个历史版本（恢复前会先归档当前图，可再切回） */
export const beautifyRestoreVersion = (id: string, pageNo: number, versionId: string) =>
  request<BeautifyJobResponse>(`/projects/${id}/beautify/pages/${pageNo}/versions/${encodeURIComponent(versionId)}/restore`, jsonInit('POST', {}))

export const getBeautify = (id: string) => request<BeautifyStatus>(`/projects/${id}/beautify`)
export const beautifyOrigin = (id: string) => request<{ page_count: number; renderer: string; pages: Array<{ page_no: number; image_url: string; width: number; height: number }> }>(`/projects/${id}/beautify/origin`, jsonInit('POST', {}))

export const saveSlideContent = (pid:string, sid:string, payload: {revision:number; title:string; outline:string; points:string[]; modules:import('./types').ContentModule[]; source_note:string}) => request<Slide>(`/projects/${encodeURIComponent(pid)}/slides/${encodeURIComponent(sid)}/content`,jsonInit('PATCH',payload))
export const reviewSlide = (pid:string, sid:string, image_url:string) => request<{ok:boolean}>(`/projects/${encodeURIComponent(pid)}/slides/${encodeURIComponent(sid)}/review`,jsonInit('POST',{image_url}))

export const retrySlideOutline = (pid:string,sid:string,revision:number) => request<Slide>(`/projects/${encodeURIComponent(pid)}/slides/${encodeURIComponent(sid)}/outline-retry`,jsonInit('POST',{revision}))

export interface TaskSnapshot {updated_at?:string;id:string; kind:string; status:string; total:number; done:number; message:string; version:number; pages_json:string}
export const getJob = (id:string) => request<TaskSnapshot>(`/jobs/${encodeURIComponent(id)}`)
export const getProjectJobs = (id:string) => request<{items:TaskSnapshot[]}>(`/projects/${encodeURIComponent(id)}/jobs`)

interface OperationQuote {
  quote_id:string; operation_name:string; page_nos:number[]; final_scope:number[];
  content_revisions:Record<string,number>; style_revision:string; mode:string;
  unit_price_cny:number|null; total_cny:number|null; billable_pages:number[];
  page_versions?:Array<{page_no:number;display_order:number;version_id:string|null;version_number:number|null}>;
  cancellable:boolean; estimated_time:string; failure_policy:string; price_note:string;
}
const operationBusy = new Set<string>()

/** 幂等键：crypto.randomUUID 只在安全上下文（HTTPS/localhost）可用，局域网 HTTP 要自己兜底。 */
function newSubmissionKey(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function confirmOperation(q:OperationQuote):Promise<boolean> {
  return new Promise(resolve=>{
    const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null
    const editable=q.operation_name.includes('可编辑')||q.mode.includes('重建')
    const dialog=document.createElement('dialog')
    dialog.setAttribute('aria-modal','true')
    dialog.setAttribute('aria-label',editable?'确认精细重建可编辑页':'确认'+q.operation_name)
    dialog.className='card'
    // Tailwind 预检会把 dialog 的 margin 归零，导致 showModal 贴左上；这里显式恢复居中。
    dialog.style.cssText='max-width:640px;width:92vw;max-height:85vh;overflow:auto;margin:auto;position:fixed;inset:0;z-index:60'
    const title=document.createElement('h2');title.textContent=editable?'确认精细重建可编辑页':'确认'+q.operation_name;dialog.append(title)
    const lines:string[]=[]
    lines.push(`所选页：${q.page_nos.join('、')}`)
    lines.push(`最终范围：${q.final_scope.join('、')}（${q.final_scope.length} 页）`)
    if(editable){
      lines.push('模式：精细重建（文字/图片/图形/背景分别拆分）')
      lines.push(`预计耗时：${q.estimated_time}`)
      lines.push(`费用：${q.price_note || '本机模型额度；账本金额记 0，不代表免费'}`)
      lines.push(`是否可取消：${q.cancellable?'可在检查点取消，正在执行的调用需等待':'不可取消'}`)
      lines.push('产物：仅包含所转页面；每页通过 validation 校验')
      lines.push(`失败时费用处理：${q.failure_policy}`)
    }else{
      lines.push(`内容修订：${Object.entries(q.content_revisions).map(([id,r])=>`${id} / ${r}`).join('；')}`)
      lines.push(`风格：${q.style_revision}`)
      lines.push(`模式：${q.mode}`)
      lines.push(q.unit_price_cny===null?'单价未配置':`单价：${q.unit_price_cny} 元 / 页；调用生图页：${q.billable_pages.join('、') || '无'}`)
      lines.push(q.total_cny===null?'总额未知':`预估总额：${q.total_cny} 元`)
      lines.push(q.price_note)
      lines.push(`是否可取消：${q.cancellable?'可在检查点取消，正在执行的调用需等待':'不可取消'}`)
      lines.push(`预计耗时：${q.estimated_time}`)
      lines.push(`失败时费用处理：${q.failure_policy}`)
    }
    if(q.page_versions?.length){
      lines.push('转换绑定版本：'+q.page_versions.map(p=>`第 ${p.page_no} 页 / 序号 ${p.display_order} / V${p.version_number ?? '未知'}`).join('；'))
      lines.push('续跑以原转换现场版本为准；旧现场无快照时版本不可追溯。转换完成产物固定为该输入版本快照。')
    }
    for(const line of lines){const p=document.createElement('p');p.textContent=line;p.className='text-body-sm';p.style.cssText='margin:0 0 6px;line-height:1.55';dialog.append(p)}
    const footer=document.createElement('div');footer.style.cssText='display:flex;gap:12px;justify-content:flex-end;margin-top:16px'
    const cancel=document.createElement('button');cancel.className='btn btn-secondary';cancel.textContent='返回'
    const accept=document.createElement('button');accept.className='btn btn-primary'
    accept.textContent=editable?`确认精细重建 ${q.final_scope.length} 页`:`确认${q.mode.includes('重建')?'转换':'生成'} ${q.final_scope.length} 页 · ${q.total_cny===null?'单价未配置':`预估 ${q.total_cny} 元`}`
    const finish=(value:boolean)=>{dialog.close();dialog.remove();if(trigger?.isConnected)trigger.focus();resolve(value)}
    dialog.addEventListener('click',e=>{if(e.target===dialog)finish(false)})
    cancel.onclick=()=>finish(false);accept.onclick=()=>{accept.disabled=true;finish(true)}
    dialog.oncancel=e=>{e.preventDefault();finish(false)}
    footer.append(cancel,accept);dialog.append(footer);document.body.append(dialog);dialog.showModal();cancel.focus()
  })
}
async function confirmedSubmission<T>(pid:string,path:string,operation:string,body:Record<string,unknown>,onPhase?:(phase:SubmissionPhase)=>void):Promise<T> {
  const slot=`deckforge:submission:${pid}:${operation}`
  if(operationBusy.has(slot)) throw new ApiError('正在确认或提交，请等待',409)
  operationBusy.add(slot)
  try {
    const stored=localStorage.getItem(slot)
    let pending: {key:string;quote_id:string;path:string;body:Record<string,unknown>}|null=stored?JSON.parse(stored):null
    if(pending){
      onPhase?.('submit')
      try {const existing=await request<T>(`/projects/${encodeURIComponent(pid)}/submissions/${encodeURIComponent(pending.key)}`);localStorage.removeItem(slot);return existing}
      catch(e){if(!(e instanceof ApiError) || e.status!==404)throw e}
      // 服务端明确未登记后才重试同一请求；不生成新键。
    } else {
      // 精细重建（editable）与单页重生成（regenerate）不弹确认框：
      // 费用/范围已在页面里说明，报价仍走服务端以保证幂等与可审计。
      const needsConfirm = operation !== 'editable' && operation !== 'regenerate'
      if(needsConfirm) onPhase?.('quote')
      const q=await request<OperationQuote>(`/projects/${encodeURIComponent(pid)}/quote`,jsonInit('POST',{...body,operation}))
      if(needsConfirm && !await confirmOperation(q))throw new SubmissionCancelled()
      onPhase?.('submit')
      pending={key:newSubmissionKey(),quote_id:q.quote_id,path,body}
      localStorage.setItem(slot,JSON.stringify(pending))
    }
    try {
      const controller=new AbortController()
      const timer=window.setTimeout(()=>controller.abort(),45000)
      let result:T
      try {result=await request<T>(pending.path,{...jsonInit('POST',{...pending.body,quote_id:pending.quote_id,idempotency_key:pending.key}),signal:controller.signal})}
      finally {window.clearTimeout(timer)}
      localStorage.removeItem(slot);return result
    } catch(e) {
      // 超时 / 丢响应：先查询已提交键；查询失败保留键，下一次点击仍先查询。
      try {const existing=await request<T>(`/projects/${encodeURIComponent(pid)}/submissions/${encodeURIComponent(pending.key)}`);localStorage.removeItem(slot);return existing}
      catch(queryError){
        if(queryError instanceof ApiError && queryError.status===404 && e instanceof ApiError && e.status>0){
          localStorage.removeItem(slot)
          if(e.status===409 && e.detail.includes('报价'))return await retryFreshQuote<T>(pid,path,operation,body,slot)
        }
        throw e
      }
    }
  } finally {operationBusy.delete(slot)}
}
async function retryFreshQuote<T>(pid:string,path:string,operation:string,body:Record<string,unknown>,slot:string):Promise<T>{
  operationBusy.delete(slot)
  return confirmedSubmission<T>(pid,path,operation,body)
}
export interface ProjectLedger {project_id:string;title:string;total_cny:number;note:string;items:Array<{id:string;job_id:string|null;page_no:number;action:string;cny:number;billing_status:string}>;tasks:Array<{job_id:string;operation:string;status:string;total_cny:number;pages:Array<{page_no:number;status:string;cny:number}>}>}
export const getProjectUsage=(pid:string)=>request<ProjectLedger>(`/projects/${encodeURIComponent(pid)}/usage`)

export const restoreSlideVersion=(pid:string,sid:string,vid:string)=>request<{ok:boolean}>(`/projects/${encodeURIComponent(pid)}/slides/${encodeURIComponent(sid)}/versions/${encodeURIComponent(vid)}/restore`,jsonInit('POST',{}))

export interface ExportPageSnapshot {slide_id:string;page_no:number;display_order:number;version_id:string;version_number:number;reason?:string;content_stale:boolean;config_stale:boolean}
export interface ExportPlan {project_id:string;kind:'image';page_nos:number[]|null;included:ExportPageSnapshot[];excluded:ExportPageSnapshot[];snapshot_token:string;note:string;capabilities:Array<{kind:string;label:string;available:boolean;reason:string}>}
export interface ExportRecord extends ExportResponse {id:string;project_id:string;snapshot:ExportPageSnapshot[]}
export const previewExport=(pid:string,kind:'image',page_nos?:number[])=>request<ExportPlan>(`/projects/${encodeURIComponent(pid)}/export-preview`,jsonInit('POST',{kind,page_nos}))
export const createExport=(pid:string,plan:ExportPlan)=>request<ExportRecord>(`/projects/${encodeURIComponent(pid)}/exports`,jsonInit('POST',{kind:plan.kind,page_nos:plan.page_nos,snapshot_token:plan.snapshot_token}))
export const listExports=(pid:string)=>request<{items:ExportRecord[]}>(`/projects/${encodeURIComponent(pid)}/exports`)
