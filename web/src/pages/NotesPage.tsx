/**
 * 备注页（#/notes）：上传已有 .pptx → 生成演讲者备注 → 写回备注栏导出。
 *
 * 与「生成」流程完全独立：本模块不改动幻灯片的任何内容与版式，只往备注栏写字。
 * 上传是免费的：只做解析（页数/文字/图片数），花钱的画面识别要你点一下才开始。
 */
import { useMemo, useRef, useState } from 'react'
import { ApiError, listNotes, uploadNotesPptx, deleteNotesJob } from '../api'
import { EmptyState, ErrorState, Loading } from '../components/StateBlock'
import { useAsync } from '../hooks/useAsync'
import { cn, fmtTime, notesStatusLabel } from '../lib/format'
import { Link, navigate } from '../router'
import type { NotesJob, NotesJobDetail } from '../types'

export function NotesPage() {
  const jobs = useAsync(listNotes, [])
  const [busy, setBusy] = useState(false)
  const [uploaded, setUploaded] = useState<NotesJobDetail | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const items = useMemo(
    () => [...(jobs.data?.items ?? [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    [jobs.data],
  )

  async function onFile(file: File | undefined) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.pptx')) {
      setError(new ApiError('只支持 .pptx 文件。老版本 .ppt 请先在 PowerPoint 里「另存为 .pptx」再上传。', 400))
      return
    }
    setBusy(true)
    setError(null)
    setUploaded(null)
    try {
      const detail = await uploadNotesPptx(file)
      setUploaded(detail)
      jobs.reload()
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 0))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="m-0 text-h1 font-semibold">PPT 备注</h1>
        <p className="m-0 mt-1 text-ink-sub">
          上传一份已经做好的 PPT，按每一页的内容自动写演讲者备注，再导出
          —— 页面内容、版式、母版一律不动，只写备注栏。
        </p>
      </div>

      {/* ① 上传 */}
      <div className="card">
        <div className="card-title">上传 PPT</div>
        <div
          className={cn(
            'df-dropzone flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-6 py-8',
            over && 'is-over',
          )}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            void onFile(e.dataTransfer.files?.[0])
          }}
        >
          <div className="text-body-md text-ink">把 .pptx 拖到这里</div>
          <div className="text-caption text-ink-sub">或</div>
          <button
            type="button"
            className={cn('btn btn-primary', busy && 'is-disabled')}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? '正在解析…' : '选择文件'}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".pptx"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>

        {error && <div className="mt-3"><ErrorState error={error} title="上传失败" compact /></div>}

        {uploaded && (
          <div className="panel-alt mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="status status-success">解析完成</span>
            <span className="text-body-sm">
              共 <span className="num">{uploaded.pages}</span> 页
            </span>
            <span className="text-body-sm">
              图片页（文字极少）<span className="num">{uploaded.image_pages}</span> 页
            </span>
            <span className="text-body-sm">
              原文件已有备注 <span className="num">{uploaded.notes_existing}</span> 页（导出时默认保留）
            </span>
            <span className="flex-1" />
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/notes/${uploaded.id}`)}>
              进入工作台 →
            </button>
          </div>
        )}
      </div>

      {/* ② 历史任务 */}
      <div className="card">
        <div className="card-title">历史任务</div>
        {jobs.loading && <Loading rows={3} label="加载备注任务…" />}
        {jobs.error && <ErrorState error={jobs.error} onRetry={jobs.reload} title="加载失败" compact />}
        {!jobs.loading && !jobs.error && items.length === 0 && (
          <EmptyState title="还没有备注任务" desc="上面拖一份 .pptx 进来就能开始。整个流程随时可以中断，已完成的页不会重跑。" />
        )}
        {items.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {items.map((job) => (
              <NoteRow key={job.id} job={job} onDeleted={() => jobs.reload()} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function NoteRow({ job, onDeleted }: { job: NotesJob; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const done = job.status === 'done'
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
      <span className={cn('status', done ? 'status-success' : job.status === 'failed' ? 'status-danger' : 'status-info')}>
        {notesStatusLabel(job.status)}
      </span>
      <Link to={`/notes/${job.id}`} className="text-body-md text-ink no-underline hover:underline">
        {job.title || job.source_name}
      </Link>
      <span className="text-caption text-ink-sub">
        <span className="num">{job.pages}</span> 页 · 图片页 <span className="num">{job.image_pages}</span>
      </span>
      <span className="flex-1" />
      <span className="text-caption text-ink-sub"><span className="num">{fmtTime(job.created_at)}</span></span>
      <Link
        to={`/notes/${job.id}`}
        className="btn btn-secondary text-body-sm"
        title={job.status === 'done' ? '查看这个任务的逐页备注' : '打开这个任务，接着上次的进度继续'}
      >
        查看
      </Link>
      <button
        type="button"
        className={cn('btn btn-ghost text-body-sm', busy && 'is-disabled')}
        disabled={busy}
        onClick={async () => {
          if (!window.confirm(`删除「${job.title || job.source_name}」这个备注任务？已生成的备注会一起删除。`)) return
          setBusy(true)
          try {
            await deleteNotesJob(job.id)
            onDeleted()
          } finally {
            setBusy(false)
          }
        }}
      >
        删除
      </button>
    </li>
  )
}
