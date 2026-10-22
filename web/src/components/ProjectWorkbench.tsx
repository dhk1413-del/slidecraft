import { } from '../api'
/**
 * 生成结果（第 ⑤ 步）：POST /generate → SSE 逐页进度 → 缩略图网格 → 导出图片版 PPTX
 *
 * 「图片转可编辑」已独立成模块（`#/editable`，只走第三方 skill 的精细重建），
 * 导出面板统一提供图片版、已有原生版与版本绑定转换。
 * 向导页（#/wizard 第 ⑤ 步）与项目工作台页（#/projects/:id）共用本组件。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, SubmissionCancelled, exportDeck, restoreSlideVersion, reviewSlide, getProjectJobs, generate, getSlides, regenerateSlide } from '../api'
import { useJobStream } from '../hooks/useJobStream'
import { useSlides } from '../hooks/useSlides'
import { cn, ms } from '../lib/format'
import { Link } from '../router'
import type { GenerationJob, Slide } from '../types'
import { EditableWorkbench } from './EditableWorkbench'
import { ActionBar, OverviewGrid, PageLightbox, PageRail, PagerArrow } from './FlowKit'
import { EmptyState, ErrorState, Loading, Notice, NotConfiguredBanner } from './StateBlock'
import { useToast } from './Toast'
import { LocalDemoDialog } from './OnboardingGuide'
import { useImageReady } from './ProviderStatus'

const SIZES = ['2K', '4K'] as const

export interface ProjectWorkbenchProps {
  projectId: string
  /** 生成时绑定的风格包；缺省时提示回第 ④ 步选择 */
  stylePackId?: string | null
  defaultSize?: string
  /** 参与生成的页号；缺省 = 已解析出的全部页 */
  pageNos?: number[]
  /** generate / both：只看生成结果；editable：只看按图片版重建（独立流程用，不渲染页签） */
  view?: 'generate' | 'editable' | 'both'
  /** 首页模式② 一键流：进入即自动勾选并开始逐页精细重建（同一标签会话只触发一次） */
  autoEditable?: boolean
  /** 向导⑤确认设计：只允许「生成前 N 页预览 + 确认设计」；⑥生成页面才放开全量（真门禁的另一半） */
  stage?: 'design' | 'generate'
  /** 在⑤点「确认设计，进入生成页面」时回调（向导据此进第⑥步） */
  onDesignConfirmed?: () => void
}

export function ProjectWorkbench({
  projectId,
  stylePackId,
  defaultSize = '2K',
  pageNos,
  view = 'both',
  autoEditable = false,
  stage = 'generate',
  onDesignConfirmed,
}: ProjectWorkbenchProps) {
  const toast = useToast()
  /** 尺寸仍按向导传入的 defaultSize 生效；改尺寸的下拉随「生成页面」卡片一起移除，故只读 */
  const [size] = useState<string>(SIZES.includes(defaultSize as '2K') ? defaultSize : '2K')
  const [genInfo, setGenInfo] = useState<GenerationJob | null>(null)
  const [genJobId, setGenJobId] = useState<string | null>(null)
  const [recovering, setRecovering] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const imageReady = useImageReady()
  /** 未配置生图模型时点「生成」先弹引导；记住用户点的是哪类动作 */
  const [demoPrompt, setDemoPrompt] = useState<null | { kind: 'generate' | 'optimize'; pageNo?: number }>(null)
  const [downloading, setDownloading] = useState(false)
  const [genError, setGenError] = useState<ApiError | null>(null)
  /** 结果查看：当前页下标 / 缩略总览开关 / 放大灯箱（与 PPT 美化同一套共用件） */
  const [current, setCurrent] = useState(0)
  const [overview, setOverview] = useState(false)
  const [lightbox, setLightbox] = useState(false)

  const slidesState = useSlides(projectId, genJobId !== null)
  const slides: Slide[] = slidesState.data ?? []
  const restoredPage = useRef<string | null>(null)
  const pageKey = `deckforge:last-page:local-account:${projectId}`
  /** 选中某一页（并记住上次看的那页） */
  const selectPage = (index: number) => {
    const slide = slides[index]
    setCurrent(index)
    if (slide) localStorage.setItem(pageKey, slide.slide_id)
  }
  useEffect(() => {
    if (!slides.length || slidesState.loading || restoredPage.current === projectId) return
    restoredPage.current = projectId
    const saved = localStorage.getItem(pageKey)
    if (!saved) return
    const index = slides.findIndex(s => s.slide_id === saved)
    const valid = index >= 0 ? index : slides.findIndex(s => Boolean(s.image_url))
    if (valid >= 0) selectPage(valid)
  }, [slides, slidesState.loading, projectId])

  const genStream = useJobStream(genJobId, {
    onDone: () => {
      slidesState.reload()
      toast.info('任务处理结束，已刷新结果，请查看逐页状态')
    },
    onCancelled: () => { slidesState.reload(); toast.success('已取消，已完成的部分已保留') },
    onError: (m) => toast.error('生成失败', m),
  })

  useEffect(() => {
    let active=true
    const recover=async()=>{try{const res=await getProjectJobs(projectId);if(active){const latest=res.items.find(j=>j.kind==='generate');setGenJobId(latest?.id || null);slidesState.reload();setRecovering(false)}}catch{if(active){setRecovering(true);toast.error('恢复任务失败','重新聚焦或刷新以查询已有任务，暂不提交新任务')}}}
    setRecovering(true)
    void recover()
    window.addEventListener('focus',recover)
    return()=>{active=false;window.removeEventListener('focus',recover)}
  },[projectId])
  const running = recovering || submitting || genStream.status === 'running' || slides.some(s=>s.status==='running')

  /** 待生成页号：优先用传入的清单，否则用已解析出的页；再退回 1 页 */
  const targetPages = useMemo(() => {
    if (pageNos) return pageNos
    if (slides.length) return slides.filter(s=>s.keep).map((s) => s.page_no)
    return []
  }, [pageNos, slides])

  const generatedPages = slides.filter((s) => s.status === 'done' && !!s.image_url).map((s) => s.page_no)

  /** 结果查看：当前页与页状态（状态一律取后端真实字段，不额外造状态） */
  const currentIndex = Math.min(current, Math.max(0, slides.length - 1))
  const currentSlide = slides[currentIndex]
  const slideState = (slide: Slide) => {
    if (slide.status === 'failed') return { text: '失败', cls: 'status-danger' }
    if (slide.status === 'interrupted') return { text: '已中断', cls: 'status-warn' }
    if (slide.status === 'running' || slide.status === 'queued') return { text: '生成中', cls: 'status-warn' }
    if (slide.content_stale) return { text: '内容已更新', cls: 'status-warn' }
    if (slide.config_stale) return { text: '配置已变', cls: 'status-warn' }
    if (slide.status === 'done' && slide.image_url) return { text: '已完成', cls: 'status-success' }
    if (slide.image_url) return { text: '旧版本', cls: 'status-info' }
    return { text: '未生成', cls: 'status-info' }
  }
  const lightboxPages = slides.map((slide, index) => ({
    image: slide.image_url,
    label: <>P<span className="num">{slide.page_no}</span> · 第 <span className="num">{slide.page_no}</span> 页</>,
    counter: <>P<span className="num">{slide.page_no}</span> · 第 <span className="num">{index + 1}</span> / <span className="num">{slides.length}</span> 页</>,
  }))

  /** 被降级的页：生图调用失败 → 落到本地兜底渲染。没配 key 属于配置态，不算失败，不纳入重跑。 */
  const degradedPages = slides
    .filter((s) => s.provider === 'local_render' && !!s.error && !/未配置|确定性图表不可用/.test(s.error))
    .map((s) => s.page_no)

  async function retryDegraded() {
    if (!degradedPages.length) return
    setSubmitting(true)
    setGenError(null)
    try {
      const latest = await getSlides(projectId)
      const res = await generate(projectId, {
        style_pack_id: stylePackId ?? '',
        size,
        page_nos: degradedPages,
        content_revisions:Object.fromEntries(latest.map(s=>[s.slide_id,s.content_revision || 1])),
      })
      setGenInfo(res)
      setGenJobId(res.job_id)
      toast.info(`已提交重跑（${degradedPages.length} 页，之前被降级为本地渲染）`)
    } catch (e) {
      if (e instanceof SubmissionCancelled) { toast.info('已取消，未提交'); return }
      setGenError(e as ApiError)
      toast.error('提交重跑失败', (e as ApiError).detail)
    } finally {
      setSubmitting(false)
    }
  }

  async function startGenerate(pageOverride?: number[], allowDemo = false) {
    // 未配置生图模型：先引导去配置；用户明确选「先用本地演示」才走兜底（不静默降级）
    if (!allowDemo && imageReady === false) { setDemoPrompt({ kind: 'generate' }); return }
    const pagesToRun = pageOverride?.length ? pageOverride : targetPages
    setSubmitting(true)
    setGenError(null)
    try {
      const latest = await getSlides(projectId)
      const res = await generate(projectId, {
        style_pack_id: stylePackId ?? '',
        size,
        page_nos: pagesToRun,
        content_revisions:Object.fromEntries(latest.map(s=>[s.slide_id,s.content_revision || 1])),
      })
      setGenInfo(res)
      setGenJobId(res.job_id)
      if (!res.configured) {
        toast.warn('未配置生图模型，走本地兜底渲染', res.hint)
      } else {
        toast.info(`已提交生成任务（${pagesToRun.length} 页）`)
      }
    } catch (e) {
      if (e instanceof SubmissionCancelled) { toast.info('已取消，未提交'); return }
      setGenError(e as ApiError)
      toast.error('提交生成失败', (e as ApiError).detail)
    } finally {
      setSubmitting(false)
    }
  }

  async function optimize(pageNoValue: number, allowDemo = false) {
    if (running || submitting) return
    if (!allowDemo && imageReady === false) { setDemoPrompt({ kind: 'optimize', pageNo: pageNoValue }); return }
    setSubmitting(true)
    try {
      const latest=await getSlides(projectId)
      const res = await regenerateSlide(projectId, pageNoValue,Object.fromEntries(latest.map(s=>[s.slide_id,s.content_revision||1])))
      toast.info(`已提交第 ${pageNoValue} 页重生成`)
      setGenJobId(res.job_id)
      slidesState.reload()
    } catch (e) {
      if (e instanceof SubmissionCancelled) { toast.info('已取消，未提交'); return }
      toast.error('单页重生成失败', (e as ApiError).detail)
    } finally {setSubmitting(false)}
  }

  /**
   * 下载图片版 PPT：逐页整页图铺底。
   * 后端硬前置是「选中页都已人工核对」——所以还有未核对页时，先让用户确认已逐页看过，再标记并导出。
   */
  async function downloadImageDeck() {
    if (running || downloading || !generatedPages.length) return
    setDownloading(true)
    try {
      const pending = slides.filter((slide) => slide.keep && slide.review_required && slide.image_url)
      if (pending.length) {
        const confirmed = window.confirm(
          `还有 ${pending.length} 页尚未人工核对。\n\n请先逐页对照原文确认画面无误；点「确定」表示这些页面都已核对，系统会标记后导出图片版 PPT。`,
        )
        if (!confirmed) return
        await Promise.all(pending.map((slide) => reviewSlide(projectId, slide.slide_id, slide.image_url)))
        slidesState.reload()
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
      const error = e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 0)
      toast.error('导出图片版失败', error.detail)
    } finally {
      setDownloading(false)
    }
  }

  /* ---------- 结果查看：左页栏 + 单页大图 + 逐页就地操作（与 PPT 美化同一套共用件） ---------- */
  const viewer = slides.length > 0 ? (
    <div className="deck-split">
      <PageRail label="结果页面列表" current={currentIndex} onSelect={(index) => { selectPage(index); setOverview(false) }}
        items={slides.map((slide) => {
          const state = slideState(slide)
          return { key: slide.slide_id, label: `第 ${slide.page_no} 页`, thumb: slide.image_url, status: { text: state.text, cls: state.cls } }
        })} />
      <section className="deck-slide-shell" aria-label={currentSlide ? `第 ${currentSlide.page_no} 页生成结果` : '生成结果'}>
        {currentSlide && <>
          <div className="deck-slide-head">
            <span className="num font-semibold text-primary">P{currentSlide.page_no}</span>
            <span className="font-semibold">第 <span className="num">{currentSlide.page_no}</span> 页</span>
            <span className="flex-1" />
            <button type="button" className="btn btn-secondary rounded-full"
              disabled={running || !stylePackId || !targetPages.length || slides.some((s) => s.keep && !s.content_ready)}
              title={!stylePackId ? '未选择风格包：请先在向导里选择风格' : `一次性提交全部 ${targetPages.length} 个参与页生成（提交前会弹报价确认）`}
              onClick={() => void startGenerate()}>
              {submitting ? '提交中…' : '生成全部页面'}
            </button>
            <button type="button" className="btn btn-primary rounded-full" disabled={running || !currentSlide.content_ready}
              title={currentSlide.content_ready ? '只重新生成这一页，其它页与版本不受影响（会重新计费）' : '内容未就绪：先补齐并确认内容'}
              onClick={() => void optimize(currentSlide.page_no)}>
              {currentSlide.image_url ? '重新生成本页' : '生成本页'}
            </button>
            <button type="button" className="btn btn-secondary rounded-full" aria-pressed={overview} onClick={() => setOverview((value) => !value)}>{overview ? '返回单页' : '缩略总览'}</button>
          </div>

          {overview ? <OverviewGrid current={currentIndex} onSelect={(index) => { selectPage(index); setOverview(false) }} emptyText="未生成"
            items={slides.map((slide) => ({ key: slide.slide_id, label: `查看第 ${slide.page_no} 页结果`, image: slide.image_url }))} />
          : <>
            <div className="deck-media-frame">
              {currentSlide.image_url
                ? <button type="button" className="deck-media-open" title="点击放大查看" onClick={() => setLightbox(true)}><img src={currentSlide.image_url} alt={`第 ${currentSlide.page_no} 页生成结果`} /></button>
                : <p className="deck-slide-empty">这一页还没有结果{currentSlide.content_ready ? '，点右上「生成本页」提交这一页' : '；内容未就绪，请先补齐并确认内容'}。</p>}
            </div>
            <div className="deck-slide-meta">
              <span>来源：{currentSlide.provider === 'import' ? '原稿导入' : `${currentSlide.provider || '—'}/${currentSlide.model || '—'}`}</span>
              <span>尺寸：<span className="num">{currentSlide.size || '—'}</span></span>
              <span>耗时：<span className="num">{ms(currentSlide.latency_ms)}</span></span>
              <span>核对：{currentSlide.provider === 'import' ? '原稿导入，无需生成核对' : currentSlide.review_required ? '待核对' : '已人工核对'}</span>
            </div>
          </>}

          {currentSlide.keep && !['failed', 'interrupted', 'running'].includes(currentSlide.status) && (!currentSlide.content_ready || !currentSlide.image_url) && (
            <div className="panel-alt flex flex-wrap items-center gap-3">
              <Link className="btn btn-secondary" to={`/wizard/${projectId}/3`}>查看并确认内容 / 排除此页</Link>
              {currentSlide.content_ready && <button type="button" className="btn btn-secondary" disabled={running} onClick={() => void optimize(currentSlide.page_no)}>生成本页</button>}
            </div>)}

          {['failed', 'interrupted'].includes(currentSlide.status) && (
            <div className="panel-alt flex flex-wrap items-center gap-3">
              <span className="num">{currentSlide.status === 'interrupted' ? '已中断，未完成页未生成，可重新生成' : '生成失败'}：{currentSlide.error}；实际调用成本见用量账本，失败不承诺退款。</span>
              <button type="button" className="btn btn-secondary" disabled={running} onClick={() => void optimize(currentSlide.page_no)}>{currentSlide.status === 'interrupted' ? '重新生成此页' : '仅重试此页生成'}</button>
              <Link to={`/wizard/${projectId}/3`} className="btn btn-secondary">修改内容 / 排除此页</Link>
            </div>)}

          {(Boolean(currentSlide.versions?.length) || currentSlide.content_stale || currentSlide.config_stale) && (
            <div className="panel-alt">
              <p className="num m-0">已保留版本 {currentSlide.versions?.length ?? 0}</p>
              <div className="mt-2 flex flex-wrap gap-2">{currentSlide.versions?.map((v) => <button key={v.id} type="button" className="btn btn-secondary num" disabled={running || (v.current && currentSlide.status === 'done') || !v.image_url} title={v.created_at} onClick={async () => { try { await restoreSlideVersion(projectId, currentSlide.slide_id, v.id); slidesState.reload(); toast.success('已回退，所有版本仍保留') } catch (e) { toast.error('回退失败', (e as ApiError).detail) } }}>版本 {v.number}{v.current ? `（当前）${currentSlide.status === 'done' ? '' : ' · 恢复此结果'}` : !v.image_url ? ' · 资产不可用' : ' · 回退'}</button>)}</div>
              {currentSlide.config_stale && <p className="mb-0 mt-2">此页结果与当前风格 / 尺寸不一致；重新生成需显式提交。</p>}
              {currentSlide.content_stale && <div className="mt-2 flex flex-wrap items-center gap-2"><span>基于旧内容，当前保存内容已更新；请先在内容步骤确认新内容。</span><Link className="btn btn-secondary" to={`/wizard/${projectId}/3`}>查看并确认新内容</Link><button type="button" className="btn btn-secondary" disabled={running} onClick={() => void optimize(currentSlide.page_no)}>按新内容重新生成</button></div>}
            </div>)}

        </>}
      </section>
    </div>
  ) : null

  const resultView = slidesState.loading && !slides.length
    ? <Loading rows={2} label="加载页面清单…" />
    : slidesState.error && !slides.length
      ? <ErrorState error={slidesState.error} onRetry={slidesState.reload} title="页面清单加载失败" />
      : slides.length === 0
        ? <EmptyState title="还没有生成任何页面" desc="点下方「生成参与页」提交任务；无生图 key 时会走本地兜底渲染（费用 0 元），一样能导出 PPTX。" />
        : <>
          {slidesState.error && <Notice kind="warn">连接中断，正在恢复状态；保留已确认的页面结果。</Notice>}
          {viewer}
        </>

  /* ---------------- ⑤ 生成面板 ---------------- */
  /** 设计阶段（向导⑤）：先跑前 3 页预览，确认设计后才放行全量生成 */
  const designStage = stage === 'design'
  const previewPages = targetPages.slice(0, Math.min(3, targetPages.length))
  const previewReady = generatedPages.length > 0

  /** 导出图片版 PPT 的可用性与原因（缺页 / 生成中都不能导出；逐页核对在点击时统一确认） */
  const missingImages = slides.filter((slide) => slide.keep && !slide.image_url)
  const canDownload = !running && !downloading && generatedPages.length > 0 && missingImages.length === 0
  const downloadTitle = running
    ? '生成中：等任务结束再导出'
    : missingImages.length
      ? `还有 ${missingImages.length} 页未生成完成，暂不能导出`
      : '导出图片版 PPTX（整页图铺底；未核对的页会先提示你确认）'

  const generatePanel = (
    <div className="flex flex-col gap-4">
      {stage === 'design' && running && <Notice kind="info">后台任务运行中，可查看原稿、已完成结果及项目列表；暂不能修改任务页面或重复提交。</Notice>}
      {genError && <ErrorState error={genError} onRetry={startGenerate} title="提交生成失败" />}

      {genInfo && !genInfo.configured && (
        <NotConfiguredBanner
          reason={genInfo.reason}
          hint={genInfo.hint}
          fellback={genInfo.fellback}
          action={
            <Link to="/settings" className="btn btn-secondary h-8! text-body-sm">
              去设置填写
            </Link>
          }
        />
      )}

      {genStream.status === 'interrupted' && <Notice kind="warn">作业已中断：{genStream.message || '未返回具体中断原因，请刷新查询任务详情'}。已完成结果和历史版本保留；可通过下方逐页入口重新生成。</Notice>}
      {genStream.status === 'cancelled' && <p role="status">已取消，已完成的部分已保留</p>}

      {resultView}
      {slides.length > 0 && currentSlide && <ActionBar>
        <PagerArrow dir="prev" disabled={currentIndex === 0} onClick={() => selectPage(currentIndex - 1)} />
        <span className="num">{currentSlide.page_no} / {slides.length}</span>
        <PagerArrow dir="next" disabled={currentIndex >= slides.length - 1} onClick={() => selectPage(currentIndex + 1)} />
        <span className="text-ink-sub">{running
          ? <><span className="beautify-live-dot" aria-hidden="true" />正在生成 <span className="num">{generatedPages.length}</span> / <span className="num">{slides.length}</span> 页</>
          : <>已完成 <span className="num">{generatedPages.length}</span> / <span className="num">{slides.length}</span> 页</>}</span>
        {degradedPages.length > 0 && <button type="button" className="btn btn-secondary rounded-full" disabled={running} onClick={retryDegraded} title={`重新调用生图接口重跑第 ${degradedPages.join('、')} 页（会重新计费）`}>{submitting ? '提交中…' : `重跑降级页（${degradedPages.length}）`}</button>}
        {designStage ? (
          previewReady
            ? <button type="button" className="btn btn-primary rounded-full" disabled={running} title="设计已确认，进入第⑥步生成全部页面" onClick={() => onDesignConfirmed?.()}>{running ? '生成中…' : '确认设计，进入生成页面 ›'}</button>
            : <button type="button" className="btn btn-primary rounded-full" disabled={running || !stylePackId || !previewPages.length || slides.some(s => s.keep && !s.content_ready)} title={!stylePackId ? '未选择风格包：请先在向导里选择风格' : `先跑前 ${previewPages.length} 页预览，确认后再生成全部页面`} onClick={() => void startGenerate(previewPages)}>{submitting ? '提交中…' : `生成前 ${previewPages.length} 页预览`}</button>
        ) : (
          <>
            <button type="button" className={cn('btn rounded-full', generatedPages.length > 0 ? 'btn-secondary' : 'btn-primary')} disabled={running || !stylePackId || !targetPages.length || slides.some(s => s.keep && !s.content_ready)} title={!stylePackId ? '未选择风格包：请先在向导里选择风格' : '提交 POST /api/projects/{id}/generate'} onClick={() => void startGenerate()}>{submitting ? '提交中…' : genJobId ? `重新生成参与页（${targetPages.length} 页）` : `生成参与页（${targetPages.length} 页）`}</button>
            {generatedPages.length > 0 && (
              <>
                <Link className="btn btn-secondary rounded-full" to={`/editable/${projectId}?step=2`} title="进入「图片转可编辑」：先勾选要转换的页面，再逐页精细重建（每页约 13 分钟，可随时停止）">转可编辑 PPT</Link>
                <button type="button" className="btn btn-primary rounded-full" disabled={!canDownload} title={downloadTitle} onClick={() => void downloadImageDeck()}>{downloading ? '正在导出…' : '下载图片集 PPT'}</button>
              </>
            )}
          </>
        )}
      </ActionBar>}


    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      {/* 「按图片版重建」已独立成三步流程（#/editable）：这里不再提供页签，默认就是生成结果 */}
      {view !== 'editable' ? generatePanel : null}
      {view === 'editable' ? <EditableWorkbench projectId={projectId} autoStart={autoEditable} /> : null}



      {lightbox && currentSlide?.image_url && (
        <PageLightbox pages={lightboxPages} index={currentIndex} onIndex={selectPage} onClose={() => setLightbox(false)}
          ariaLabel={`第 ${currentSlide.page_no} 页放大预览`} emptyText="这一页还没有生成结果" />
      )}

      <LocalDemoDialog
        open={!!demoPrompt}
        actionLabel={demoPrompt?.kind === 'optimize' ? '重新生成这一页' : '生成页面'}
        onCancel={() => setDemoPrompt(null)}
        onDemo={() => {
          const pending = demoPrompt
          setDemoPrompt(null)
          if (pending?.kind === 'optimize' && pending.pageNo) void optimize(pending.pageNo, true)
          else void startGenerate(undefined, true)
        }}
      />
    </div>
  )
}
