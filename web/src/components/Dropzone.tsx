/** 拖拽上传区（首页「文档导入生成」与「图片转可编辑」共用）；paste=true 时支持截图后直接粘贴上传 */
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { clipboardImages } from '../lib/clipboard'
import { cn } from '../lib/format'
import { IconUpload } from './Icons'

/** 输入框 / 可编辑区域里的粘贴不接手（那里粘贴文本是正常操作，不能被当成上传图片） */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

export function Dropzone({
  head, hint, formats, accept, multiple, paste, icon, onPick,
}: {
  head: string
  hint: string
  formats: string
  accept: string
  multiple?: boolean
  /** 支持粘贴上传（窗口级）：截图后不用先点上传区，直接 ⌘V / Ctrl+V；文本粘贴不受影响 */
  paste?: boolean
  /** 顶部上传图标块（首页参考版式用；其他页面默认不显示，保持原紧凑样式） */
  icon?: boolean
  onPick: (files: File[]) => void
}) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // onPick 通常是内联箭头函数：存 ref，避免每次渲染都重挂 window 监听
  const onPickRef = useRef(onPick)
  useEffect(() => {
    onPickRef.current = onPick
  }, [onPick])

  useEffect(() => {
    if (!paste) return
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return
      const images = clipboardImages(e.clipboardData)
      if (!images.length) return // 不是图片：放行浏览器默认粘贴（文本不受影响）
      e.preventDefault()
      onPickRef.current(multiple ? images : images.slice(0, 1))
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [paste, multiple])

  const openPicker = () => inputRef.current?.click()
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setOver(false)
    onPick([...(e.dataTransfer?.files ?? [])])
  }

  return (
    <div
      className={cn(
        'df-dropzone cursor-pointer rounded-lg border border-dashed border-border bg-surface px-6 py-8 text-center',
        over && 'is-over',
      )}
      onClick={openPicker}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') openPicker()
      }}
    >
      {icon && (
        <span className="df-drop-icon" aria-hidden="true">
          <IconUpload className="h-6 w-6" />
        </span>
      )}
      <div className="text-h3">{head}</div>
      <div className="mt-1 text-body-sm text-ink-sub">{hint}</div>
      <div className="mt-2 text-caption text-ink-muted">{formats}</div>
      {paste && (
        <div className="mt-1 text-caption text-ink-muted">
          支持直接粘贴：截图后按 <span className="num">⌘V</span> / <span className="num">Ctrl+V</span>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          onPick([...(e.target.files ?? [])])
          e.target.value = ''            // 允许连续两次选同一个文件
        }}
      />
    </div>
  )
}
