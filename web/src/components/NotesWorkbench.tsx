/**
 * 备注工作台（#/notes/:id）
 *
 * 三步向导：选择方式并生成 → 逐页复核 → 导出。
 *
 * 设计要点：
 *  · 「识别到了什么」必须给人看 —— 这是防 AI 编内容的第一道闸门，所以每页都能展开看原始识别结果。
 *  · 备注可手改，也可写一句提示词让 AI 重写（单页粒度）。
 *  · 逐页落库：中途关掉网页，已完成的页不会重跑。
 *  · 逐页复核是「单页大图预览」版式：一次看一页（大图为主），输入框与操作按钮在图片下方，
 *    左右两个按钮翻页（也可跳页 / 用 ← → 键）。切换页时未保存的草稿留在内存里，不会丢。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  analyzeNotes,
  exportNotes,
  generateNotes,
  getNotesJob,
  regenerateNote,
  saveNote,
} from '../api'
import { ErrorState, Loading, Notice } from '../components/StateBlock'
import { useAsync } from '../hooks/useAsync'
import { useJobStream } from '../hooks/useJobStream'
import { cn, pageNo } from '../lib/format'
import { Link } from '../router'
import type { NotesPage as NotePage, VisionMode } from '../types'

type NotesSession = {
  step?: number; method?: 'vision' | 'direct'; visionMode?: VisionMode
  jobId?: string | null; stage?: 'analyze' | 'notes'; generated?: boolean
  exportStale?: boolean; analysisReady?: boolean; idx?: number; rewriteJob?: string | null; rewritePage?: number | null
}
function readSession(nid: string): NotesSession {
  try { return JSON.parse(sessionStorage.getItem(`notes-wizard:${nid}`) || '{}') } catch { return {} }
}
function writeSession(nid: string, update: NotesSession) {
  try { sessionStorage.setItem(`notes-wizard:${nid}`, JSON.stringify({ ...readSession(nid), ...update })) } catch { /* session storage unavailable */ }
}

/** 两种写备注的方式：标题按钮 + 一句小字，讲清楚什么时候用哪个、差别在哪 */
const NOTES_METHOD_OPTIONS: Array<{ value: 'vision' | 'direct'; label: string; desc: string }> = [
  {
    value: 'vision',
    label: '先识别图片，再写备注',
    desc: '图片/版式页适用：先让视觉模型读出画面里的文字和要点，再写备注，内容更准；要逐页识别，慢一些，也有识别费用。',
  },
  {
    value: 'direct',
    label: 'DeepSeek 直接写备注',
    desc: '文字页适用：只读文本框里的文字直接写，最快、不收识别费；纯图片页没有可用文字，可能写不出备注。',
  },
]

export function NotesWorkbench({ nid }: { nid: string }) {
  return <NotesWizard key={nid} nid={nid} />
}
function NotesWizard({ nid }: { nid: string }) {
  const [restored] = useState(() => readSession(nid))
  const [step, setStep] = useState(restored.step === 2 || restored.step === 3 ? restored.step : 1)
  const [method, setMethod] = useState<'vision' | 'direct' | null>(restored.method ?? null)
  const [generated, setGenerated] = useState(restored.generated ?? false)
  const [analysisReady, setAnalysisReady] = useState(restored.analysisReady ?? false)
  const [submitting, setSubmitting] = useState(false)
  const [reviewState, setReviewState] = useState({ unsaved: 0, busy: Boolean(restored.rewriteJob) })
  const actionLock = useRef(false)
  const [exportStale, setExportStale] = useState(restored.exportStale ?? false)

  const detail = useAsync(() => getNotesJob(nid), [nid], Boolean(nid))
  const [jobId, setJobId] = useState<string | null>(restored.jobId ?? null)
  const [stage, setStage] = useState<'analyze' | 'notes'>(restored.stage ?? 'analyze')
  const [visionMode, setVisionMode] = useState<VisionMode>(restored.visionMode === 'all' ? 'all' : 'auto')
  const [globalPrompt, setGlobalPrompt] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [exported, setExported] = useState<{ file: string; name: string; pages: number } | null>(null)
  const [exporting, setExporting] = useState(false)
  const lastReload = useRef(0)

  const reload = detail.reload
  // 放在 useCallback 之前声明：依赖数组在渲染时求值，晚声明会踩 TDZ
  const missingNotes = Math.max(0, (detail.data?.pages ?? 0) - (detail.data?.notes_done ?? 0))
  const stream = useJobStream(jobId)
  useEffect(() => {
    if (!jobId || !['done', 'error', 'cancelled', 'interrupted'].includes(stream.status)) return
    if (stage === 'notes') setGenerated(true)
    if (stage === 'analyze') setAnalysisReady(stream.status === 'done')
    if (stream.status !== 'done') setActionError(stream.error || stream.message || '任务中断，请重试')
    setJobId(null)
    reload()
  }, [jobId, stream.status, stream.error, stream.message, stage, reload])
  useEffect(() => {
    writeSession(nid, { step, method: method ?? undefined, visionMode, jobId, stage, generated, analysisReady, exportStale })
  }, [nid, step, method, visionMode, jobId, stage, generated, analysisReady, exportStale])


  // 边跑边刷新页面清单（节流 1.2s），让人能看到逐页推进
  useEffect(() => {
    if (!stream.byPage || Object.keys(stream.byPage).length === 0) return
    const now = Date.now()
    if (now - lastReload.current < 1200) return
    lastReload.current = now
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.byPage])

  const data = detail.data
  const pages = data?.pages_detail ?? []
  const running = jobId !== null || submitting
  const taskBusy = running || reviewState.busy || exporting
  const generationFinished = generated || (data?.notes_done ?? 0) > 0 || data?.status === 'done' || (data?.notes_failed ?? 0) > 0
  const canReview = generationFinished && !running
  const canExport = canReview && !reviewState.busy && reviewState.unsaved === 0 && missingNotes === 0 && (data?.pages ?? 0) > 0
  useEffect(() => {
    if (data && method === null) setMethod(data.image_pages > 0 ? 'vision' : 'direct')
    if (data && !detail.loading && !running && !reviewState.busy) {
      if (step > 1 && !generationFinished) setStep(1)
      else if (step === 3 && !canExport) setStep(2)
    }
  }, [data, method, detail.loading, running, reviewState.busy, step, generationFinished, canExport])
  // 从历史列表点「查看」进来（本页没有会话记录）且任务已有备注 → 直接落到「逐页复核」，
  // 让人一进来就能看到上次写的讲稿，而不是又从「选择生成方式」开始找。
  const hasSession = Object.keys(restored).length > 0
  useEffect(() => {
    if (hasSession || !data || detail.loading || running || reviewState.busy) return
    if (step === 1 && (data.notes_done ?? 0) > 0) setStep(2)
  }, [hasSession, data, detail.loading, running, reviewState.busy, step])
  const onReviewState = useCallback((unsaved: number, busy: boolean) => setReviewState(prev =>
    prev.unsaved === unsaved && prev.busy === busy ? prev : { unsaved, busy }), [])
  const onNotesChanged = useCallback(() => {
    setExported(null)
    setExportStale(true)
    reload()
  }, [reload])

  const startAnalyze = useCallback(async () => {
    if (actionLock.current) return
    actionLock.current = true
    setSubmitting(true)
    setAnalysisReady(false)
    setActionError(null)
    try {
      const res = await analyzeNotes(nid, visionMode)
      setStage('analyze')
      setJobId(res.job_id)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
    finally { actionLock.current = false; setSubmitting(false) }
  }, [nid, visionMode])

  const startNotes = useCallback(
    async (pageNos?: number[]) => {
      if (actionLock.current) return
      actionLock.current = true
      setSubmitting(true)
      setActionError(null)
      setExported(null)
      setExportStale(true)
      try {
        // 还有没写的页 → 续跑（只补缺的，不重跑已完成页）；全写完了 → 重新生成全部
        const onlyMissing = !pageNos && missingNotes > 0
        const res = await generateNotes(nid, pageNos, globalPrompt, onlyMissing)
        setStage('notes')
        setJobId(res.job_id)
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e))
      }
      finally { actionLock.current = false; setSubmitting(false) }
    },
    [nid, globalPrompt, missingNotes],
  )

  const doExport = useCallback(async () => {
    if (actionLock.current || !canExport) return
    actionLock.current = true
    setActionError(null)
    setExporting(true)
    try {
      const res = await exportNotes(nid, true)
      setExported(res)
      setExportStale(false)
      // 导出成功即自动开始下载（同时保留手动下载按钮兜底）
      const a = document.createElement('a')
      a.href = res.file
      a.download = res.name
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      actionLock.current = false
      setExporting(false)
    }
  }, [nid, canExport])

  if (detail.loading && !data) return <Loading rows={5} label="加载备注任务…" />
  if (detail.error && !data) return <ErrorState error={detail.error} onRetry={reload} title="加载失败" />
  if (!data) return <div className="card">找不到这个备注任务。</div>

  const visionDone = pages.filter((p) => p.vision_status === 'done').length
  const needVision = pages.filter((p) => p.low_info === 1).length
  // 上次导出的产物：刷新页面后仍能下载（export_path 存的是绝对路径，这里取文件名拼 /files/exports/）
  const lastExportName = (data.export_path || '').split('/').filter(Boolean).pop() ?? ''

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link to="/notes" className="link">‹ 返回备注列表</Link>
        <h1 className="m-0 mt-2 text-h1 font-semibold">{data.title || data.source_name}</h1>
      </div>

      <div className="steps flex-wrap" role="list" aria-label="备注生成步骤">
        {['选择方式并生成', '逐页复核', '导出'].map((label, index) => {
          const no = index + 1
          const allowed = no === 1 || (no === 2 ? canReview : canExport)
          return <div key={no} role="listitem" className="flex items-center gap-2">
            {index > 0 && <span className="step-sep">›</span>}
            <button type="button" className={cn('step', no === step ? 'active' : no < step ? 'done' : 'pending')}
              disabled={taskBusy || detail.loading || !allowed || no >= step} aria-current={no === step ? 'step' : undefined}
              onClick={() => setStep(no)}><span className="num">{no < step ? '✓' : no}</span>{label}</button>
          </div>
        })}
      </div>
      {detail.error && <div className="error-box" role="alert">{detail.error.message}<button className="btn btn-secondary" onClick={reload}>重试加载</button></div>}
      {actionError && <div className="error-box" role="alert">{actionError}</div>}
      <div hidden={step !== 1} style={{ display: step === 1 ? undefined : 'none' }} className="flex flex-col gap-4">
        <div className="card">
          <div className="card-title">选择生成方式</div>
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="选择生成方式">
            {NOTES_METHOD_OPTIONS.map(({ value, label, desc }) => {
              const active = method === value
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={taskBusy}
                  className={cn(
                    'flex flex-col items-start gap-1.5 rounded-md border px-4 py-3 text-left transition-colors',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                    active ? 'border-primary bg-surface-tag' : 'border-border bg-surface hover:bg-surface-alt',
                  )}
                  onClick={() => { setMethod(value); setGenerated(false) }}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className={cn('text-body-md font-semibold', active ? 'text-primary' : 'text-ink')}>{label}</span>
                    <span className="flex-1" />
                    {active && <span className="status status-info">已选</span>}
                  </span>
                  <span className="text-caption text-ink-sub">{desc}</span>
                </button>
              )
            })}
          </div>
        </div>

      {/* ② 画面识别 */}
      <div className="card" hidden={method !== 'vision'} style={{ display: method === 'vision' ? undefined : 'none' }}>
        <div className="card-title">建立内容真源（画面识别）</div>
        <p className="card-desc">
          图片版页面的文字都在图里，只读文本框什么也读不到。这里把每页渲染成图交给视觉模型识别，
          识别结果会逐页展示给你核验 —— <span className="text-ink">这是防止 AI 编内容的第一道闸门</span>。
          文字少的页共 <span className="num">{needVision}</span> 页，已识别 <span className="num">{visionDone}</span> 页。
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="metric-label">识别范围</span>
            <select
              className="input min-w-[240px]"
              value={visionMode}
              disabled={taskBusy}
              onChange={(e) => { setVisionMode(e.target.value as VisionMode); setAnalysisReady(false) }}
            >
              <option value="auto">自动：只识别文字少的图片页（推荐，省钱省时）</option>
              <option value="all">全部页面都识别（更准，更慢更贵）</option>
            </select>
          </label>
          <button
            type="button"
            className={cn('btn btn-primary', taskBusy && 'is-disabled')}
            disabled={taskBusy}
            onClick={() => void startAnalyze()}
          >
            {running && stage === 'analyze' ? '识别中…' : '开始识别'}
          </button>
          <span className="text-caption text-ink-sub">
            每页约 5~110 秒（画面越复杂越慢），3 页并发；大文件渲染约 30 秒
          </span>
        </div>
      </div>

      {/* ③ 写备注 */}
      <div className="card">
        <div className="card-title">用 DeepSeek 写备注</div>
        <p className="card-desc">
          只依据「页面文字 + 上面识别出的画面内容」写作，页面上没有的信息不许出现；篇幅随内容自适应 ——
          信息多的页写足，案例/截图页一句话带过。
        </p>
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="metric-label">这次生成的要求（可留空）</span>
            <input
              className="input"
              placeholder="例如：这版是给校领导汇报的，语气再正式一些；或：案例页统一用「我们看到」开头"
              value={globalPrompt}
              disabled={running}
              onChange={(e) => setGlobalPrompt(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={cn('btn btn-primary', (taskBusy || (method === 'vision' && !analysisReady)) && 'is-disabled')}
              disabled={taskBusy || (method === 'vision' && !analysisReady)}
              onClick={() => void startNotes()}
            >
              {running && stage === 'notes'
                ? '写备注中…'
                : data.notes_done === 0
                  ? `一键写完全部 ${data.pages} 页备注`
                  : missingNotes > 0
                    ? `接着写完剩下的 ${missingNotes} 页`
                    : `重新生成全部 ${data.pages} 页备注`}
            </button>
            <span className="text-caption text-ink-sub">
              {missingNotes > 0
                ? `点一次就把 ${missingNotes === data.pages ? '全部' : '剩下'} ${missingNotes} 页写完，不用逐页点；中断后回来再点会接着跑，不重跑已完成的页`
                : '已全部写完；再点会把每一页都重写一遍'}
            </span>
          </div>
        </div>
      </div>

      {/* 进度 */}
      {running && (
        <Notice kind="info">
          {stream.message || '已提交任务…'}
          {stream.total > 0 && (
            <span className="num ml-2">({Object.keys(stream.byPage).length}/{stream.total})</span>
          )}
        </Notice>
      )}

        <div className="flex justify-end">
          <button className="btn btn-primary" disabled={!canReview || taskBusy || detail.loading} onClick={() => setStep(2)}>下一步：逐页复核</button>
        </div>
      </div>
      <div hidden={step !== 2} style={{ display: step === 2 ? undefined : 'none' }} className="flex flex-col gap-4">
      {/* 第二步：复核组件始终挂载，切换步骤保留草稿 */}
      <div className="card">
        <NoteReviewer nid={nid} pages={pages} running={running} active={step === 2}
          onChanged={onNotesChanged} onState={onReviewState} />
      </div>

        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-secondary" disabled={taskBusy} onClick={() => setStep(1)}>上一步</button>
          {missingNotes > 0 && <span className="status status-warn">还有 <span className="num">{missingNotes}</span> 页缺少备注</span>}
          {reviewState.unsaved > 0 && <span className="status status-warn">还有 <span className="num">{reviewState.unsaved}</span> 页修改未保存</span>}
          <span className="flex-1" />
          <button className="btn btn-primary" disabled={!canExport || taskBusy || detail.loading} onClick={() => setStep(3)}>复核完成，下一步</button>
        </div>
      </div>
      <div hidden={step !== 3} style={{ display: step === 3 ? undefined : 'none' }} className="flex flex-col gap-4">
      {/* 导出：把备注写进 PPT 的备注栏（流程最后一步） */}
      <div className="card">
        <div className="card-title">导出（备注写进 PPT 的备注栏）</div>
        <p className="card-desc">
          导出一份<span className="text-ink">新的 .pptx</span>：页面内容、版式、字体、母版、图片与原件完全一致，
          备注栏里是刚生成的讲稿。原文件不会被改动；原文件本来就有备注的页，AI 备注会追加在原文下方。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={cn('btn btn-primary', (taskBusy || !canExport || detail.loading) && 'is-disabled')}
            disabled={taskBusy || !canExport || detail.loading}
            onClick={() => void doExport()}
          >
            {exporting ? '导出中…' : '导出带备注的 PPT'}
          </button>
          {exported && (
            <a className="btn btn-secondary" href={exported.file} download={exported.name}>
              下载 {exported.name}（<span className="num">{exported.pages}</span> 页已写入备注）
            </a>
          )}
          {!exported && !exportStale && lastExportName && (
            <a className="btn btn-secondary" href={`/files/exports/${encodeURIComponent(lastExportName)}`} download={lastExportName}>
              下载上次导出的文件（{lastExportName}）
            </a>
          )}
        </div>
        {exported && (
          <p className="m-0 mt-2 text-caption text-ink-sub">
            已开始下载 <span className="text-ink">{exported.name}</span>。在 PowerPoint / WPS 里打开后，
            点「视图 → 备注」或直接看页面下方的备注栏就能看到讲稿。
          </p>
        )}
      </div>
        <div><button className="btn btn-secondary" disabled={taskBusy} onClick={() => setStep(2)}>上一步：继续复核</button></div>
      </div>
    </div>
  )
}

const NOTE_STATUS: Record<string, { text: string; cls: string }> = {
  pending: { text: '未生成', cls: 'status-info' },
  running: { text: '生成中', cls: 'status-warn' },
  done: { text: '已生成', cls: 'status-success' },
  failed: { text: '失败', cls: 'status-danger' },
}

const VISION_STATUS: Record<string, { text: string; cls: string }> = {
  pending: { text: '未识别', cls: 'status-info' },
  done: { text: '已识别', cls: 'status-success' },
  failed: { text: '识别失败', cls: 'status-danger' },
  skipped: { text: '未做识别', cls: 'status-warn' },
}

/**
 * 单页大图预览 + 左右翻页。
 *
 * 草稿放在本组件的 map 里（键=页号）：翻页时输入框里没保存的内容不会丢，
 * 切回来还能接着改；保存成功或 AI 重写完成后，该页草稿作废、重新跟随服务端。
 */
function NoteReviewer({
  nid,
  pages,
  running,
  onChanged,
  active,
  onState,
}: {
  nid: string
  pages: NotePage[]
  running: boolean
  onChanged: () => void
  active: boolean
  onState: (unsaved: number, busy: boolean) => void
}) {
  const [restored] = useState(() => readSession(nid))
  const [idx, setIdx] = useState(restored.idx ?? 0)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [prompts, setPrompts] = useState<Record<number, string>>({})
  const [pendingPage, setPendingPage] = useState<number | null>(restored.rewriteJob ? restored.rewritePage ?? null : null)
  const [waitJob, setWaitJob] = useState<string | null>(restored.rewriteJob ?? null)
  const requestLock = useRef(false)
  const [err, setErr] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState<number | null>(null)

  const total = pages.length
  const safeIdx = Math.min(Math.max(idx, 0), Math.max(0, total - 1))
  const page: NotePage | undefined = pages[safeIdx]

  const goto = useCallback(
    (next: number) => {
      setErr(null)
      setIdx(Math.min(Math.max(next, 0), Math.max(0, total - 1)))
    },
    [total],
  )

  // ← → 翻页（在输入框里按方向键时不管，让人正常移动光标）
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowLeft') goto(safeIdx - 1)
      else if (e.key === 'ArrowRight') goto(safeIdx + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goto, safeIdx, active])

  const stream = useJobStream(waitJob)
  const unsavedCount = pages.filter((p) => (drafts[p.page_no] ?? p.note ?? '') !== (p.note ?? '')).length
  useEffect(() => { onState(unsavedCount, pendingPage !== null || waitJob !== null) }, [unsavedCount, pendingPage, waitJob, onState])
  useEffect(() => { writeSession(nid, { idx: safeIdx, rewriteJob: waitJob, rewritePage: pendingPage }) }, [nid, safeIdx, waitJob, pendingPage])
  useEffect(() => {
    if (!waitJob || !['done', 'error', 'cancelled', 'interrupted'].includes(stream.status)) return
    const finishedPage = pendingPage
    const success = stream.status === 'done'
    setWaitJob(null)
    if (!success) setErr(stream.error || stream.message || '重写中断，请重试')
    void getNotesJob(nid).then(fresh => {
      const result = fresh.pages_detail.find(p => p.page_no === finishedPage)
      if (success && result?.note_status === 'done') {
        setDrafts(d => { const next = { ...d }; if (finishedPage !== null) delete next[finishedPage]; return next })
      } else if (success) setErr(result?.error || '这一页重写失败，请重试或手工修改')
    }).catch(e => setErr(e instanceof Error ? e.message : String(e))).finally(() => {
      setPendingPage(null)
      onChanged()
    })
  }, [nid, waitJob, stream.status, stream.error, stream.message, pendingPage, onChanged])


  if (!page) {
    return <div className="panel-alt text-body-sm text-ink-sub">这个任务还没有页面记录。</div>
  }

  const draft = drafts[page.page_no] ?? page.note ?? ''
  const prompt = prompts[page.page_no] ?? ''
  const dirty = draft !== (page.note ?? '')
  const busy = pendingPage !== null || waitJob !== null
  const ns = NOTE_STATUS[page.note_status] ?? NOTE_STATUS.pending
  const vs = VISION_STATUS[page.vision_status] ?? VISION_STATUS.pending
  const hasContent = Boolean(page.text_source?.trim()) || page.vision_status === 'done'

  async function doSave() {
    if (!page || requestLock.current || busy || running) return
    requestLock.current = true
    const no = page.page_no
    setPendingPage(no)
    setErr(null)
    try {
      await saveNote(nid, no, draft)
      setDrafts((d) => {
        const next = { ...d }
        delete next[no]
        return next
      })
      setJustSaved(no)
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      requestLock.current = false
      setPendingPage(null)
    }
  }

  async function doRewrite() {
    if (!page || requestLock.current || busy || running) return
    requestLock.current = true
    const no = page.page_no
    setPendingPage(no)
    setErr(null)
    try {
      const res = await regenerateNote(nid, no, prompt)
      setWaitJob(res.job_id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setPendingPage(null)
    } finally { requestLock.current = false }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* 状态行 + 翻页 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="tag num">P{pageNo(page.page_no)}</span>
        <span className={cn('status', ns.cls)}>{ns.text}</span>
        <span className={cn('status', vs.cls)}>{vs.text}</span>
        {page.low_info === 1 && <span className="status status-warn" title="文字极少，内容主要在图里">图片页</span>}
        {page.has_original_note && <span className="status status-info" title="导出时保留在 AI 备注上方">原有备注</span>}
        {page.note_edited === 1 && <span className="status status-info">人工改过</span>}
        {dirty && <span className="status status-warn">未保存</span>}
        <span className="flex-1" />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={cn('btn btn-secondary h-8! text-body-sm', safeIdx === 0 && 'is-disabled')}
            disabled={safeIdx === 0}
            onClick={() => goto(safeIdx - 1)}
            title="上一页（← 键）"
          >
            ◀ 上一页
          </button>
          <label className="flex items-center gap-1 whitespace-nowrap text-body-sm text-ink-sub">
            第
            <input
              type="number"
              className="input num h-8! w-14 text-center text-body-sm"
              min={1}
              max={total}
              value={page.page_no}
              aria-label="跳转到页号"
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n) && n >= 1) goto(n - 1)
              }}
            />
            / {total} 页
          </label>
          <button
            type="button"
            className={cn('btn btn-secondary h-8! text-body-sm', safeIdx >= total - 1 && 'is-disabled')}
            disabled={safeIdx >= total - 1}
            onClick={() => goto(safeIdx + 1)}
            title="下一页（→ 键）"
          >
            下一页 ▶
          </button>
        </div>
      </div>

      {page.error && <div className="error-box text-body-sm">{page.error}</div>}

      {/* 左：页面预览；右：备注输入与操作。整块给固定高度 → 两列等高、按钮不会掉到图片下方 */}
      <div className="band grid gap-3 lg:h-[38vh] lg:min-h-[300px] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="panel-alt flex min-h-0 min-w-0 items-center justify-center">
          {page.image_url ? (
            <a
              href={page.image_url}
              target="_blank"
              rel="noreferrer"
              title="点开看原图"
              className="flex h-full w-full items-center justify-center"
            >
              <img
                src={page.image_url}
                alt={`第 ${page.page_no} 页`}
                className="max-h-full max-w-full rounded-sm border border-border bg-surface object-contain"
              />
            </a>
          ) : (
            <div className="text-body-sm text-ink-sub">
              {page.text_source?.trim() ? <pre className="max-h-[38vh] overflow-auto whitespace-pre-wrap font-sans">{page.text_source}</pre> : '这一页没有预览图或可提取文字，可手工填写备注'}
            </div>
          )}
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <textarea
            className="input min-h-[72px] w-full flex-1 resize-none"
            aria-label="本页备注"
            placeholder={hasContent ? '这页还没有备注，可手写，也可以点「AI 重写这一页」' : '这页没有可识别的内容，AI 不会凭空编，请手工填写'}
            value={draft}
            disabled={busy || running}
            onChange={(e) => {
              const v = e.target.value
              setDrafts((d) => ({ ...d, [page.page_no]: v }))
              setJustSaved(null)
            }}
          />
          <input
            className="input text-body-sm"
            aria-label="本页重写要求"
            placeholder="让 AI 重写这一页的要求（可留空，如：改成一句话带过）"
            value={prompt}
            disabled={busy || running}
            onChange={(e) => {
              const v = e.target.value
              setPrompts((p) => ({ ...p, [page.page_no]: v }))
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={cn('btn btn-secondary text-body-sm', (!dirty || busy || running) && 'is-disabled')}
              disabled={!dirty || busy || running}
              onClick={() => void doSave()}
            >
              {busy ? '保存中…' : justSaved === page.page_no ? '已保存' : '保存修改'}
            </button>
            <button
              type="button"
              className={cn('btn btn-primary text-body-sm', (busy || running) && 'is-disabled')}
              disabled={busy || running}
              onClick={() => void doRewrite()}
            >
              {busy ? '重写中…' : 'AI 重写这一页'}
            </button>
          </div>
          {busy && <span className="text-caption text-ink-sub">{stream.message || '正在重写…'}</span>}
          {err && <div className="error-box text-body-sm">{err}</div>}
        </div>
      </div>

      {unsavedCount > 0 && (
        <span className="text-caption status status-warn">还有 {unsavedCount} 页未保存的修改（翻页不丢，记得回去保存）</span>
      )}

      {/* 内容真源（防幻觉闸门：识别到了什么，人得能看） */}
      <details className="text-caption">
        <summary className="link cursor-pointer">识别到的内容（核验识别有没有错）</summary>
        <div className="mt-1 flex flex-col gap-1 text-ink-sub">
          <div>
            <span className="font-semibold text-ink">文本框文字：</span>
            {page.text_source?.trim() ? (
              <pre className="mt-1 whitespace-pre-wrap break-all font-sans">{page.text_source}</pre>
            ) : (
              <span>（没有）</span>
            )}
          </div>
          {page.vision_status === 'done' && (
            <>
              {page.vision?.visual && (
                <div>
                  <span className="font-semibold text-ink">画面：</span>
                  <span>{page.vision.visual}</span>
                </div>
              )}
              {!!page.vision?.text_on_page?.length && (
                <div>
                  <span className="font-semibold text-ink">画面里的文字：</span>
                  <span>{page.vision.text_on_page.join(' / ')}</span>
                </div>
              )}
              {!!page.vision?.data?.length && (
                <div>
                  <span className="font-semibold text-ink">画面里的数值：</span>
                  <span>{page.vision.data.map((d) => `${d.label ?? ''} ${d.value ?? ''}${d.unit ?? ''}`).join('，')}</span>
                </div>
              )}
            </>
          )}
        </div>
      </details>
    </div>
  )
}
