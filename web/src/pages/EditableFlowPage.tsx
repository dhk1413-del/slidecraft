/** 图片转可编辑：独立 3 步（上传内容 → 页面确认 → 转换结果），不再套用生成向导的 5/6 步。 */
import { useCallback, useEffect, useState } from 'react'
import { getProject, getSlides, importPages, type ApiError } from '../api'
import { Dropzone } from '../components/Dropzone'
import { EditableWorkbench } from '../components/EditableWorkbench'
import { ActionBar, FlowSteps, type FlowStep } from '../components/FlowKit'
import { EmptyState, ErrorState, Loading, Notice } from '../components/StateBlock'
import { SlideThumb, ThumbGrid } from '../components/ThumbGrid'
import { useToast } from '../components/Toast'
import { cn, MAX_UPLOAD_BYTES, uploadTooLarge } from '../lib/format'
import { Link, readQuery } from '../router'
import type { Project, Slide } from '../types'

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
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorObject, setErrorObject] = useState<ApiError | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) { setLoading(false); return }
    setLoading(true); setError(null); setErrorObject(null)
    try {
      const [nextProject, nextSlides] = await Promise.all([getProject(projectId), getSlides(projectId)])
      setProject(nextProject)
      setSlides(nextSlides.filter(slide => slide.image_url))
      setStep((current): 1 | 2 | 3 => {
        const hasImages = nextSlides.some(slide => slide.image_url)
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
              <h2 className="card-title m-0! text-h3">页面确认</h2>
              <span className="num text-ink-sub">共 {slides.length} 页</span>
              <span className="flex-1" />
              <Link className="link text-body-sm" to={`/projects/${projectId}`}>查看项目</Link>
            </div>
            <p className="m-0 text-body-sm text-ink-sub">
              请核对导入页面的顺序与内容；确认后将进入「转换结果」页，按页精细重建为可编辑对象（文字/图片/图形/背景分别拆分）。
            </p>
            <ThumbGrid>
              {slides.map(slide => (
                <SlideThumb key={slide.slide_id ?? slide.page_no} pageNoValue={slide.page_no}
                  title={slide.title || `第 ${slide.page_no} 页`} slide={slide} selectable={false} />
              ))}
            </ThumbGrid>
            {error && <div className="error-box text-body-sm" role="alert">{error}</div>}
          </section>
          <ActionBar>
            <button type="button" className="btn btn-secondary rounded-full" onClick={() => setStep(1)}>返回上传内容</button>
            <button type="button" className="btn btn-primary rounded-full" disabled={!slides.length} onClick={() => { setConfirmed(true); setStep(3) }}>确认页面，进入转换</button>
          </ActionBar>
        </>
      )}

      {step === 3 && <EditableWorkbench projectId={projectId} autoStart={false} />}

      <p className={cn('m-0 text-caption text-ink-sub', step !== 1 && 'hidden')}>
        数据来源：GET /api/projects/{projectId}/slides
      </p>
    </div>
  )
}

export default EditableFlowPage
