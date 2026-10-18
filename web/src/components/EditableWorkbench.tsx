/**
 * 「图片转可编辑」面板 —— 挂在项目工作台的「按图片版重建」页签里（不再单开页面）。
 *
 * 唯一引擎：第三方 skill `image-to-editable-ppt`（逐页由本机 agent 精细重建，产物自带 validation 校验）。
 * 实测约 13 分钟/页；产物**仅含所转页面**。
 * 不再有「内置引擎 / 本地渲染」那条路（2026-09-21 按要求下线）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, SubmissionCancelled, cancelEditable, editableEngines, editpptStatus, exportDeck, toEditable } from '../api'
import { useJobStream } from '../hooks/useJobStream'
import { useSlides } from '../hooks/useSlides'
import { bytes, cn, pageNo } from '../lib/format'
import type { EditableEngine, EditableResponse, EditpptStatus, ExportResponse, Slide } from '../types'
import { ActionBar, PageLightbox } from './FlowKit'
import { fmtSec } from './ProgressPanel'
import { EmptyState, ErrorState, Loading, Notice } from './StateBlock'
import { SlideThumb, ThumbGrid } from './ThumbGrid'
import { useToast } from './Toast'

/** 现场里「这页已经转好了」的状态值（editppt 状态机的记录口径） */
const CONVERTED = ['recorded', 'accepted', 'complete']

export function EditableWorkbench({ projectId, autoStart = false }: { projectId: string; autoStart?: boolean }) {
  const toast = useToast()
  const [engine, setEngine] = useState<EditableEngine | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [editInfo, setEditInfo] = useState<EditableResponse | null>(null)
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
        setEditInfo(res)
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

  // 一键流：上传导入后直达本页，自动开始（同一标签会话只触发一次）
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

  const toggle = (n: number) =>
    setSelected((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]))
  const selectedSet = new Set(selected)
  // 每页耗时以引擎实测值为准（后端 seconds_per_page，本机实测 786 秒/页）；探测未回来时用 13 分钟兜底
  const pageMinutes = engine?.seconds_per_page ? engine.seconds_per_page / 60 : 13
  const estLabel = `${selected.length} 页 ≈ ${Math.max(1, Math.round(selected.length * pageMinutes))} 分钟`

  const grid = (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="card-title m-0! text-h3">原页清单</h2>
        <span className="num text-ink-sub">
          共 {readySlides.length} 页 · 已转 {convertedPages.length} 页
        </span>
        {convertedPages.length > 0 && (
          <span className="status status-success num">已转 P{convertedPages.map((n) => pageNo(n)).join('、P')}</span>
        )}
        <span className="flex-1" />
      </div>

      {slidesState.loading && !slides.length ? (
        <Loading rows={2} label="加载原页…" />
      ) : slidesState.error ? (
        <ErrorState error={slidesState.error} onRetry={slidesState.reload} title="原页加载失败" />
      ) : !readySlides.length ? (
        <EmptyState
          title="还没有可转的原页"
          desc="在首页「图片转可编辑」上传 PDF / 图片 / pptx，或先在「生成结果」里出图片版，再回到本页签重建。"
          actionLabel="回到首页上传"
          to="/?mode=editable"
        />
      ) : (
        <>
          <ThumbGrid>
            {readySlides.map((s, index) => (
              <SlideThumb
                key={s.slide_id}
                pageNoValue={s.page_no}
                title={s.title}
                slide={s}
                progress={stream.byPage[s.page_no]}
                selected={selectedSet.has(s.page_no)}
                selectable
                onToggle={() => toggle(s.page_no)}
                onOpen={() => setLightboxIndex(index)}
              />
            ))}
          </ThumbGrid>
        </>
      )}
    </div>
  )

  const actionBar = (
    <ActionBar>
      <span className="tag num">已勾选 {selected.length} 页</span>
      <span className="num text-ink-sub">{estLabel}</span>
      <button
        type="button"
        className="btn btn-secondary rounded-full"
        disabled={!readyPageNos.length}
        onClick={() => setSelected(readyPageNos)}
      >
        全选
      </button>
      <button
        type="button"
        className="btn btn-secondary rounded-full"
        disabled={!pendingPages.length}
        onClick={() => setSelected(pendingPages)}
        title="只勾「还没转成可编辑」的页"
      >
        只选未转页（{pendingPages.length}）
      </button>
      <button
        type="button"
        className="btn btn-secondary rounded-full"
        disabled={!selected.length}
        onClick={() => setSelected([])}
      >
        清空
      </button>
      {hiRunning && <span className="status status-info">转换进行中 · 当前页约 13 分钟</span>}
      {editInfo && (
        <span className="num text-ink-sub">
          本次 {editInfo.estimate.pages} 页 · 预计 ~{fmtSec(editInfo.estimate.seconds * 1000)}
        </span>
      )}
      <span className="flex-1" />
      {hiRunning && (
        <button
          type="button"
          className="btn btn-secondary rounded-full"
          onClick={() =>
            cancelEditable(projectId)
              .then((r) => {
                toast.info('已请求停止', r.message)
                setHiRunning(false)
                reloadHi()
              })
              .catch((e: ApiError) => toast.error('停止失败', e.detail))
          }
        >
          停止
        </button>
      )}

      {!hiRunning && hiStatus?.resumable && (
        <button
          type="button"
          className="btn btn-secondary rounded-full"
          onClick={() => start(true)}
          title="复用现场：已通过校验的页会跳过，不重复重建"
        >
          继续转换（已完成 {hiStatus.recorded}/{hiStatus.total} 页）
        </button>
      )}

      <button
        type="button"
        className="btn btn-primary rounded-full px-6"
        disabled={submitting || hiRunning || !selected.length || (engine ? !engine.ok : false)}
        onClick={() => start()}
        title={
          !selected.length
            ? '先勾选要转的页'
            : engine && !engine.ok
              ? `引擎不可用：${engine.reason ?? ''}`
              : 'POST /api/projects/{id}/editable（engine=editppt）'
        }
      >
        {submitting ? '提交中…' : `开始精细重建（${selected.length} 页）`}
      </button>
    </ActionBar>
  )

  const artifactCard = (
    <div className="card">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="card-title m-0! text-h3">导出可编辑 PPTX</h2>
        {artifact ? (
          <span className="status status-success num">
            {artifact.pages} 页 · {artifact.editable_pages.map((n) => `P${pageNo(n)}`).join('、')}
          </span>
        ) : (
          <span className="status status-info">还没有产物</span>
        )}
      </div>
      <p className="m-0 text-body-sm text-ink-sub">
        产物由第三方 skill 生成，**仅含已转换的页面**；每页都通过了自带 <span className="num">validation</span> 校验。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a
          className={cn('btn', artifact ? 'btn-primary' : 'btn-secondary', !artifact && 'pointer-events-none opacity-50')}
          href={artifact?.file}
          download
          title={artifact ? artifact.file : '转换完成后出现'}
        >
          下载可编辑 PPTX{artifact ? `（${artifact.pages} 页）` : ''}
        </a>
        {artifact?.size_bytes ? <span className="num text-ink-sub">{bytes(artifact.size_bytes)}</span> : null}
        {artifact?.created_at ? <span className="num text-caption text-ink-muted">{artifact.created_at}</span> : null}
      </div>
      {!convertedPages.length && (
        <div className="mt-3">
          <Notice kind="info">还没有转换过任何页面；勾选页面并点「开始精细重建」后，产物会出现在这里。</Notice>
        </div>
      )}
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      {engine && !engine.ok && (
        <div className="panel-alt text-body-sm" role="alert">精细重建引擎不可用：{engine.reason ?? '未知原因'}</div>
      )}
      {editError && <ErrorState error={editError} onRetry={() => start()} title="提交转换失败" />}
      {grid}
      {artifactCard}
      <p className="m-0 text-caption text-ink-sub">
        数据来源：GET /api/projects/{projectId}/slides · 现场 GET /api/projects/{projectId}/editppt
      </p>
      {hiStatus?.note && <p className="mt-2 mb-0 text-body-sm text-ink-sub">{hiStatus.note}</p>}
      {actionBar}
      {lightboxIndex !== null && readySlides.length > 0 && <PageLightbox
        pages={readySlides.map((slide, index) => ({
          image: slide.image_url,
          label: <>P<span className="num">{slide.page_no}</span> · 第 <span className="num">{slide.page_no}</span> 页{slide.title ? ` · ${slide.title}` : ''}</>,
          counter: <>P<span className="num">{slide.page_no}</span> · 第 <span className="num">{index + 1}</span> / <span className="num">{readySlides.length}</span> 页</>,
        }))}
        index={lightboxIndex}
        onIndex={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
        ariaLabel={`第 ${readySlides[lightboxIndex]?.page_no ?? ''} 页放大预览`}
        emptyText="加载原页…"
      />}
    </div>
  )
}
