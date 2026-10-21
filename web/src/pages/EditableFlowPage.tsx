/** 图片转可编辑：独立 3 步（上传内容 → 页面确认 → 转换结果），不再套用生成向导的 5/6 步。 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, cancelEditable, editableEngines, editpptStatus, exportDeck, getProject, getSlides, importPages, reviewSlide, toEditable } from '../api'
import { Dropzone } from '../components/Dropzone'
import { EditableWorkbench } from '../components/EditableWorkbench'
import { ActionBar, FlowSteps, type FlowStep } from '../components/FlowKit'
import { EmptyState, ErrorState, Loading, Notice } from '../components/StateBlock'
import { SlideThumb, ThumbGrid } from '../components/ThumbGrid'
import { useToast } from '../components/Toast'
import { useJobStream } from '../hooks/useJobStream'
import { cn, MAX_UPLOAD_BYTES, uploadTooLarge } from '../lib/format'
import { Link, readQuery } from '../router'
import type { EditableEngine, EditpptStatus, Project, Slide } from '../types'

const CONVERTED = ['recorded', 'accepted', 'complete']

const EDITABLE_STEPS: FlowStep[] = [
  { key: 1, label: '上传内容' },
  { key: 2, label: '页面确认' },
  { key: 3, label: '转换结果' },
]

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.pptx'

export function EditableFlowPage({ projectId }: { projectId: string }) {
  const toast = useToast()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [project, setProject] = useState<Project | null>(null)
  const [slides, setSlides] = useState<Slide[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [selectedPages, setSelectedPages] = useState<number[]>([])
  const [downloading, setDownloading] = useState(false)
  const [engine, setEngine] = useState<EditableEngine | null>(null)
  const [hiStatus, setHiStatus] = useState<EditpptStatus | null>(null)
  const [editJobId, setEditJobId] = useState<string | null>(null)
  const [hiRunning, setHiRunning] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [editError, setEditError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorObject, setErrorObject] = useState<ApiError | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) { setLoading(false); return }
    setLoading(true); setError(null); setErrorObject(null)
    try {
      const [nextProject, nextSlides] = await Promise.all([getProject(projectId), getSlides(projectId)])
      const readySlides = nextSlides.filter(slide => slide.image_url)
      setProject(nextProject)
      setSlides(readySlides)
      // 默认全选；已有勾选时只保留仍可转换的页（页面被替换后不留下失效页号）
      setSelectedPages(prev => {
        const kept = prev.filter(no => readySlides.some(slide => slide.page_no === no))
        return kept.length ? kept : readySlides.map(slide => slide.page_no)
      })
      setStep((current): 1 | 2 | 3 => {
        const hasImages = readySlides.length > 0
        if (!hasImages) return current
        // 从「生成页面」的「转可编辑 PPT」直接进入转换页（已生成的项目不需要再走上传/页面确认）
        if (readQuery().step === '3') return 3
        return current === 1 ? 2 : current
      })
    } catch (e) {
      setError((e as ApiError)?.detail || '项目加载失败')
      setErrorObject(e as ApiError)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void reload() }, [reload])

  /** 现场状态（已记录页 / 是否可续跑）与引擎信息：用于选择页的进度角标和单页预估 */
  const reloadHi = useCallback(() => {
    editpptStatus(projectId).then(setHiStatus).catch(() => setHiStatus(null))
  }, [projectId])

  useEffect(() => {
    editableEngines()
      .then(res => setEngine(res.engines.find(e => e.id === 'editppt') ?? res.engines[0] ?? null))
      .catch(() => setEngine(null))
    reloadHi()
  }, [reloadHi])

  const stream = useJobStream(editJobId, {
    onDone: () => {
      setHiRunning(false)
      reloadHi()
      toast.success('精细重建完成（每页都通过了自带校验）')
    },
    onError: (message) => {
      setHiRunning(false)
      reloadHi()
      toast.error('转换中断', message)
    },
  })

  const convertedPages = useMemo(() => {
    if (!hiStatus?.has_run) return []
    const out: number[] = []
    ;(hiStatus.pages || []).forEach((p, i) => {
      const no = hiStatus.page_nos?.[i]
      if (no != null && CONVERTED.includes(p.status)) out.push(no)
    })
    return out.sort((a, b) => a - b)
  }, [hiStatus])

  const pageMinutes = engine?.seconds_per_page ? Math.round(engine.seconds_per_page / 60) : 13

  /** 第①步：已建好项目，把上传的 PDF/图片/PPTX 逐页渲染并登记成 slides */
  async function upload() {
    if (!files.length || busy) return
    const tooLarge = files.find(file => file.size > MAX_UPLOAD_BYTES)
    if (tooLarge) { setError(uploadTooLarge(tooLarge)); return }
    setBusy(true); setError(null); setErrorObject(null)
    try {
      await importPages(projectId, files)
      const fresh = (await getSlides(projectId)).filter(slide => slide.image_url)
      setSlides(fresh)
      setSelectedPages(fresh.map(slide => slide.page_no))
      setFiles([])
      setStep(2)
      toast.success('页面已导入', `共 ${fresh.length} 页，确认后开始精细重建`)
    } catch (e) {
      setError((e as ApiError)?.detail || '导入失败，请重试')
      setErrorObject(e as ApiError)
    } finally {
      setBusy(false)
    }
  }

  /** 第②步：勾选要转可编辑的页；未勾选的页保持图片版（可随图片集一起下载） */
  const togglePage = (no: number) => {
    setSelectedPages(prev => prev.includes(no) ? prev.filter(n => n !== no) : [...prev, no].sort((a, b) => a - b))
  }
  const allSelected = slides.length > 0 && selectedPages.length === slides.length
  const estimateMinutes = Math.max(1, Math.round(selectedPages.length * pageMinutes))

  /** 第②步就把选中的页提交转换：页面停留在选择网格，用角标/浮层展示逐页进度 */
  async function startConversion(resume = false) {
    const targets = resume && hiStatus?.page_nos?.length ? hiStatus.page_nos : selectedPages
    if (!targets.length || submitting) return
    setSubmitting(true); setEditError(null)
    try {
      const res = await toEditable(projectId, targets, 'editppt', resume)
      setEditJobId(res.job_id)
      setHiRunning(true)
      setConfirmed(true)
      toast.info(
        resume ? `继续转换：${targets.length} 页（已完成的页会跳过）`
          : `已开始精细重建：${targets.length} 页（实测约 ${pageMinutes} 分钟/页，可随时停止）`,
      )
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 0)
      setEditError(err)
      toast.error('提交转换失败', err.detail)
    } finally {
      setSubmitting(false)
    }
  }

  async function cancelConversion() {
    try {
      const res = await cancelEditable(projectId)
      toast.info('已请求停止', res.message)
      setHiRunning(false)
      reloadHi()
    } catch (e) {
      toast.error('停止失败', (e as ApiError).detail)
    }
  }

  /** 单页进度：完成 > 失败 > 转换中 > 排队 > 图片版 */
  type GridState = 'done' | 'failed' | 'running' | 'queued' | 'idle'
  const pageProgress = (no: number): GridState => {
    const ev = stream.byPage[no]
    if (convertedPages.includes(no) || stream.settled[no] === 'done' || ev?.status === 'done') return 'done'
    if (stream.settled[no] === 'failed' || ev?.status === 'failed') return 'failed'
    if (ev?.status === 'running') return 'running'
    if (hiRunning && selectedPages.includes(no)) return 'queued'
    return 'idle'
  }
  const badgeFor = (state: GridState) => state === 'done' ? { text: '已完成', cls: 'status-success' }
    : state === 'failed' ? { text: '失败', cls: 'status-danger' }
      : state === 'running' ? { text: '转换中', cls: 'status-warn' }
        : state === 'queued' ? { text: '排队中', cls: 'status-info' }
          : { text: '图片版', cls: 'status-info' }
  const overlayFor = (state: GridState) => state === 'running' ? (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-[10px] bg-white/75 backdrop-blur-sm">
      <span className="deck-spinner" aria-hidden="true" />
      <span className="num text-caption text-ink-sub">预计约 {pageMinutes} 分钟</span>
    </div>
  ) : state === 'queued' ? (
    <div className="h-full w-full rounded-[10px] bg-white/45" />
  ) : null

  const streamDone = Object.values(stream.settled).filter(s => s === 'done').length
  const doneCount = Math.max(convertedPages.length, streamDone, stream.progressDone)

  /** 下载图片集 PPT：未核对的生成页先按「已逐项核对」确认（与生成结果页同一口径） */
  async function downloadImageDeck() {
    if (downloading || !slides.length) return
    setDownloading(true)
    try {
      const pending = slides.filter(slide => slide.keep && slide.review_required && slide.image_url)
      if (pending.length) {
        const ok = window.confirm(
          `还有 ${pending.length} 页尚未人工核对。\n\n请先逐页对照原文确认画面无误；点「确定」表示这些页面都已核对，系统会标记后导出图片版 PPT。`,
        )
        if (!ok) return
        await Promise.all(pending.map(slide => reviewSlide(projectId, slide.slide_id, slide.image_url)))
      }
      const res = await exportDeck(projectId, 'image')
      if (!res.file) throw new ApiError('导出没有返回文件地址，请稍后重试', 0)
      const link = document.createElement('a')
      link.href = res.file
      link.download = ''
      document.body.append(link)
      link.click()
      link.remove()
      toast.success('已生成图片版 PPT', `共 ${res.pages} 页`)
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 0)
      toast.error('导出图片版失败', err.detail)
    } finally {
      setDownloading(false)
    }
  }

  const stepLocks: Record<number, string | undefined> = {
    1: undefined,
    2: slides.length ? undefined : '先在第①步上传内容',
    3: confirmed ? undefined : '先在第②步确认页面',
  }

  if (loading) return <Loading rows={3} label="正在读取项目…" />
  if (errorObject && !project) return <ErrorState error={errorObject} onRetry={() => void reload()} title="项目加载失败" />
  if (!project) return <EmptyState title="项目不存在" desc="请先在首页上传 PDF / 图片 / PPTX，或返回我的项目。" to="/projects" actionLabel="返回我的项目" />

  return (
    <div className="flex flex-col gap-4">
      <header className="card flex flex-col gap-3">
        <h1 className="m-0 truncate text-2xl font-semibold">{project.title || '图片转可编辑'}</h1>
        <FlowSteps steps={EDITABLE_STEPS} current={step} locks={stepLocks} busy={busy}
          onJump={(target) => setStep(target as 1 | 2 | 3)}
          onLocked={(_, reason) => { if (reason) toast.info('暂时不能进入', reason) }}
          label="图片转可编辑步骤" />
      </header>

      {step === 1 && (
        <>
          <section className="card flex flex-col gap-3">
            <h2 className="card-title m-0! text-h3">上传内容</h2>
            <p className="m-0 text-body-sm text-ink-sub">
              支持 PDF / PNG / JPG / WEBP / PPTX，多张图片按上传顺序拼成一册。上传后先按页渲染成图片，再交给
              image-to-editable-ppt 精细重建；原始文件只用于逐页渲染，不会整页贴图。
            </p>
            <Dropzone multiple head="拖入 PDF / 图片 / pptx（可多选）" hint="点击此处选择文件"
              formats="PDF · PNG · JPG · WEBP · PPTX · 多张图片按顺序拼成一册"
              accept={ACCEPT} onPick={(picked) => { setError(null); setFiles(picked) }} />
            {files.length > 0 && (
              <div className="panel-alt flex flex-wrap items-center gap-2">
                <span className="status status-success">已选择 {files.length} 个文件</span>
                <span className="truncate">{files[0].name}{files.length > 1 ? ' 等' : ''}</span>
                <span className="num text-caption text-ink-sub">{Math.round(files.reduce((sum, file) => sum + file.size, 0) / 1024)} KB</span>
                <span className="flex-1" />
                <button type="button" className="link text-caption" onClick={() => setFiles([])}>清除</button>
              </div>
            )}
            {slides.length > 0 && <Notice kind="info">这个项目已经有 {slides.length} 页导入结果，可直接进入第②步页面确认。</Notice>}
            {error && <div className="error-box text-body-sm" role="alert">{error}</div>}
          </section>
          <ActionBar>
            {slides.length > 0 && <button type="button" className="btn btn-secondary rounded-full" onClick={() => setStep(2)}>直接进入页面确认</button>}
            <button type="button" className="btn btn-primary rounded-full" disabled={!files.length || busy} onClick={() => void upload()}>
              {busy ? '正在导入…' : '导入并进入页面确认'}
            </button>
          </ActionBar>
        </>
      )}

      {step === 2 && (
        <>
          <section className="card flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="card-title m-0! text-h3">整套页面</h2>
              <span className="num text-ink-sub">共 {slides.length} 页</span>
              <span className="flex-1" />
              {!hiRunning && (
                <button type="button" className="link text-caption" onClick={() => setSelectedPages(allSelected ? [] : slides.map(slide => slide.page_no))}>
                  {allSelected ? '取消全选' : '全选'}
                </button>
              )}
              {hiRunning && <span className="status status-warn">转换中</span>}
            </div>
            <p className="m-0 text-body-sm text-ink-sub">
              {hiRunning
                ? `正在精细重建选中的 ${selectedPages.length} 页（单页约 ${pageMinutes} 分钟）；可随时停止，已完成页会保留。`
                : '勾选需要转为文字可编辑的图片页面；未勾选的页面仍保留图片版，可一并下载。'}
            </p>
            <ThumbGrid>
              {slides.map(slide => {
                const state = pageProgress(slide.page_no)
                return (
                  <SlideThumb key={slide.slide_id ?? slide.page_no} pageNoValue={slide.page_no}
                    title={slide.title || `第 ${slide.page_no} 页`} slide={slide}
                    selectable={!hiRunning}
                    selected={!hiRunning && selectedPages.includes(slide.page_no)}
                    onToggle={() => togglePage(slide.page_no)}
                    badgeOverride={badgeFor(state)} overlay={overlayFor(state)} showMeta={false} />
                )
              })}
            </ThumbGrid>
            {hiStatus?.note && !hiRunning && <p className="m-0 text-caption text-ink-sub">{hiStatus.note}</p>}
            {editError && <div className="error-box text-body-sm" role="alert">转换提交失败：{editError.detail}</div>}
            {error && <div className="error-box text-body-sm" role="alert">{error}</div>}
          </section>
          <ActionBar>
            {hiRunning ? (
              <>
                <span className="text-ink-sub">
                  <span className="beautify-live-dot" aria-hidden="true" />转换中 <span className="num">{selectedPages.length}</span> 页 · 已完成 <span className="num">{doneCount}</span> / <span className="num">{selectedPages.length}</span>
                </span>
                <span className="flex-1" />
                <Link className="btn btn-secondary rounded-full" to={`/projects/${projectId}`}>查看我的项目</Link>
                <button type="button" className="btn btn-secondary rounded-full" disabled={downloading} onClick={() => void downloadImageDeck()}>
                  {downloading ? '导出中…' : '下载图片集 PPT'}
                </button>
                <button type="button" className="btn btn-secondary rounded-full" onClick={() => void cancelConversion()}>停止</button>
                <span className="btn btn-primary rounded-full pointer-events-none opacity-60" aria-disabled="true">转换中…</span>
              </>
            ) : (
              <>
                <span className="num text-ink-sub">
                  {doneCount > 0 ? <>已完成 <span className="text-ink">{doneCount}</span> / {selectedPages.length} 页 · </> : null}
                  已选 <span className="text-ink">{selectedPages.length}</span> / {slides.length} 页 · 预计约 {estimateMinutes} 分钟
                </span>
                <span className="flex-1" />
                <Link className="btn btn-secondary rounded-full" to={`/projects/${projectId}`}>查看我的项目</Link>
                <button type="button" className="btn btn-secondary rounded-full" disabled={!slides.length || downloading} onClick={() => void downloadImageDeck()}>
                  {downloading ? '导出中…' : '下载图片集 PPT'}
                </button>
                {hiStatus?.resumable && (
                  <button type="button" className="btn btn-secondary rounded-full" disabled={submitting} onClick={() => void startConversion(true)}>
                    继续转换（已完成 {hiStatus.recorded}/{hiStatus.total} 页）
                  </button>
                )}
                {doneCount > 0 ? (
                  <button type="button" className="btn btn-primary rounded-full" onClick={() => { setConfirmed(true); setStep(3) }}>查看转换结果</button>
                ) : (
                  <button type="button" className="btn btn-primary rounded-full"
                    disabled={submitting || !selectedPages.length || (engine ? !engine.ok : false)}
                    title={engine && !engine.ok ? `引擎不可用：${engine.reason ?? ''}` : '把选中的页逐页精细重建为可编辑对象'}
                    onClick={() => void startConversion()}>
                    {submitting ? '提交中…' : '转为可编辑 PPT'}
                  </button>
                )}
              </>
            )}
          </ActionBar>
        </>
      )}

      {step === 3 && <EditableWorkbench projectId={projectId} autoStart={false} initialSelected={selectedPages} />}

      <p className={cn('m-0 text-caption text-ink-sub', step !== 1 && 'hidden')}>
        数据来源：GET /api/projects/{projectId}/slides
      </p>
    </div>
  )
}

export default EditableFlowPage
