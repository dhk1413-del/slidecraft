/**
 * 「图片转可编辑」工作台 —— 第③步「转换结果」及项目工作台页签共用。
 *
 * 排版参考生成结果页：左侧页面内容列表，右侧当前页预览/重建进度，底部胶囊操作条。
 * 唯一引擎：第三方 skill `image-to-editable-ppt`（逐页本机 agent 精细重建，产物自带 validation 校验）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, SubmissionCancelled, cancelEditable, editableEngines, editpptStatus, exportDeck, toEditable } from '../api'
import { useJobStream } from '../hooks/useJobStream'
import { useSlides } from '../hooks/useSlides'
import { cn, pageNo } from '../lib/format'
import type { EditableEngine, EditpptStatus, ExportResponse, Slide } from '../types'
import { ActionBar, PageLightbox, PageRail, PagerArrow } from './FlowKit'
import { EmptyState, ErrorState, Loading } from './StateBlock'
import { useToast } from './Toast'

/** 现场里「这页已经转好了」的状态值（editppt 状态机的记录口径） */
const CONVERTED = ['recorded', 'accepted', 'complete']

export function EditableWorkbench({ projectId, autoStart = false }: { projectId: string; autoStart?: boolean }) {
  const toast = useToast()
  const [engine, setEngine] = useState<EditableEngine | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [editJobId, setEditJobId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [editError, setEditError] = useState<ApiError | null>(null)
  const [hiStatus, setHiStatus] = useState<EditpptStatus | null>(null)
  const [hiRunning, setHiRunning] = useState(false)
  const [artifact, setArtifact] = useState<ExportResponse | null>(null)

  const slidesState = useSlides(projectId, editJobId !== null)
  const slides: Slide[] = slidesState.data ?? []
  const readySlides = slides.filter((s) => !!s.image_url)

  const reloadHi = useCallback(() => {
    editpptStatus(projectId)
      .then(setHiStatus)
      .catch(() => setHiStatus(null))
    exportDeck(projectId, 'editable_hi')
      .then(setArtifact)
      .catch(() => setArtifact(null))
  }, [projectId])

  useEffect(() => {
    editableEngines()
      .then((res) => setEngine(res.engines.find((e) => e.id === 'editppt') ?? res.engines[0] ?? null))
      .catch(() => setEngine({ id: 'editppt', name: '精细重建引擎', ok: false, reason: '引擎探测失败（后端未就绪）', seconds_per_page: 0 }))
    reloadHi()
  }, [reloadHi])

  /** 现场里已转好的页（映射回后端页号） */
  const convertedPages = useMemo(() => {
    if (!hiStatus?.has_run) return []
    const out: number[] = []
    ;(hiStatus.pages || []).forEach((p, i) => {
      const no = hiStatus.page_nos?.[i]
      if (no != null && CONVERTED.includes(p.status)) out.push(no)
    })
    return out.sort((a, b) => a - b)
  }, [hiStatus])

  const readyPageNos = readySlides.map((s) => s.page_no)
  const pendingPages = readyPageNos.filter((n) => !convertedPages.includes(n))

  // 默认勾选：优先「还没转的页」；全都转过了就勾全部（便于重转）
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !readyPageNos.length) return
    seeded.current = true
    setSelected(pendingPages.length ? pendingPages : readyPageNos)
  }, [readyPageNos.length, pendingPages.length])

  useEffect(() => {
    setCurrentIndex((index) => Math.min(index, Math.max(0, readySlides.length - 1)))
  }, [readySlides.length])

  const stream = useJobStream(editJobId, {
    onDone: () => {
      setHiRunning(false)
      reloadHi()
      slidesState.reload()
      toast.success('精细重建完成（每页都通过了自带校验）')
    },
    onError: (m) => {
      setHiRunning(false)
      reloadHi()
      toast.error('转换中断', m)
    },
  })

  const submit = useCallback(
    async (targets: number[], resume = false) => {
      if (!targets.length) return
      if (engine && !engine.ok) {
        toast.error('引擎不可用', engine.reason ?? '')
        return
      }
      setSubmitting(true)
      setEditError(null)
      try {
        const res = await toEditable(projectId, targets, 'editppt', resume)
        setEditJobId(res.job_id)
        setHiRunning(true)
        toast.info(
          resume
            ? `继续转换：${targets.length} 页（已完成的页会跳过）`
            : `已开始精细重建：${targets.length} 页（实测约 13 分钟/页，可随时停止，已完成页会保留）`,
        )
        slidesState.reload()
      } catch (e) {
        if (e instanceof SubmissionCancelled) { toast.info('已取消，未提交'); return }
        const error = e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 0)
        setEditError(error)
        toast.error('提交失败', error.detail)
      } finally {
        setSubmitting(false)
      }
    },
    [engine, projectId, slidesState, toast],
  )

  /** 转换当前勾选的页；resume=true 走现场续跑（页清单必须用现场记录的） */
  const start = (resume = false) => {
    const targets = resume && hiStatus?.page_nos?.length ? hiStatus.page_nos : [...selected].sort((a, b) => a - b)
    void submit(targets, resume)
  }

  // 一键流：保留 autoStart 入口（当前 3 步流程默认 false）
  const autoRan = useRef(false)
  useEffect(() => {
    if (!autoStart || autoRan.current || !readyPageNos.length) return
    const guard = `deckforge:editable-auto:${projectId}`
    if (sessionStorage.getItem(guard)) return
    autoRan.current = true
    sessionStorage.setItem(guard, '1')
    const targets = pendingPages.length ? pendingPages : readyPageNos
    setSelected(targets)
    void submit(targets, false)
  }, [autoStart, projectId, readyPageNos.length, pendingPages.length, submit])

  const selectedSet = new Set(selected)
  const pageMinutes = engine?.seconds_per_page ? engine.seconds_per_page / 60 : 13
  const estLabel = `${selected.length} 页 ≈ ${Math.max(1, Math.round(selected.length * pageMinutes))} 分钟`

  const currentSlide = readySlides[Math.min(currentIndex, Math.max(0, readySlides.length - 1))]
  const doneCount = Math.max(convertedPages.length, Object.values(stream.settled).filter((s) => s === 'done').length, stream.progressDone)
  const totalCount = readySlides.length
  const donePercent = totalCount ? Math.min(100, Math.round((doneCount * 100) / totalCount)) : 0

  /** 页面状态：现场已完成 / 当前 SSE 事件 / 排队 / 未转换（不伪造百分比） */
  const pageState = (no: number) => {
    const event = stream.byPage[no]
    if (convertedPages.includes(no) || event?.status === 'done' || stream.settled[no] === 'done') return { text: '已完成', cls: 'status-success' }
    if (event?.status === 'failed' || stream.settled[no] === 'failed') return { text: '失败', cls: 'status-danger' }
    if (event?.status === 'running' || (hiRunning && stream.page === no)) return { text: '生成中', cls: 'status-info' }
    if (hiRunning && selected.includes(no)) return { text: '排队中', cls: 'status-info' }
    return { text: '未转换', cls: 'status-info' }
  }
  const currentState = currentSlide ? pageState(currentSlide.page_no) : { text: '未转换', cls: 'status-info' }
  const currentRunning = currentState.text === '生成中'
  const currentQueued = currentState.text === '排队中'

  const rail = (
    <aside className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-col gap-1 px-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold">页面内容</span>
          <span className="num text-caption text-ink-sub">已选 {selected.length}/{readySlides.length}</span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <button type="button" className="link text-caption" disabled={!readyPageNos.length} onClick={() => setSelected(readyPageNos)}>全选</button>
          <button type="button" className="link text-caption" disabled={!pendingPages.length} onClick={() => setSelected(pendingPages)}>只选未转页（{pendingPages.length}）</button>
          <button type="button" className="link text-caption" disabled={!selected.length} onClick={() => setSelected([])}>清空</button>
        </div>
      </div>
      <PageRail label="页面内容" current={currentIndex} onSelect={setCurrentIndex}
        items={readySlides.map((slide) => ({
          key: slide.slide_id ?? slide.page_no,
          label: `第 ${slide.page_no} 页`,
          thumb: slide.image_url,
          status: pageState(slide.page_no),
        }))} />
    </aside>
  )

  const preview = currentSlide ? (
    <section className="deck-slide-shell" aria-label={`第 ${currentSlide.page_no} 页转换结果`}>
      <div className="deck-slide-head">
        <span className="num font-semibold text-primary">P{pageNo(currentSlide.page_no)}</span>
        <span className="font-semibold">第 <span className="num">{currentSlide.page_no}</span> 页</span>
        <span className={cn('status', currentState.cls)}>{currentState.text}</span>
        <span className="flex-1" />
        {selectedSet.has(currentSlide.page_no) && <span className="status status-info">已勾选</span>}
        <button type="button" className="btn btn-secondary rounded-full" onClick={() => setLightboxIndex(readySlides.indexOf(currentSlide))}>查看大图</button>
      </div>
      <div className="relative">
        <div className="deck-media-frame">
          <img src={currentSlide.image_url} alt={`第 ${currentSlide.page_no} 页原图`} loading="eager" decoding="async" />
        </div>
        {(currentRunning || currentQueued) && (
          <div className="absolute inset-0 flex items-center justify-center rounded-[18px] bg-white/75 p-4 backdrop-blur-sm">
            <div className="card flex w-full max-w-[28rem] flex-col items-center gap-3 text-center">
              {currentRunning ? <span className="deck-spinner" aria-hidden="true" /> : <span className="beautify-live-dot" aria-hidden="true" />}
              <p className="m-0 text-body-lg font-semibold">{currentRunning ? '正在精细重建本页…' : '排队中，等待前序页面完成…'}</p>
              <p className="m-0 text-body-sm text-ink-sub">
                {currentRunning ? (stream.message || '文字/图片/图形/背景分别拆分为原生对象') : '本页已勾选，轮到它时会自动开始'}
              </p>
              <div className="mt-1 w-full" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={donePercent} aria-label="整体转换进度">
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface-alt">
                  <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${donePercent}%` }} />
                </div>
                <p className="m-0 mt-2 text-caption text-ink-sub">整体进度 {doneCount} / {totalCount} 页 · 单页约 {pageMinutes} 分钟</p>
              </div>
            </div>
          </div>
        )}
      </div>
      {hiStatus?.note && <p className="m-0 text-caption text-ink-sub">{hiStatus.note}</p>}
    </section>
  ) : null

  const actionBar = (
    <ActionBar>
      <PagerArrow dir="prev" disabled={currentIndex === 0} onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))} />
      <span className="num">{Math.min(currentIndex + 1, readySlides.length)} / {readySlides.length}</span>
      <PagerArrow dir="next" disabled={currentIndex >= readySlides.length - 1} onClick={() => setCurrentIndex((i) => Math.min(readySlides.length - 1, i + 1))} />
      <span className="text-ink-sub">
        {hiRunning ? <><span className="beautify-live-dot" aria-hidden="true" />正在生成 <span className="num">{doneCount}</span> / <span className="num">{totalCount}</span> 页</> : <>已完成 <span className="num">{doneCount}</span> / <span className="num">{totalCount}</span> 页</>}
      </span>
      <span className="flex-1" />
      {!hiRunning && <span className="text-caption text-ink-sub">{estLabel}</span>}
      {hiRunning && (
        <button type="button" className="btn btn-secondary rounded-full"
          onClick={() => cancelEditable(projectId).then((r) => { toast.info('已请求停止', r.message); setHiRunning(false); reloadHi() }).catch((e: ApiError) => toast.error('停止失败', e.detail))}>
          停止
        </button>
      )}
      {!hiRunning && hiStatus?.resumable && (
        <button type="button" className="btn btn-secondary rounded-full" onClick={() => start(true)}
          title="复用现场：已通过校验的页会跳过，不重复重建">继续转换（已完成 {hiStatus.recorded}/{hiStatus.total} 页）</button>
      )}
      <button type="button" className="btn btn-primary rounded-full px-6"
        disabled={submitting || hiRunning || !selected.length || (engine ? !engine.ok : false)}
        onClick={() => start()}
        title={!selected.length ? '先勾选要转的页' : engine && !engine.ok ? `引擎不可用：${engine.reason ?? ''}` : 'POST /api/projects/{id}/editable（engine=editppt）'}>
        {submitting ? '提交中…' : hiRunning ? '转换中…' : `开始精细重建（${selected.length} 页）`}
      </button>
      {artifact
        ? <a className="btn btn-secondary rounded-full" href={artifact.file} download title={`${artifact.pages} 页可编辑 PPTX`}>下载可编辑 PPTX</a>
        : <span className="btn btn-secondary rounded-full pointer-events-none opacity-50">下载可编辑 PPTX</span>}
    </ActionBar>
  )

  if (slidesState.loading && !slides.length) return <Loading rows={2} label="加载原页…" />
  if (slidesState.error) return <ErrorState error={slidesState.error} onRetry={slidesState.reload} title="原页加载失败" />

  return (
    <div className="flex flex-col gap-4">
      {engine && !engine.ok && (
        <div className="panel-alt text-body-sm" role="alert">精细重建引擎不可用：{engine.reason ?? '未知原因'}</div>
      )}
      {editError && <ErrorState error={editError} onRetry={() => start()} title="提交转换失败" />}
      {!readySlides.length ? (
        <EmptyState
          title="还没有可转的原页"
          desc="在首页「图片转可编辑」上传 PDF / 图片 / pptx，或先在「生成结果」里出图片版，再回到本页签重建。"
          actionLabel="回到首页上传"
          to="/?mode=editable"
        />
      ) : (
        <>
          <div className="deck-split">
            {rail}
            {preview}
          </div>
          {actionBar}
        </>
      )}
      {lightboxIndex !== null && readySlides.length > 0 && <PageLightbox
        pages={readySlides.map((slide, index) => ({
          image: slide.image_url,
          label: <>P<span className="num">{slide.page_no}</span> · 第 <span className="num">{slide.page_no}</span> 页{slide.title ? ` · ${slide.title}` : ''}</>,
          counter: <>P<span className="num">{slide.page_no}</span> · 第 <span className="num">{index + 1}</span> / <span className="num">{readySlides.length}</span> 页</>,
        }))}
        index={lightboxIndex}
        onIndex={(index) => { setLightboxIndex(index); setCurrentIndex(index) }}
        onClose={() => setLightboxIndex(null)}
        ariaLabel={`第 ${readySlides[lightboxIndex]?.page_no ?? ''} 页放大预览`}
        emptyText="加载原页…"
      />}
    </div>
  )
}
