/**
 * 首页：一个切换控件 + 三种生成方式。
 *
 *   ① 文档导入生成 —— 可用：选好文档 → 交给 6 步生成向导（不复制第二套上传/生成逻辑）
 *   ② 图片转可编辑 —— 内嵌上传：渲染出原页后进项目工作台「按图片版重建」页签，
 *                     逐页精细重建（只走第三方 skill，不做本地渲染兜底）
 *   ③ PPT美化     —— 上传 → 前 3 页逐页生图预览 → 确认后生成全部页面
 *
 * 文档与图片导入进入项目工作台；PPT 美化在首页预览与下载。地址可直达： `#/?mode=topic|editable|reskin`
 * 诚实边界：未实现的模式不允许按钮可点却什么都不做，也不假装已生成任何东西。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { createProject, importPages, listStylePacks, type ApiError } from '../api'
import { IconFolder, IconPalette, IconSparkles } from '../components/Icons'
import { Dropzone } from '../components/Dropzone'
import { StylePackCard } from '../components/StylePackCard'
import { BeautifyPanel } from '../components/BeautifyPanel'
import { useAsync } from '../hooks/useAsync'
import { cn } from '../lib/format'
import { sourceTypeOf } from '../lib/source'
import { setPendingFile } from '../pendingFile'
import { UPLOAD_SIZE_HINT, uploadTooLarge, MAX_UPLOAD_BYTES } from '../lib/format'
import type { StylePack } from '../types'
import { navigate } from '../router'

type Mode = 'topic' | 'editable' | 'reskin'

// ③ PPT美化：上传 → 逐页生图预览 → 确认后逐页精细重建可编辑版。
const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'topic', label: '文档导入生成' },
  { id: 'editable', label: '图片转可编辑' },
  { id: 'reskin', label: 'PPT美化' },
]

/** 左侧导轨的图标：三种方式各一个，避免用了同一枚 icon 看不出区别。 */
function ModeIcon({ id }: { id: Mode }) {
  const Icon = id === 'topic' ? IconFolder : id === 'editable' ? IconSparkles : IconPalette
  return <Icon className="h-5 w-5" />
}

function readMode(): Mode {
  const m = /[?&]mode=([^&]+)/.exec(window.location.hash)?.[1]
  return m === 'editable' || m === 'reskin' ? m : 'topic'
}

/* 设计师原创设计风格：独立区块（与上面的上传功能分开），分类筛选 + 4 列卡片 */
function StyleGallery({ packs, loading, picked, onPick, mode }: {
  packs: StylePack[]; loading: boolean; picked: string | null; onPick: (id: string | null) => void; mode: Mode
}) {
  const [category, setCategory] = useState('')
  const [previewing, setPreviewing] = useState<string | null>(null)
  const categories = [...new Set(packs.map((pack) => pack.category).filter(Boolean))]
  const shown = category ? packs.filter((pack) => pack.category === category) : packs
  const pickedName = packs.find((pack) => pack.id === picked)?.name
  return (
    <section id="style-gallery" className="band flex scroll-mt-20 flex-col gap-4" aria-label="设计师原创设计风格">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 className="m-0 text-h2 font-semibold">设计师原创设计风格</h2>
          <p className="m-0 mt-1 text-body-sm text-ink-sub">
            不同风格包会影响页面视觉风格、配图倾向、布局规范等。
            {mode === 'editable'
              ? ' 图片转可编辑是按已有页面重建，不套用风格模板；这里可以浏览并点「查看」看大图。'
              : pickedName
                ? <> 已选 <span className="font-semibold text-ink">{pickedName}</span>，开始{ mode === 'reskin' ? '美化' : '生成' }时自动带上（第④步仍可更换）。</>
                : ` 挑一个模板，开始${ mode === 'reskin' ? '美化' : '生成' }时自动带上（第④步仍可更换）。`}
          </p>
        </div>
        <span className="flex-1" />
        <button type="button" className="link" onClick={() => navigate('/styles')}>全部风格 →</button>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="风格分类">
        <button type="button" role="tab" aria-selected={!category} className={cn('style-chip', !category && 'is-active')} onClick={() => setCategory('')}>全部</button>
        {categories.map((item) => (
          <button key={item} type="button" role="tab" aria-selected={category === item}
                  className={cn('style-chip', category === item && 'is-active')}
                  onClick={() => setCategory((value) => (value === item ? '' : item))}>{item}</button>
        ))}
      </div>

      {loading && <p className="m-0 text-body-sm text-ink-sub">正在读取风格库…</p>}
      {!loading && !shown.length && <p className="m-0 text-body-sm text-ink-sub">这个分类下还没有可用模板。</p>}
      {shown.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" role="listbox" aria-label="风格库模板">
          {shown.map((pack) => (
            <div
              key={pack.id}
              className="cursor-pointer"
              /* 点卡片空白处即选中；点到内部按钮（预览/查看/选择此风格）时不抢行为 */
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('button')) return
                onPick(picked === pack.id ? null : pack.id)
              }}
            >
              <StylePackCard
                pack={pack}
                /* 图片转可编辑不套用风格：即使别处选过，这里也不显示「已选」 */
                selected={mode === 'editable' ? false : picked === pack.id}
                previewing={previewing === pack.id}
                onSelect={() => onPick(picked === pack.id ? null : pack.id)}
                onPreview={() => setPreviewing((value) => (value === pack.id ? null : pack.id))}
                onPreviewClose={() => setPreviewing((value) => (value === pack.id ? null : value))}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function HomePage() {
  const [mode, setMode] = useState<Mode>(readMode)
  const [beautifyStep, setBeautifyStep] = useState(1)
  const beautifyWorkbench = mode === 'reskin' && beautifyStep > 1

  // 地址栏与切换控件保持同步（支持前进/后退与直链）
  useEffect(() => {
    const sync = () => setMode(readMode())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const pick = (id: Mode) => {
    setMode(id)
    const next = `#/?mode=${id}`
    if (window.location.hash !== next) window.location.hash = next
  }

  const [pickedPack, setPickedPack] = useState<string | null>(null)
  const packs = useAsync(listStylePacks, [])
  const packOptions = packs.data?.items ?? []

  return (
    <div className="flex flex-col gap-4">
      {/* 首页大标题（参考版式）：两行居中，下面接上传卡 */}
      {!beautifyWorkbench && (
        <header className="home-hero">
          <h1 className="m-0">专业PPT设计机构出品<br />顶尖图片生成AI模型加持</h1>
        </header>
      )}
      <section id="generation-modes" className={cn('scroll-mt-20', !beautifyWorkbench && 'gen-shell')}>
        <div className={cn('grid gap-5', !beautifyWorkbench && 'md:grid-cols-[168px_1fr]')}>
          {!beautifyWorkbench && <div className="mode-rail" role="tablist" aria-label="生成方式" aria-orientation="vertical">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={mode === m.id}
                onClick={() => pick(m.id)}
              >
                <span className="mode-rail-icon" aria-hidden="true"><ModeIcon id={m.id} /></span>
                <span>{m.label}</span>
              </button>
            ))}
          </div>}

          {/* 功能框：固定高度，三个模式互相切换时尺寸不跳动；内容更高时在框内滚动 */}
          <div className={cn('mode-panel min-w-0', beautifyWorkbench && 'is-workbench')}>
            {mode === 'topic' && <TopicPanel pickedPack={pickedPack} pickedName={packOptions.find((p) => p.id === pickedPack)?.name} />}
            {mode === 'editable' && <EditablePanel />}
            {mode === 'reskin' && <BeautifyPanel packs={packOptions} loadingPacks={packs.loading} onStepChange={setBeautifyStep} initialStylePackId={pickedPack} />}
          </div>
        </div>
      </section>

      {/* 风格库模板：独立区块，与上面的上传功能分开；三种模式都显示 */}
      {!beautifyWorkbench && (
        <StyleGallery
          packs={packOptions}
          loading={packs.loading}
          picked={pickedPack}
          mode={mode}
          onPick={(id) => {
            if (mode === 'editable') return   /* 图片转可编辑不套用风格：不记选中，避免假装生效 */
            setPickedPack(id)
          }}
        />
      )}
    </div>
  )
}

/* ───────────────────────── 共用件：拖拽区 / 已选文件 ───────────────────────── */

function PickedFile({ file, onClear }: { file: File; onClear?: () => void }) {
  return (
    <div className="panel-alt flex flex-wrap items-center gap-2">
      <span className={cn('status', onClear ? 'status-success' : 'status-info')}>已选择</span>
      <span className="truncate">{file.name}</span>
      <span className="num text-caption text-ink-sub">{(file.size / 1024).toFixed(0)} KB</span>
      {onClear && (
        <>
          <span className="flex-1" />
          <button type="button" className="link text-caption" onClick={onClear}>
            清除
          </button>
        </>
      )}
    </div>
  )
}

function PanelHead({ lead }: { lead: ReactNode }) {
  return <p className="m-0 text-ink-sub">{lead}</p>
}

/* ─────────────────────── ① 文档导入生成（可用） ─────────────────────── */

const DOC_ACCEPT = '.md,.markdown,.txt,.docx,.pdf,.pptx'

function TopicPanel({ pickedPack, pickedName }: { pickedPack: string | null; pickedName?: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = (f: File | null) => {
    if (!f) return
    if (!/\.(md|markdown|txt|docx|pdf|pptx)$/i.test(f.name))
      return setError(`不支持的格式：${f.name}；支持 TXT · MD · DOCX · PDF · PPTX`)
    if (f.size > MAX_UPLOAD_BYTES) return setError(uploadTooLarge(f))
    setError(null)
    setFile(f)
  }

  return (
    <div className="gen-panel">
      <div className="gen-panel-head">
        <PanelHead
          lead={
            <>
              <span className="font-semibold text-ink">适合已有完整文档</span>
              ，需要 AI 规划结构并生成整套 PPT。
              <span className="text-ink-muted">（页数与风格在下一步确定）</span>
            </>
          }
        />
        <button
          type="button"
          className="gen-panel-style btn btn-secondary h-8! text-body-sm"
          title="在下方「设计师原创设计风格」里挑选模板"
          onClick={() => document.querySelector('#style-gallery')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          ✦ 设计风格 · {pickedName ? `已选 ${pickedName}` : '可选'}
        </button>
      </div>

      <div className="gen-panel-drop">
        <Dropzone
          icon
          head="拖入文档，开始生成 PPT"
          hint="点击此处选择文件"
          formats={`TXT · MD · DOCX · PDF · PPTX · ${UPLOAD_SIZE_HINT}`}
          accept={DOC_ACCEPT}
          onPick={(picked) => choose(picked[0] ?? null)}
        />
      </div>

      {error && <div className="error-box text-body-sm">{error}</div>}
      {file && <PickedFile file={file} onClear={() => setFile(null)} />}

      <div className="gen-panel-foot">
        <span className="flex-1" />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!file}
          onClick={() => {
            // 交给既有的 6 步向导：上传 → ② 大纲/页清单 → ③ 梳理 → ④ 风格 → ⑤ 生成
            if (!file) return
            setPendingFile(file)
            // 带上首页选中的风格模板（向导第④步会预选，仍可改）
            navigate(pickedPack ? `/wizard?style=${encodeURIComponent(pickedPack)}` : '/wizard')
          }}
        >
          开始生成大纲
        </button>
      </div>
    </div>
  )
}

/* ───────────── ② 图片转可编辑（PDF / 图片 / pptx → 逐页精细重建）───────────── */

function EditablePanel() {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const totalKb = Math.round(files.reduce((sum, f) => sum + f.size, 0) / 1024)

  const start = async () => {
    if (!files.length || busy) return
    setBusy(true)
    setError(null)
    try {
      const { id } = await createProject({
        title: files[0].name.replace(/\.[^.]+$/, '') || '图片转可编辑',
        source_type: sourceTypeOf(files[0].name),
        intake_mode: 'doc',
      })
      // 逐页渲染 + 登记成 slides → 进入图片转可编辑的 3 步流程（上传 → 页面确认 → 转换结果）
      await importPages(id, files)
      navigate(`/editable/${id}`)
    } catch (e) {
      setError((e as ApiError).detail || '导入失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gen-panel">
      <div className="gen-panel-head">
        <PanelHead
          lead={
            <>
              <span className="font-semibold text-ink">上传 PDF / 图片 / 已有 pptx</span>
              ：先按原页渲染出图片版，再由本机 agent 逐页精细重建为<b>可编辑</b> PPT。
            </>
          }
        />
      </div>

      <div className="gen-panel-drop">
        <Dropzone
          icon
          multiple
          head="拖入 PDF / 图片 / pptx（可多选，按顺序成册）"
          hint="点击此处选择文件"
          formats="PDF · PNG · JPG · PPTX · 多张图片按顺序拼成一册"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.pptx"
          onPick={(picked) => {
            setError(null)
            setFiles(picked)
          }}
        />
      </div>

      {files.length > 0 && (
        <div className="panel-alt flex flex-wrap items-center gap-2">
          <span className="status status-success">已选择 {files.length} 个文件</span>
          <span className="truncate">
            {files[0].name}
            {files.length > 1 ? ' 等' : ''}
          </span>
          <span className="num text-caption text-ink-sub">{totalKb} KB</span>
          <span className="flex-1" />
          <button type="button" className="link text-caption" onClick={() => setFiles([])}>
            清除
          </button>
        </div>
      )}

      {error && <div className="error-box text-body-sm">{error}</div>}

      <div className="gen-panel-foot">
        <span className="text-body-sm text-ink-sub">
          上传后先确认页面，再开始逐页精细重建；每页约 13 分钟，可随时停止，已完成页会保留。
        </span>
        <button type="button" className="btn btn-primary" disabled={!files.length || busy} onClick={start}>
          {busy ? '正在导入…' : '转可编辑 PPT'}
        </button>
      </div>
    </div>
  )
}
