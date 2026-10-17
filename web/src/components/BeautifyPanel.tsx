import { useEffect, useMemo, useRef, useState } from 'react'
import { beautifyOrigin, beautifyContinue, beautifyEditable, beautifyPreview, beautifyRegeneratePage, beautifyRestoreVersion, beautifyVersions, cancelEditable, createProject, editableEngines, getBeautify, getProject, getProjectJobs, uploadSource, prepareBeautifyContent, saveBeautifyContent, type ApiError } from '../api'
import { IconFolder } from './Icons'
import { Dropzone } from './Dropzone'
import { ActionBar, FlowSteps, OverviewGrid, PageLightbox, PageRail, PageSelectGrid, PagerArrow, withVersion, type FlowStep } from './FlowKit'
import { useToast } from './Toast'
import { useModalFocus } from '../hooks/useModalFocus'
import { useJobStream } from '../hooks/useJobStream'
import { MAX_UPLOAD_BYTES, UPLOAD_SIZE_HINT, bytes, cn, uploadTooLarge } from '../lib/format'
import type { BeautifyStatus, BeautifyVersionsResponse, BeautifyContentPlan, EditableEngine, StylePack } from '../types'
import { fmtSec } from './ProgressPanel'

/* ─────────────── ③ PPT美化：上传 / 预览 / 完成 ─────────────── */

const BEAUTIFY_STEP_LABELS = ['上传内容', '页面确认', '内容梳理', '选择风格', '生成结果', '转可编辑'] as const
const BEAUTIFY_STEPS: FlowStep[] = BEAUTIFY_STEP_LABELS.map((label, index) => ({ key: index + 1, label }))

const BEAUTIFY_STAGES: Record<string, string> = {
  render: '原稿转图', beauty: '逐页生图', editable: '精细重建', prepare: '准备任务', hints: '文字真源', page: '逐页重建', page_done: '逐页重建', finalize: '组装可编辑 deck', assemble: '组装导出',
}
const errorDetail = (e: unknown) => (e as ApiError)?.detail || (e instanceof Error ? e.message : String(e))
const STYLES_PER_PAGE = 6

function BeautifyStyleCover({ pack }: { pack: StylePack }) {
  const cover = pack.cover || pack.previews?.[0]
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [cover])
  return cover && !failed
    ? <img src={cover} alt={`${pack.name} 风格封面`} loading="eager" decoding="async" className="beautify-style-cover" onError={() => setFailed(true)} />
    : <span className="beautify-style-cover-missing text-caption text-ink-sub">暂无封面图</span>
}

/** 单页重生成确认（会真的调用生图模型，先说清楚影响面再提交） */
function OptimizeDialog({ pageNo, onClose, onConfirm }: { pageNo: number; onClose: () => void; onConfirm: (instruction: string) => void }) {
  const modalRef = useModalFocus(onClose)
  const [instruction, setInstruction] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`优化第 ${pageNo} 页`} onClick={onClose}>
      <div className="card flex w-full max-w-[28rem] flex-col gap-3" onClick={(event) => event.stopPropagation()}>
        <h3 className="m-0 text-h3">优化本页 <span className="num">P{pageNo}</span></h3>
        <label className="flex flex-col gap-1">
          <span className="metric-label">修改要求</span>
          <textarea className="input h-32! resize-y py-2!" autoFocus value={instruction} onChange={(e) => setInstruction(e.target.value)}
            placeholder="输入你想让 AI 修改的方向，请尽可能全面详细描述，例如：标题更突出，配色变成深蓝，图表区域放大 1.2 倍…" />
        </label>
        <p className="m-0 text-body-sm text-ink-sub">
          优化会再次调用已配置的生图模型，费用按设置与用量账本记录；<strong>其它页结果不受影响</strong>。
          生成前会先把本页当前结果归档为历史版本，可随时切回；留空则按原风格直接重生成。
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" onClick={() => onConfirm(instruction.trim())}>确认优化</button>
        </div>
      </div>
    </div>
  )
}

/** ③内容梳理的真实阶段：每一步都对应代码里实际做的事，不写做不到的耗时承诺 */
const CONTENT_STAGES = ['读取原稿', '提取文字', '校验结构', '标注来源'] as const

export function BeautifyPanel({ packs, loadingPacks, onStepChange, resumeProjectId, initialStylePackId }: { packs: StylePack[]; loadingPacks: boolean; onStepChange: (step: number) => void; resumeProjectId?: string; initialStylePackId?: string | null }) {
  const toast = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageMode = 'redesign' as const
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(resumeProjectId ? 2 : 1)
  const [file, setFile] = useState<File | null>(null)
  /** 原稿显示名：新上传取文件名；从项目恢复时取 source_path 的文件名（此时没有 File 对象） */
  const [sourceName, setSourceName] = useState('')
  const [origin, setOrigin] = useState<Awaited<ReturnType<typeof beautifyOrigin>> | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [keepMaterial, setKeepMaterial] = useState<number[]>([])
  const [content, setContent] = useState<BeautifyContentPlan | null>(null)
  /** ③的真实阶段进度：0=无，1..4 对应 CONTENT_STAGES 中正在做的那一步，完成后归 0 */
  const [contentStage, setContentStage] = useState(0)
  const [contentSaved, setContentSaved] = useState(false)
  /** 内容梳理：左侧页列表当前页下标（不是页号）+ 正在原地编辑的页号 */
  const [pageIndex, setPageIndex] = useState(0)
  const [editingPage, setEditingPage] = useState<number | null>(null)
  /** 是否并排显示原稿该页，便于人工核对（默认关，保持文字呈现直观） */
  const [showOrigin, setShowOrigin] = useState(false)
  /** 生成结果：当前查看的页下标 + 缩略总览开关 */
  const [resultIndex, setResultIndex] = useState(0)
  const [overview, setOverview] = useState(false)
  /** 放大看单页结果（灯箱） */
  const [lightbox, setLightbox] = useState(false)
  /** 单页重生成的确认框（待确认的页号） */
  const [regenTarget, setRegenTarget] = useState<number | null>(null)
  const [packId, setPackId] = useState(initialStylePackId || '')
  const [stylePage, setStylePage] = useState(1)
  const stylePageCount = Math.max(1, Math.ceil(packs.length / STYLES_PER_PAGE))
  const currentStylePage = Math.min(stylePage, stylePageCount)
  const visiblePacks = packs.slice((currentStylePage - 1) * STYLES_PER_PAGE, currentStylePage * STYLES_PER_PAGE)
  const [projectId, setProjectId] = useState<string | null>(resumeProjectId ?? null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BeautifyStatus | null>(null)
  /* ⑤ 结果页：本页历史版本（预览 + 恢复）与本次优化信息 */
  const [regenInfo, setRegenInfo] = useState<{ pageNo: number; instruction: string } | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versions, setVersions] = useState<BeautifyVersionsResponse | null>(null)
  const [versionsBusy, setVersionsBusy] = useState(false)
  const [versionPreview, setVersionPreview] = useState<string | null>(null)
  useEffect(() => {
    onStepChange(step)
    window.scrollTo({ top: 0 })
  }, [step, onStepChange])
  const stream = useJobStream(jobId, {
    onCancelled: () => { setBusy(false); setStep(5); void refresh(true) },
    onDone: () => { void refresh(true) },
    onError: (message) => { setError(message); setBusy(false); void refresh(true, message) },
  })
  /* ⑥ 转可编辑：独立步骤 + 单独 SSE；不随生成图片自动跑 */
  const [editableJobId, setEditableJobId] = useState<string | null>(null)
  const [editableBusy, setEditableBusy] = useState(false)
  const [editableIndex, setEditableIndex] = useState(0)
  const [editableEngine, setEditableEngine] = useState<EditableEngine | null>(null)
  const editableStream = useJobStream(editableJobId, {
    onDone: () => { setEditableBusy(false); toast.success('精细重建完成', '可在下方下载可编辑版 PPT'); void refresh(true) },
    onError: (message) => { setEditableBusy(false); setError(message); void refresh(true, message) },
    onCancelled: () => { setEditableBusy(false); void refresh(true) },
  })
  useEffect(() => {
    let active = true
    editableEngines()
      .then((res) => { if (active) setEditableEngine(res.engines.find((e) => e.id === 'editppt') ?? res.engines[0] ?? null) })
      .catch(() => { if (active) setEditableEngine(null) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (initialStylePackId) { setPackId(initialStylePackId); return }
    if (!packId && packs.length) setPackId(packs[0].id)
  }, [packs, packId, initialStylePackId])
  useEffect(() => { setStylePage(previous => Math.min(previous, stylePageCount)) }, [stylePageCount])

  /** 从「我的项目」进入：按后端记录的美化现场恢复到上一次执行到的步骤（不重跑生图、不新建项目） */
  useEffect(() => {
    if (!resumeProjectId) return
    let active = true
    setBusy(true); setError(null)
    ;(async () => {
      const [project, pages, status, jobs] = await Promise.all([
        getProject(resumeProjectId), beautifyOrigin(resumeProjectId),
        getBeautify(resumeProjectId), getProjectJobs(resumeProjectId),
      ])
      if (!active) return
      setProjectId(resumeProjectId)
      setSourceName(project.source_path ? (project.source_path.split('/').pop() || project.title) : project.title)
      setOrigin(pages)
      const pageNos = status.page_nos?.length ? status.page_nos : pages.pages.map(p => p.page_no)
      setSelected(pageNos)
      if (project.style_pack_id) setPackId(project.style_pack_id)
      setResult(status.phase ? status : null)
      try {
        const plan = await prepareBeautifyContent(resumeProjectId, { page_nos: pageNos, keep_material_page_nos: [] })
        if (!active) return
        setContent(plan)
        setContentSaved(Boolean(status.content_saved))
      } catch { /* 内容计划只服务第③步，取不到就停在页面确认，不编造内容 */ }
      const running = jobs.items.find(job => job.kind === 'beautify' && ['running', 'cancelling', 'queued'].includes(job.status))
      const editableRunning = jobs.items.find(job => job.kind === 'beautify_editable' && ['running', 'cancelling', 'queued'].includes(job.status))
      if (!active) return
      if (editableRunning) { setEditableJobId(editableRunning.id); setEditableBusy(true); setStep(6) }
      else if (running) { setJobId(running.id); setBusy(true); setStep(5) }
      else {
        setBusy(false)
        // 有已生成页 → 回到生成结果；跑过但没产出（取消/失败）→ 回到内容梳理；从未跑过 → 页面确认
        setStep((status.pages?.length ?? 0) > 0 ? 5 : status.phase ? 3 : 2)
      }
    })().catch(e => { if (active) { setError(errorDetail(e)); setBusy(false) } })
    return () => { active = false }
  }, [resumeProjectId])
  /* 运行期间每秒走一格，用于显示真实已用时（不再显示恒为 0 的假数据） */
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (stream.status !== 'running' && !editableBusy) return
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [stream.status, editableBusy])

  async function refresh(finished = false, jobError: string | null = null) {
    if (!projectId) return
    setError(jobError)
    try {
      const status = await getBeautify(projectId)
      setResult(status)
      if (finished || (stream.status !== 'running' && (status.phase === 'done' || status.phase === 'preview'))) setBusy(false)
    } catch (e) {
      setError([jobError, errorDetail(e)].filter(Boolean).join('；'))
      if (finished || stream.status !== 'running') setBusy(false)
    }
  }

  function chooseFile(next: File) {
    if (busy) return
    if (!/\.(pptx|pdf)$/i.test(next.name)) { setError('请上传 PPTX 或 PDF'); return }
    if (next.size > MAX_UPLOAD_BYTES) { setError(uploadTooLarge(next)); return }
    setFile(next); setSourceName(next.name); setError(null); setOrigin(null); setResult(null); setJobId(null); setProjectId(null); setSelected([]); setStep(1)
    setKeepMaterial([]); setContent(null); setContentSaved(false)
  }

  async function recognize() {
    if (!file || busy) return
    const next = file
    setBusy(true); setError(null); setOrigin(null); setResult(null); setJobId(null); setProjectId(null)
    setKeepMaterial([]); setContent(null); setContentSaved(false)
    try {
      const project = await createProject({ title: next.name.replace(/\.[^.]+$/, ''), source_type: next.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'pptx', intake_mode: 'doc' })
      await uploadSource(project.id, next)
      const pages = await beautifyOrigin(project.id)
      setProjectId(project.id); setOrigin(pages); setSelected(pages.pages.map(p => p.page_no)); setStep(2)
    } catch (e) { setError(errorDetail(e)) }
    finally { setBusy(false) }
  }

  async function startPreview() {
    if (!projectId || !selected.length || !packId || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    setJobId(null)
    try {
      const job = await beautifyPreview(projectId, { style_pack_id: packId, mode: imageMode, preview_pages: 3, page_nos: selected })
      if (!job.job_id) throw new Error('后端没有返回作业号')
      setJobId(job.job_id)
      setStep(5)
    } catch (e) { setError(errorDetail(e)); setBusy(false) }
  }

  async function organizeContent() {
    if (!projectId || !selected.length || busy) return
    setBusy(true); setError(null); setContent(null); setContentSaved(false)
    setPageIndex(0); setEditingPage(null); setStep(3)          // 先进第③步，处理态就位
    try {
      setContentStage(1)                                       // 真实：本次选页与原稿指纹的前置校验
      setContentStage(2)                                       // 真实：唯一耗时的一步——后端抽取原页文字
      const plan = await prepareBeautifyContent(projectId, { page_nos: selected, keep_material_page_nos: keepMaterial.filter(n => selected.includes(n)) })
      setContentStage(3)                                       // 真实：校验返回结构
      const expected = [...selected].sort((a, b) => a - b)
      if (plan.pages.length !== expected.length || plan.pages.some((page, index) => page.page_no !== expected[index])) {
        throw new Error('后端返回的页序与本次选页不一致，已中止')
      }
      if (plan.pages.some(page => !Array.isArray(page.texts) || !Array.isArray(page.points))) {
        throw new Error('后端返回的文字结构不完整，已中止')
      }
      setContentStage(4)                                       // 真实：合并已保存草稿与「保留原图」标记
      setContent(previous => ({ ...plan, pages: plan.pages.map(page => {
        const draft = previous?.source_revision === plan.source_revision ? previous.pages.find(item => item.page_no === page.page_no) : null
        return draft ? { ...draft, keep_material: page.keep_material } : page
      }) }))
      setContentSaved(false)
      setPageIndex(0); setEditingPage(null)
    } catch (e) { setError(errorDetail(e)) }
    finally { setContentStage(0); setBusy(false) }
  }

  /** 按需重建原生可编辑版：生成图片时不自动执行，由用户点「转文字可编辑版」触发 */
  async function convertEditable() {
    if (!projectId || editableBusy) return
    setEditableBusy(true); setError(null)
    try {
      const job = await beautifyEditable(projectId, { style_pack_id: packId })
      if (!job.job_id) throw new Error('后端没有返回作业号')
      setEditableJobId(job.job_id)
      toast.info('已开始精细重建可编辑版', '文字/图片/图形/背景分别拆分；完成后可下载可编辑版 PPT')
    } catch (e) { setEditableBusy(false); setError(errorDetail(e)) }
  }

  /** 停止正在跑的精细重建（保留已完成页与现场，可继续） */
  async function cancelEditableConversion() {
    if (!projectId) return
    try {
      await cancelEditable(projectId)
      toast.info('已请求停止', '当前页会被终止，已完成页与现场保留，可稍后继续')
    } catch (e) { setError(errorDetail(e)) }
  }

  /** 打开/关闭本页历史版本列表（每次打开都重新拉，避免看到旧数据） */
  async function toggleVersions() {
    if (!projectId || !resultCurrent) return
    if (versionsOpen) { setVersionsOpen(false); setVersionPreview(null); return }
    setVersionsOpen(true); setVersionsBusy(true); setError(null)
    try {
      setVersions(await beautifyVersions(projectId, resultCurrent.page_no))
    } catch (e) { setError(errorDetail(e)) }
    finally { setVersionsBusy(false) }
  }

  /** 恢复某个历史版本（恢复前后端会先归档当前图，可再切回） */
  async function restoreVersion(versionId: string) {
    if (!projectId || !resultCurrent || busy) return
    setBusy(true); setError(null)
    try {
      const job = await beautifyRestoreVersion(projectId, resultCurrent.page_no, versionId)
      if (!job.job_id) throw new Error('后端没有返回作业号')
      setJobId(job.job_id)
      setVersionsOpen(false); setVersionPreview(null)
      toast.info('已开始恢复历史版本', '恢复前会先归档当前结果，可再切回')
    } catch (e) { setError(errorDetail(e)); setBusy(false) }
  }

  async function confirmContent() {
    if (!projectId || !content || busy) return
    setBusy(true); setError(null)
    try {
      const saved = await saveBeautifyContent(projectId, content)
      setContent(saved); setContentSaved(true); setStep(4)
    } catch (e) { setError(errorDetail(e)) }
    finally { setBusy(false) }
  }

  function updateContent(pageNo: number, field: 'title' | 'points', value: string) {
    setContent(previous => previous ? { ...previous, pages: previous.pages.map(page => page.page_no === pageNo ? { ...page, [field]: field === 'points' ? value.split('\n') : value } : page) } : previous)
    setContentSaved(false)
  }

  /** 重新提取当前页原文（后端按原稿重读，不调用模型、不补写）；其余页保持不变 */
  async function reextractPage(pageNo: number) {
    if (!projectId || !content || busy) return
    setBusy(true); setError(null)
    try {
      const plan = await prepareBeautifyContent(projectId, { page_nos: [pageNo], keep_material_page_nos: keepMaterial.filter(n => n === pageNo) })
      const fresh = plan.pages.find(page => page.page_no === pageNo)
      if (!fresh) throw new Error(`后端未返回第 ${pageNo} 页内容`)
      setContent(previous => previous ? { ...previous, pages: previous.pages.map(page => page.page_no === pageNo ? fresh : page) } : previous)
      setContentSaved(false); setEditingPage(null)
    } catch (e) { setError(errorDetail(e)) }
    finally { setBusy(false) }
  }

  async function continueAll() {
    if (!projectId || busy || result?.phase !== 'preview') return
    setBusy(true)
    setError(null)
    try {
      const firstPending = resultPages.findIndex(page => !page.beauty_url)
      const job = await beautifyContinue(projectId, { style_pack_id: packId, mode: imageMode, page_nos: selected })
      if (firstPending >= 0) setResultIndex(firstPending)
      if (!job.job_id) throw new Error('后端没有返回作业号')
      setResult(null)
      setJobId(job.job_id)
      setStep(5)
    } catch (e) { setError(errorDetail(e)); setBusy(false) }
  }

  /* 逐页状态来源：左栏「生成中」与结果卡片都读它（原先还给「美化生成进度」面板用，该面板已按批注移除） */
  const progress = {
    ...stream,
    message: stream.status === 'done' ? '作业已结束，请核对导出结果与警告' : stream.message,
    byPage: Object.fromEntries(Object.entries(stream.byPage).map(([key, event]) => [key, { ...event, stage: BEAUTIFY_STAGES[event.stage] || event.stage }])),
  }
  /* ── ③ 内容梳理：一次只展示一页，提炼出的文字按最终页面样式呈现 ── */
  const contentPages = content?.pages ?? []
  const currentIndex = Math.min(pageIndex, Math.max(0, contentPages.length - 1))
  const currentPage = contentPages[currentIndex]
  const pageHasText = (page: BeautifyContentPlan['pages'][number]) => Boolean(page.title.trim() || page.points.join('').trim())
  const filledCount = contentPages.filter(pageHasText).length
  const currentOriginUrl = currentPage ? origin?.pages.find(item => item.page_no === currentPage.page_no)?.image_url : undefined
  /* ── ⑤ 生成结果：逐页查看美化结果（页状态一律按后端真实字段判断，不编造） ── */
  /** 结果页列表 = 本次所选的全部页（没轮到的用原稿缩略图占位）——
   *  批量生成时左栏才能像参考图那样逐页显示「生成中 / 排队中 / 已完成」。 */
  const resultPages = useMemo<BeautifyStatus['pages']>(() => {
    if (!result) return []
    const withResult = result.pages ?? []
    const nos = result.page_nos?.length ? result.page_nos : withResult.map(page => page.page_no)
    return nos.map(no => withResult.find(page => page.page_no === no) ?? {
      page_no: no,
      origin_url: origin?.pages.find(item => item.page_no === no)?.image_url ?? '',
      beauty_url: '', beauty_ok: false, text_source: 'none',
    })
  }, [result, origin])
  const resultCurrentIndex = Math.min(resultIndex, Math.max(0, resultPages.length - 1))
  const resultCurrent = resultPages[resultCurrentIndex]
  const resultDoneCount = resultPages.filter(page => Boolean(page.beauty_url)).length
  const generatingCurrent = Boolean(resultCurrent) && (
    progress.byPage[resultCurrent.page_no]?.status === 'running'          // 该页正在生成/重生成（参考图口径）
    || (!resultCurrent.beauty_url && stream.status === 'running')         // 整批跑着、这页还没有结果
  )
  const resultPercent = resultPages.length ? Math.round((100 * resultDoneCount) / resultPages.length) : 0
  /** 正在生成的页（后端 Semaphore(3) 并发，逐页 SSE 事件是真实状态） */
  const runningPages = Object.values(stream.byPage).filter(event => event.status === 'running')
  const jobActive = stream.status === 'running' || runningPages.length > 0
  const runningSeconds = stream.startedAt ? Math.max(0, Math.round(((stream.finishedAt ?? nowTick) - stream.startedAt) / 1000)) : null
  /** 剩余时间估算：只用本次任务里已完成页的**实测**均耗时，并按当前并发折算（估不出来就不显示，不编） */
  const finishedPageEvents = Object.values(stream.byPage).filter(event => event.status === 'done' || event.status === 'failed')
  const measuredPageMs = finishedPageEvents.length
    ? finishedPageEvents.reduce((sum, event) => sum + (event.elapsed_ms ?? 0), 0) / finishedPageEvents.length
    : 0
  const remainingPages = Math.max(0, resultPages.length - resultDoneCount)
  const etaSeconds = measuredPageMs > 0 && remainingPages > 0 && runningPages.length > 0
    ? Math.max(1, Math.round((measuredPageMs * Math.ceil(remainingPages / Math.max(1, runningPages.length))) / 1000))
    : null
  const resultPageState = (page: BeautifyStatus['pages'][number]) => {
    if (progress.byPage[page.page_no]?.status === 'running') return { label: '生成中', cls: 'status-info' }
    if (page.beauty_url && page.beauty_ok) return { label: '已完成', cls: 'status-success' }
    if (page.beauty_url) return { label: '已用原图', cls: 'status-warn' }
    // 整批正在跑、该页还没轮到（页数多于并发上限）时如实显示排队，不假装在生成
    if (stream.status === 'running') return { label: '排队中', cls: 'status-info' }
    return { label: '未生成', cls: 'status-info' }
  }
  /* ⑥ 转可编辑：进度、逐页状态与耗时估算（全部来自 SSE / 后端现场，不编造） */
  const editableTotal = resultPages.length
  const editableRunning = editableBusy || editableStream.status === 'running'
  const editableSettledDone = Object.values(editableStream.settled).filter(status => status === 'done').length
  const editableSettledFailed = Object.values(editableStream.settled).filter(status => status === 'failed').length
  const editableDone = Math.max(editableSettledDone, editableStream.progressDone, result?.exports?.editable && !editableRunning ? editableTotal : 0)
  const editablePercent = editableTotal ? Math.min(100, Math.round((100 * editableDone) / editableTotal)) : 0
  const editableCurrentIndex = Math.min(editableIndex, Math.max(0, editableTotal - 1))
  const editableCurrent = editableTotal ? resultPages[editableCurrentIndex] : undefined
  const editableLastStage = editableStream.events[editableStream.events.length - 1]?.stage
  const editableStageKey = editableLastStage === 'finalize' ? 'finalize'
    : editableStream.events.some(event => event.stage === 'page' || event.stage === 'page_done') ? 'page'
    : editableLastStage === 'hints' ? 'hints' : 'prepare'
  const editableStageText = editableRunning
    ? (BEAUTIFY_STAGES[editableStageKey] ?? '逐页重建')
    : result?.exports?.editable ? '已完成' : editableStream.status === 'error' ? '失败' : editableStream.status === 'cancelled' ? '已停止' : '待开始'
  const editableElapsedMs = editableStream.startedAt ? Math.max(0, (editableStream.finishedAt ?? nowTick) - editableStream.startedAt) : 0
  const editablePerPageMs = editableDone > 0 ? editableElapsedMs / editableDone : (editableEngine?.seconds_per_page ? editableEngine.seconds_per_page * 1000 : 780000)
  const editableEtaMs = editableTotal > editableDone ? editablePerPageMs * (editableTotal - editableDone) : 0
  const editablePageState = (pageNo: number) => {
    const event = editableStream.byPage[pageNo]
    if (editableStream.settled[pageNo] === 'done' || event?.stage === 'page_done') return { label: '已完成', cls: 'status-success' }
    if (editableStream.settled[pageNo] === 'failed' || event?.stage === 'page_failed') return { label: '失败', cls: 'status-danger' }
    if (event?.stage === 'page') return { label: '重建中', cls: 'status-info' }
    if (editableRunning) return { label: '排队中', cls: 'status-info' }
    if (result?.exports?.editable) return { label: '已完成', cls: 'status-success' }
    return { label: '待重建', cls: 'status-info' }
  }

  /** 步骤可达性：只按真实数据放行（前进/后退都行）；不可达时给出中文原因，点击如实提示而不是静默点不动 */
  const stepLocks: Record<number, string | undefined> = {
    1: undefined,
    2: projectId ? undefined : '还没有原稿：先在第①步上传 PPTX / PDF',
    3: content ? undefined : '先在第②步点「开始梳理内容」',
    4: contentSaved ? undefined : '先在第③步点「确认内容，选择风格」',
    5: (result?.pages?.length ?? 0) > 0 ? undefined : '先在第④步生成前 3 页预览',
    6: result?.phase === 'done' ? undefined : '先生成全部页面的美化图（第⑤步完成）',
  }
  function goStep(target: number) {
    if (busy || target === step) return
    const lock = stepLocks[target]
    if (lock) { toast.info(`「${BEAUTIFY_STEP_LABELS[target - 1]}」暂时不能进入：${lock}`); return }
    if (target === 6) setError(null)
    setStep(target as 1 | 2 | 3 | 4 | 5 | 6)
  }
  /** 重新生成当前这一页：后端只动这一页，其它页与导出不变，最后重装配图片版 */
  async function regenerateCurrentPage(instruction = '') {
    if (!projectId || !resultCurrent || busy) return
    const pageNo = resultCurrent.page_no
    setRegenTarget(null)
    setBusy(true); setError(null)
    try {
      const job = await beautifyRegeneratePage(projectId, pageNo, { style_pack_id: packId || undefined, mode: imageMode, instruction })
      if (!job.job_id) throw new Error('后端没有返回作业号')
      setJobId(job.job_id)
      setRegenInfo({ pageNo, instruction })
      toast.info(instruction ? `已开始按修改要求优化第 ${pageNo} 页` : `已开始重新生成第 ${pageNo} 页`,
                 '其它页结果不会改动；本页旧结果已归档为历史版本')
    } catch (e) { setError(errorDetail(e)); setBusy(false) }
  }

  return (
    <div className={cn('beautify-flow flex flex-col gap-5', step > 1 && 'beautify-workbench')}>
      <header className="beautify-flow-header">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h2 className="m-0 min-w-0 flex-1 truncate text-2xl font-semibold" title={sourceName}>{sourceName.replace(/\.[^.]+$/, '') || 'PPT美化'}</h2>
          {projectId && <span className="status status-success">{contentSaved ? '内容已保存' : step === 3 ? '内容待确认' : '文件已上传'}</span>}
        </div>
        <FlowSteps steps={BEAUTIFY_STEPS} current={step} locks={stepLocks} busy={busy} onJump={goStep}
          onLocked={(target, reason) => toast.info(`「${BEAUTIFY_STEP_LABELS[target - 1]}」暂时不能进入：${reason}`)} label="PPT美化步骤" />
      </header>
      {step === 1 && <>
        <div className="gen-panel-drop">
        {!file ? <Dropzone head="拖入要美化的 PPTX / PDF" hint="选择文件后，点击「开始 PPT 美化」分析页面" formats={`PPTX · PDF · ${UPLOAD_SIZE_HINT}`} accept=".pptx,.pdf" onPick={(picked) => { if (picked[0]) chooseFile(picked[0]) }} /> : <div className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-2xl border border-border bg-surface-band px-6 py-8 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface text-primary"><IconFolder className="h-7 w-7" /></span>
          <h3 className="m-0 max-w-full break-words text-h3">{file.name}</h3>
          <p className="m-0 text-ink-sub">{file.name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'PPTX'} · <span className="num">{bytes(file.size)}</span> · {busy ? '正在分析页面…' : '已就绪'}</p>
          <div className="flex gap-4">
            <button type="button" className="link" disabled={busy} onClick={() => fileInputRef.current?.click()}>重新选择</button>
            <button type="button" className="link" disabled={busy} onClick={() => { setFile(null); setError(null) }}>删除</button>
          </div>
          <input ref={fileInputRef} type="file" accept=".pptx,.pdf" className="hidden" disabled={busy} onChange={(event) => { const next = event.target.files?.[0]; if (next) chooseFile(next); event.target.value = '' }} />
        </div>}
        </div>
        <div className="gen-panel-foot">
          <span className="text-body-sm text-ink-sub">{file ? '已选择文件，点右侧开始分析页面' : `支持 PPTX · PDF，${UPLOAD_SIZE_HINT}`}</span>
          <button type="button" className="btn btn-primary rounded-full px-6" disabled={!file || busy} onClick={() => void recognize()}>{busy ? '正在分析页面…' : '开始 PPT 美化'}</button>
        </div>
        {busy && <p role="status" className="m-0 text-body-sm text-ink-sub">正在上传文件并分析页面，请稍候…</p>}
      </>}
      {step === 2 && origin && <>
        <div className="flex flex-wrap items-center gap-3"><h3 className="m-0 text-h2 font-semibold">识别页面</h3><span className="text-ink-sub">共 <span className="num">{origin.page_count}</span> 页 · 默认全选并保持原顺序</span></div>
        <p className="m-0 text-body-md text-primary">开启「保留原图」后，以原页画面为参考保留图片与版式；关闭后按确认文字重新设计。无可用文字时会保留原图。</p>
        <PageSelectGrid
          pages={origin.pages.map(page => ({ pageNo: page.page_no, image: page.image_url, alt: `原稿第 ${page.page_no} 页` }))}
          selected={selected}
          disabled={busy}
          onToggle={pageNo => {
            const checked = selected.includes(pageNo)
            setSelected(previous => checked ? previous.filter(n => n !== pageNo) : [...previous, pageNo].sort((a, b) => a - b))
            setContentSaved(false)
          }}
          renderRow={(pageNo, checked) => {
            const kept = keepMaterial.includes(pageNo)
            return <div className="deck-option-row">
              <span className="text-caption text-ink-sub" title="保留整页画面作为视觉参考，包含原页图片和版式">保留原页图片素材</span>
              <button type="button" role="switch" aria-checked={kept} aria-label={`第 ${pageNo} 页保留原图`} disabled={busy || !checked} className="deck-switch" onClick={() => { setKeepMaterial(previous => kept ? previous.filter(n => n !== pageNo) : [...previous, pageNo]); setContentSaved(false) }}><span /></button>
            </div>
          }}
        />
      </>}
      {step === 3 && !content && <>
        <div className="deck-split beautify-content-workspace">
          <aside className="beautify-content-sidebar">
            <h3 className="m-0 mb-4 text-h3 font-semibold text-ink-sub">页面内容</h3>
            <PageRail label="页面内容列表" current={0} onSelect={() => undefined}
              items={[...selected].map(pageNo => ({
                key: pageNo, index: `P${pageNo}`, label: `第 ${pageNo} 页`, dot: 'idle' as const,
              }))} />
          </aside>
          <section className="deck-slide-shell beautify-content-paper" role="status" aria-busy="true" aria-label="内容梳理进度">
            <div className="deck-slide-head beautify-content-toolbar">
              <span className="num font-semibold text-primary">P{selected[0]}</span>
              <span className="text-body-sm text-ink-sub">内容页</span>
              <span className="status status-info">{CONTENT_STAGES[Math.max(0, contentStage - 1)]}…</span>
              <span className="flex-1" />
            </div>
            <div className="deck-slide beautify-content-slide beautify-organize">
              <span className="deck-spinner" aria-hidden="true" />
              <p className="beautify-organize-title">正在读取原页并提取文字…</p>
              <p className="beautify-organize-sub">只取原页已有的文字：PPTX 文本框与表格、PDF 文字层；不改写、不翻译、不精简</p>
              <ol className="beautify-organize-stages">
                {CONTENT_STAGES.map((name, index) => {
                  const no = index + 1
                  return <li key={name} className={cn('beautify-organize-stage', contentStage > no && 'is-done', contentStage === no && 'is-current')}>
                    <span className="beautify-organize-stage-dot" aria-hidden="true">{contentStage > no ? '✓' : no}</span>
                    <span>{name}</span>
                  </li>
                })}
              </ol>
              <p className="beautify-organize-note">本地完成，不调用模型，也不产生费用</p>
              <div className="beautify-organize-guide">
                <div><b>只取已有文字</b><span>文本框、表格、PDF 文字层；不改写、不翻译、不精简</span></div>
                <div><b>取不到就不编</b><span>本页没有可用文字时标为「未提取到」，留空不补写内容</span></div>
                <div><b>数字保持原样</b><span>单位、百分号、空值照原样保留，不推断成 0</span></div>
              </div>
            </div>
          </section>
        </div>
      </>}
      {step === 3 && content && currentPage && <>
        <div className="deck-split beautify-content-workspace">
          <aside className="beautify-content-sidebar">
          <h3 className="m-0 mb-4 text-h3 font-semibold text-ink-sub">页面内容</h3>
          <PageRail label="页面内容列表" current={currentIndex} onSelect={(index) => { setPageIndex(index); setEditingPage(null) }}
            items={contentPages.map(page => ({
              key: page.page_no, index: `P${page.page_no}`,
              label: `第 ${page.page_no} 页`,
              title: page.title.trim() || page.points.find(point => point.trim()) || '未提取到文字',
              dot: pageHasText(page) ? 'done' as const : 'idle' as const,
            }))} />
          </aside>
          <section className="deck-slide-shell beautify-content-paper" aria-label={`第 ${currentPage.page_no} 页内容`}>
            <div className="deck-slide-head beautify-content-toolbar">
              <span className="num font-semibold text-primary">P{currentPage.page_no}</span>
              <span className="text-body-sm text-ink-sub">内容页</span>
              <span className={cn('status', pageHasText(currentPage) ? 'status-success' : 'status-warn')}>{pageHasText(currentPage) ? currentPage.source === 'user' ? '已编辑内容' : '已提取原文' : '未提取到文字'}</span>
              <span className="tag">{currentPage.keep_material ? '保留原页画面' : '按文字重新设计'}</span>
              <span className="flex-1" />
              <button type="button" className="btn btn-secondary rounded-full" disabled={busy} onClick={() => setEditingPage(editingPage === currentPage.page_no ? null : currentPage.page_no)}>{editingPage === currentPage.page_no ? '完成编辑' : '编辑内容'}</button>
              <button type="button" className="btn btn-secondary rounded-full" disabled={busy} title="重新读取该页已保存的文字；尚未保存时读取原稿，不调用模型" onClick={() => void reextractPage(currentPage.page_no)}>{busy ? '读取中…' : '重新读取本页'}</button>
            </div>
            <div className="deck-slide beautify-content-slide">
              {editingPage === currentPage.page_no
                ? <>
                  <input className="deck-slide-title-input" value={currentPage.title} placeholder="页面标题（可留空）" aria-label={`第 ${currentPage.page_no} 页标题`} onChange={event => updateContent(currentPage.page_no, 'title', event.target.value)} />
                  <textarea className="deck-slide-body-input" value={currentPage.points.join('\n')} placeholder="页面正文，每行一条要点" aria-label={`第 ${currentPage.page_no} 页正文`} onChange={event => updateContent(currentPage.page_no, 'points', event.target.value)} />
                </>
                : <>
                  {currentPage.title.trim() && <h4 className="deck-slide-title">{currentPage.title}</h4>}
                  {currentPage.title.trim() && <span className="deck-slide-rule" aria-hidden="true" />}
                  <div className="beautify-content-text">
                  {currentPage.points.some(point => point.trim())
                    ? <ul className="deck-slide-points">{currentPage.points.filter(point => point.trim()).map((point, index) => <li key={index}>{point}</li>)}</ul>
                    : !currentPage.title.trim() && <p className="deck-slide-empty">这一页没有提取到文字。可点「编辑内容」手工补写；留空时后端会用原页画面，不编造文字。</p>}
                  </div>
                </>}
            </div>
            <div className="deck-slide-meta beautify-content-meta">
              <span>文字来源：{currentPage.source === 'none' ? '未提取到' : currentPage.source === 'user' ? '人工修改' : currentPage.source.toUpperCase()}</span>
              <span>原文段落：<span className="num">{currentPage.texts.length}</span> 条</span>
              <span>页内文字：<span className="num">{(currentPage.title + currentPage.points.join('')).length}</span> 字</span>
              <button type="button" className="link" onClick={() => setShowOrigin(value => !value)}>{showOrigin ? '隐藏原稿' : '对照原稿'}</button>
            </div>
            {showOrigin && (currentOriginUrl
              ? <img src={currentOriginUrl} alt={`原稿第 ${currentPage.page_no} 页`} className="deck-slide-origin" loading="lazy" />
              : <p className="m-0 text-caption text-ink-muted">后端未提供该页原稿图。</p>)}
          </section>
        </div>
      </>}
      {step === 4 && <>
        <div><h3 className="m-0 text-h2 font-semibold">选择目标风格</h3><p className="mb-0 mt-2 text-ink-sub">先生成所选页面中的前 <span className="num">{Math.min(3, selected.length)}</span> 页预览，核对后再继续生成全部所选页面和可编辑版。</p></div>
        <div className="beautify-style-grid" role="group" aria-label="目标风格">
          {loadingPacks && <p>加载风格包…</p>}
          {!loadingPacks && !packs.length && <p>没有可用风格包</p>}
          {visiblePacks.map(pack => <button type="button" key={pack.id} className={cn('beautify-style-option', packId === pack.id && 'is-selected')} aria-pressed={packId === pack.id} disabled={busy} onClick={() => setPackId(pack.id)}><BeautifyStyleCover pack={pack} /><span className="beautify-style-caption"><span className="font-semibold">{pack.name}</span><span className="text-caption text-ink-sub">{packId === pack.id ? '已选择' : '选择此风格'}</span></span></button>)}
        </div>
        {!loadingPacks && packs.length > 0 && <nav className="beautify-style-pagination" aria-label="风格分页">
          <span className="text-caption text-ink-sub">共 <span className="num">{packs.length}</span> 套风格 · 第 <span className="num">{currentStylePage}</span> / <span className="num">{stylePageCount}</span> 页</span>
          <button type="button" className="btn btn-secondary" disabled={busy || currentStylePage === 1} onClick={() => setStylePage(currentStylePage - 1)}>上一页</button>
          {Array.from({ length: stylePageCount }, (_, index) => index + 1).map(page => <button type="button" key={page} className={cn('beautify-pagination-number num', currentStylePage === page && 'is-current')} aria-label={`第 ${page} 页风格`} aria-current={currentStylePage === page ? 'page' : undefined} disabled={busy} onClick={() => setStylePage(page)}>{page}</button>)}
          <button type="button" className="btn btn-secondary" disabled={busy || currentStylePage === stylePageCount} onClick={() => setStylePage(currentStylePage + 1)}>下一页</button>
        </nav>}
        {packId && <p className="m-0 text-body-sm text-ink-sub">当前风格：<span className="font-semibold text-primary">{packs.find(pack => pack.id === packId)?.name || packId}</span></p>}
      </>}
      {error && <div className="error-box text-body-sm" role="alert">{error}</div>}
      {step === 5 && stream.status === 'cancelled' && <p role="status" className="text-body-sm">已取消，已完成的部分已保留</p>}
      {step === 5 && result && resultPages.length > 0 && <div className="deck-split">
        <PageRail label="结果页面列表" current={resultCurrentIndex} onSelect={(index) => { setResultIndex(index); setOverview(false) }}
          items={resultPages.map(page => {
            const pageState = resultPageState(page)
            return {
              key: page.page_no, label: `第 ${page.page_no} 页`,
              thumb: withVersion(page.beauty_url || page.origin_url, result.updated_at),
              status: { text: pageState.label, cls: pageState.cls },
            }
          })} />
        <section className="deck-slide-shell" aria-label={`第 ${resultCurrent.page_no} 页生成结果`}>
          <div className="deck-slide-head">
            <span className="num font-semibold text-primary">P{resultCurrent.page_no}</span>
            <span className="font-semibold">第 <span className="num">{resultCurrent.page_no}</span> 页</span>
            <span className={cn('status', resultPageState(resultCurrent).cls)}>{resultPageState(resultCurrent).label}</span>
            <span className="flex-1" />
            <button type="button" className="btn btn-primary rounded-full" disabled={busy || !resultCurrent.beauty_url}
                    title={resultCurrent.beauty_url ? '填写修改要求，让 AI 只重做这一页（其它页结果不变）' : '该页还没有结果，先生成预览'}
                    onClick={() => setRegenTarget(resultCurrent.page_no)}>{busy ? '生成中…' : '✦ 优化本页'}</button>
            <button type="button" className="btn btn-secondary rounded-full" aria-pressed={showOrigin} disabled={busy} onClick={() => setShowOrigin(value => !value)}>{showOrigin ? '隐藏原稿' : '对比原稿'}</button>
            <button type="button" className="btn btn-secondary rounded-full" disabled={busy || !resultCurrent.beauty_url}
                    aria-expanded={versionsOpen} title="查看本页历史版本，可预览后恢复"
                    onClick={() => void toggleVersions()}>查看历史版本 ▾</button>
            <button type="button" className="btn btn-secondary rounded-full" aria-pressed={overview} disabled={busy} onClick={() => setOverview(value => !value)}>{overview ? '返回单页' : '缩略总览'}</button>
          </div>
          {versionsOpen && (
            <div className="beautify-versions" role="dialog" aria-label="本页历史版本">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body-sm font-semibold">本页历史版本</span>
                <span className="text-caption text-ink-sub">可先预览，再决定是否恢复</span>
                <span className="flex-1" />
                <button type="button" className="btn btn-secondary h-8! text-body-sm" onClick={() => { setVersionsOpen(false); setVersionPreview(null) }}>关闭</button>
              </div>
              {versionsBusy && <p className="m-0 text-body-sm text-ink-sub">正在读取…</p>}
              {!versionsBusy && versions && (
                <ul className="beautify-version-list">
                  <li className="is-current">
                    <span className="font-semibold">当前使用</span>
                    <span className="text-caption text-ink-sub">正在展示的结果（每次优化前会自动归档）</span>
                  </li>
                  {versions.versions.map((version, index) => (
                    <li key={version.id}>
                      <span className="font-semibold">版本 <span className="num">{versions.versions.length - index}</span></span>
                      <span className="text-caption text-ink-sub">{version.created_at.replace('T', ' ').slice(0, 16)}</span>
                      {version.instruction && <span className="text-caption text-ink-sub">修改要求：{version.instruction}</span>}
                      <span className="flex-1" />
                      <button type="button" className="link" onClick={() => setVersionPreview(version.url)}>预览</button>
                      <button type="button" className="link" disabled={busy} onClick={() => void restoreVersion(version.id)}>恢复此版本</button>
                    </li>
                  ))}
                  {!versions.versions.length && <li className="text-caption text-ink-muted">还没有历史版本；每次优化或重生成都会先把旧结果归档</li>}
                </ul>
              )}
            </div>
          )}
          {overview ? <OverviewGrid current={resultCurrentIndex} onSelect={(index) => { setResultIndex(index); setOverview(false) }} emptyText="未生成"
            items={resultPages.map(page => ({ key: page.page_no, label: `查看第 ${page.page_no} 页结果`, image: withVersion(page.beauty_url, result.updated_at) }))} /> : <>
            <div className="deck-media-frame">
              {generatingCurrent
                ? <div className="beautify-generating" role="status" aria-busy="true">
                      <span className="deck-spinner" aria-hidden="true" />
                      <p className="beautify-organize-title">{regenInfo && regenInfo.pageNo === resultCurrent.page_no ? '正在重新设计本页…' : '正在生成美化结果…'}</p>
                      <p className="beautify-organize-sub">
                        {regenInfo && regenInfo.pageNo === resultCurrent.page_no
                          ? (regenInfo.instruction ? `根据你的修改要求重新调用 AI 模型设计：${regenInfo.instruction}` : '根据你的操作重新调用 AI 模型设计本页')
                          : `正在按所选风格${resultCurrent.keep_material ? '保留原页图片与版式、只替换配色与质感' : '重新设计本页'}`}
                      </p>
                      <div className="beautify-generating-bar" role="progressbar" aria-valuemin={0} aria-valuemax={resultPages.length}
                           aria-valuenow={resultDoneCount} aria-valuetext={`已完成 ${resultDoneCount} / ${resultPages.length} 页`}>
                        <i style={{ width: `${resultPercent}%` }} />
                      </div>
                      <p className="beautify-organize-note">
                        已完成 <span className="num">{resultDoneCount}</span> / <span className="num">{resultPages.length}</span> 页
                        {runningPages.length > 1 && <> · <span className="num">{runningPages.length}</span> 页并发中</>}
                        {runningSeconds !== null && <> · 已用时 <span className="num">{runningSeconds}</span> 秒</>}
                        {etaSeconds !== null && <> · 按已完成页实测均耗时估算，约还需 <span className="num">{etaSeconds}</span> 秒</>}
                      </p>
                    </div>
                : resultCurrent.beauty_url
                  ? <button type="button" className="deck-media-open" title="点击放大查看" onClick={() => setLightbox(true)}><img src={withVersion(resultCurrent.beauty_url, result.updated_at)} alt={`第 ${resultCurrent.page_no} 页生成结果`} /></button>
                  : <p className="deck-slide-empty">这一页还没有生成结果{result.phase === 'preview' ? '：预览阶段只生成所选页中的前 3 页' : ''}。</p>}
            </div>
            {resultCurrent.beauty_ok === false && resultCurrent.beauty_url && <p className="m-0 text-body-sm text-ink-sub" role="alert">该页生图失败，当前显示的是原图副本；可点上方「✦ 优化本页」再试，成本会计入账本。</p>}
            {showOrigin && (resultCurrent.origin_url
              ? <img src={resultCurrent.origin_url} alt={`原稿第 ${resultCurrent.page_no} 页`} className="deck-slide-origin" loading="lazy" />
              : <p className="m-0 text-caption text-ink-muted">后端未提供该页原稿图。</p>)}
          </>}
        </section>
      </div>}
      {step === 2 && origin && <ActionBar>
        <span className="font-semibold">已选 <span className="num text-primary">{selected.length}</span> / <span className="num">{origin.page_count}</span> 页</span>
        <button type="button" className="btn btn-secondary rounded-full" disabled={busy} onClick={() => { setSelected(selected.length === origin.page_count ? [] : origin.pages.map(page => page.page_no)); setContentSaved(false) }}>{selected.length === origin.page_count ? '取消全选' : '全选'}</button>
        <button type="button" className="btn btn-secondary rounded-full" disabled={busy || !selected.length} onClick={() => { const allKept = selected.every(n => keepMaterial.includes(n)); setKeepMaterial(allKept ? keepMaterial.filter(n => !selected.includes(n)) : [...new Set([...keepMaterial, ...selected])]); setContentSaved(false) }}>{selected.length > 0 && selected.every(n => keepMaterial.includes(n)) ? '取消保留原图' : '全部保留原图'}</button>
        <button type="button" className="btn btn-primary rounded-full px-6" disabled={busy || !selected.length} onClick={() => void organizeContent()}>{busy ? '正在梳理内容…' : '开始梳理内容'}</button>
      </ActionBar>}
      {step === 3 && !content && <ActionBar>
        <span>第 <span className="num">1</span> / <span className="num">{selected.length}</span> 页</span>
        <span className="text-ink-sub">完成 <span className="num">0</span> / <span className="num">{selected.length}</span> 页</span>
        <span className="text-ink-sub">处理中 <span className="num">{selected.length}</span></span>
        <button type="button" className="btn btn-secondary rounded-full" disabled title="梳理进行中，请稍候">返回页面确认</button>
        <button type="button" className="btn btn-primary rounded-full" disabled title="梳理完成后可用">选择设计风格</button>
      </ActionBar>}
      {step === 3 && content && currentPage && <ActionBar>
        <PagerArrow dir="prev" disabled={busy || currentIndex === 0} onClick={() => { setPageIndex(currentIndex - 1); setEditingPage(null) }}/>
        <span>第 <span className="num">{currentIndex + 1}</span> / <span className="num">{contentPages.length}</span> 页</span>
        <PagerArrow dir="next" disabled={busy || currentIndex >= contentPages.length - 1} onClick={() => { setPageIndex(currentIndex + 1); setEditingPage(null) }}/>
        <span className="text-ink-sub">完成 <span className="num">{filledCount}</span> / <span className="num">{contentPages.length}</span> 页文字</span>
        <button type="button" className="btn btn-secondary rounded-full" disabled={busy} onClick={() => setStep(2)}>返回页面确认</button>
        <button type="button" className="btn btn-primary rounded-full" disabled={busy} onClick={() => void confirmContent()}>{busy ? '正在保存…' : '确认内容，选择风格'}</button>
      </ActionBar>}
      {step === 4 && <ActionBar>
        <button type="button" className="btn btn-secondary rounded-full" disabled={busy} onClick={() => setStep(3)}>返回内容梳理</button>
        <button type="button" className="btn btn-primary rounded-full px-6" disabled={busy || !packId || !selected.length || !contentSaved} onClick={() => void startPreview()}>生成前 <span className="num">{Math.min(3, selected.length)}</span> 页预览</button>
      </ActionBar>}
      {step === 4 && selected.length > 0 && (
        <p className="m-0 text-caption text-ink-sub">
          共 <span className="num">{selected.length}</span> 页；
          {result?.concurrency
            ? <>服务端每批最多 <span className="num">{result.concurrency}</span> 页并发生成{selected.length > result.concurrency ? <>（分 <span className="num">{Math.ceil(selected.length / result.concurrency)}</span> 批）</> : null}，单页耗时取决于生图模型</>
            : <>按页逐张生成，单页耗时取决于生图模型</>}
          。
        </p>
      )}
      {step === 6 && result && (
        <>
          <section className="card" aria-label="转可编辑进度">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="card-title m-0! text-h3">转可编辑</h2>
              <span className={cn('status', editableRunning ? 'status-info' : result.exports.editable ? 'status-success' : editableStream.status === 'error' ? 'status-danger' : 'status-info')}>{editableStageText}</span>
              <span className="num text-ink-sub">已完成 {editableDone} / {editableTotal} 页</span>
              <span className="flex-1" />
              {editableEngine && <span className={cn('status', editableEngine.ok ? 'status-success' : 'status-danger')}>{editableEngine.ok ? '引擎可用' : '引擎不可用'}</span>}
            </div>
            <p className="m-0 mt-2 text-body-sm text-ink-sub">
              把每页美化图交给 image-to-editable-ppt 精细重建：文字→原生文本框，图片/图标→透明 PNG 资产，图形→原生形状，背景→clean base 或原生背景；产物只包含所转页面，每页通过 validation 校验。
            </p>
            <div className="mt-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={editablePercent} aria-label="转可编辑进度">
              <div className="flex flex-wrap items-center gap-2 text-body-sm">
                <span className="font-semibold">{editableRunning ? (editableStream.message || '正在精细重建…') : editableStageText}</span>
                <span className="flex-1" />
                <span className="num font-semibold text-primary">{editablePercent}%</span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-alt">
                <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${editablePercent}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-sub">
                <span>已完成 <span className="num">{editableDone}</span> / <span className="num">{editableTotal}</span> 页</span>
                {editableSettledFailed > 0 && <span className="text-danger">失败 <span className="num">{editableSettledFailed}</span> 页</span>}
                {editableRunning && editableStream.startedAt && <span>已用 <span className="num">{fmtSec(editableElapsedMs)}</span></span>}
                {editableRunning && editableEtaMs > 0 && <span>约还需 <span className="num">{fmtSec(editableEtaMs)}</span>{editableDone > 0 ? '（按已完成页估算）' : '（按 13 分钟/页）'}</span>}
                {!editableRunning && result.exports.editable && <span>可编辑版已就绪</span>}
              </div>
            </div>
            {editableEngine && !editableEngine.ok && <div className="panel-alt mt-3 text-body-sm" role="alert">精细重建引擎不可用：{editableEngine.reason}</div>}
            {editableStream.status === 'error' && <div className="error-box mt-3" role="alert">精细重建失败：{editableStream.error || editableStream.message}</div>}
            {error && editableStream.status !== 'error' && <div className="error-box mt-3" role="alert">{error}</div>}
            {editableStream.status === 'cancelled' && <div className="panel-alt mt-3 text-body-sm" role="status">已停止：已完成页与现场保留，可重新开始。</div>}
          </section>

          {resultPages.length > 0 && (
            <div className="deck-split">
              <PageRail label="转可编辑页面列表" current={editableCurrentIndex} onSelect={setEditableIndex}
                items={resultPages.map(page => ({
                  key: page.page_no, label: `第 ${page.page_no} 页`,
                  thumb: withVersion(page.beauty_url || page.origin_url, result.updated_at),
                  status: (() => { const state = editablePageState(page.page_no); return { text: state.label, cls: state.cls } })(),
                }))} />
              <section className="deck-slide-shell" aria-label={`第 ${editableCurrent?.page_no ?? ''} 页转可编辑`}>
                <div className="deck-slide-head">
                  <span className="num font-semibold text-primary">P{editableCurrent?.page_no ?? ''}</span>
                  <span className="font-semibold">第 <span className="num">{editableCurrent?.page_no ?? ''}</span> 页</span>
                  {editableCurrent && <span className={cn('status', editablePageState(editableCurrent.page_no).cls)}>{editablePageState(editableCurrent.page_no).label}</span>}
                  <span className="flex-1" />
                  {!editableRunning && result.exports.editable && <a className="btn btn-primary rounded-full" href={result.exports.editable} download>下载可编辑版 PPT</a>}
                  {result.exports.image && <a className="btn btn-secondary rounded-full" href={result.exports.image} download>下载图片集 PPT</a>}
                </div>
                {editableCurrent?.beauty_url
                  ? <div className="deck-media-frame"><img src={withVersion(editableCurrent.beauty_url, result.updated_at)} alt={`第 ${editableCurrent.page_no} 页美化图`} /></div>
                  : <p className="deck-slide-empty">这一页还没有美化图。</p>}
                {editableRunning && <div className="panel-alt mt-2 text-body-sm" role="status">{editableStream.message || '正在精细重建…'}</div>}
              </section>
            </div>
          )}

          <ActionBar>
            {editableRunning
              ? <button type="button" className="btn btn-secondary rounded-full" onClick={() => void cancelEditableConversion()}>停止精细重建</button>
              : <button type="button" className="btn btn-primary rounded-full" disabled={!editableEngine?.ok || !editableTotal}
                  onClick={() => void convertEditable()}>{result.exports.editable ? '重新精细重建' : `开始精细重建（${editableTotal} 页）`}</button>}
            <button type="button" className="btn btn-secondary rounded-full" onClick={() => setStep(5)}>返回生成结果</button>
          </ActionBar>
        </>
      )}
      {versionPreview && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/70 p-4" role="dialog" aria-modal="true"
             aria-label="历史版本预览" onClick={() => setVersionPreview(null)}>
          <img src={versionPreview} alt="历史版本预览" className="max-h-[76vh] max-w-[92vw] rounded-md border border-white/25 bg-white object-contain"
               onClick={(event) => event.stopPropagation()} />
          <div className="flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
            <span className="text-body-sm text-white">这是历史版本预览；点「恢复此版本」才会替换当前结果</span>
            <button type="button" className="btn btn-secondary h-8! text-body-sm" onClick={() => setVersionPreview(null)}>关闭</button>
          </div>
        </div>
      )}
      {regenTarget !== null && <OptimizeDialog pageNo={regenTarget} onClose={() => setRegenTarget(null)} onConfirm={(instruction) => void regenerateCurrentPage(instruction)} />}
      {lightbox && result && resultPages.length > 0 && <PageLightbox
        pages={resultPages.map((page, index) => ({
          image: page.beauty_url,
          label: <>P<span className="num">{page.page_no}</span> · 第 <span className="num">{page.page_no}</span> 页</>,
          counter: <>P<span className="num">{page.page_no}</span> · 第 <span className="num">{index + 1}</span> / <span className="num">{resultPages.length}</span> 页</>,
        }))}
        index={resultCurrentIndex} onIndex={setResultIndex} onClose={() => setLightbox(false)} version={result.updated_at}
        ariaLabel={`第 ${resultCurrent?.page_no ?? ''} 页放大预览`} emptyText="这一页还没有生成结果" />}
      {step === 5 && result && resultPages.length > 0 && <ActionBar>
        <PagerArrow dir="prev" disabled={busy || resultCurrentIndex === 0} onClick={() => { setResultIndex(resultCurrentIndex - 1); setOverview(false) }}/>
        <span className="num">{resultCurrent.page_no} / {resultPages.length}</span>
        <PagerArrow dir="next" disabled={busy || resultCurrentIndex >= resultPages.length - 1} onClick={() => { setResultIndex(resultCurrentIndex + 1); setOverview(false) }}/>
        <span className="text-ink-sub">{jobActive
          ? <><span className="beautify-live-dot" aria-hidden="true" />正在生成 <span className="num">{resultDoneCount}</span> / <span className="num">{resultPages.length}</span> 页</>
          : <>已完成 <span className="num">{resultDoneCount}</span> / <span className="num">{resultPages.length}</span> 页</>}</span>
        <button type="button" className="btn btn-secondary rounded-full" disabled={busy || jobActive} onClick={() => setStep(4)}>重新选择风格</button>
        {result.phase === 'preview' && <button type="button" className="btn btn-primary rounded-full" disabled={busy || (!result.exports.image && stream.status !== 'cancelled')} onClick={() => void continueAll()}>{busy ? '正在生成…' : '确认预览，生成全部所选页面'}</button>}
        {result.phase === 'done' && <button type="button" className="btn btn-secondary rounded-full" disabled={busy}
          title="进入独立的「转可编辑」步骤：查看逐页进度、停止/继续并下载可编辑版"
          onClick={() => setStep(6)}>{result.exports.editable ? '查看转可编辑结果' : '下一步：转可编辑'}</button>}
        {result.exports.image && <a className={cn('btn rounded-full', result.exports.editable ? 'btn-secondary' : result.phase === 'preview' ? 'btn-secondary' : 'btn-primary')} href={result.exports.image} download>下载图片集 PPT</a>}
      </ActionBar>}
      {step === 5 && stream.status === 'error' && <button type="button" className="btn btn-secondary self-start" onClick={() => { setStep(4); setResult(null); setError(null); setJobId(null) }}>返回并重新生成预览</button>}
    </div>
  )
}
