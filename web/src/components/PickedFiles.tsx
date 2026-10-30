/**
 * 已选文件清单（上传前确认）：图片显示缩略图 + 顺序编号，非图片显示类型角标。
 * 图片转可编辑/文档上传共用——粘贴截图后能立刻看到「第几张、会不会按顺序成册」。
 */
import { useEffect, useMemo } from 'react'

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function PickedFiles({ files, onClear }: { files: File[]; onClear: () => void }) {
  const urls = useMemo(
    () => files.map((file) => (file.type.startsWith('image/') ? URL.createObjectURL(file) : '')),
    [files],
  )
  useEffect(
    () => () => urls.forEach((url) => { if (url) URL.revokeObjectURL(url) }),
    [urls],
  )
  if (!files.length) return null
  const total = files.reduce((sum, file) => sum + file.size, 0)
  return (
    <div className="panel-alt flex flex-col gap-2" data-testid="picked-files">
      <div className="flex flex-wrap items-center gap-2">
        <span className="status status-success">
          已选择 <span className="num">{files.length}</span> 个文件
        </span>
        <span className="num text-caption text-ink-sub">共 {sizeLabel(total)}</span>
        <span className="flex-1" />
        <button type="button" className="link text-caption" onClick={onClear}>清除</button>
      </div>
      <ol className="m-0 flex list-none flex-wrap gap-2 p-0">
        {files.map((file, index) => (
          <li key={`${file.name}-${file.lastModified}-${index}`} className="flex w-[164px] flex-col gap-1">
            <div className="flex h-[92px] items-center justify-center overflow-hidden rounded-md border border-border bg-surface-alt">
              {urls[index]
                ? <img src={urls[index]} alt={file.name} className="h-full w-full object-cover" loading="lazy" />
                : <span className="truncate px-2 text-caption text-ink-sub">{(file.name.split('.').pop() || '文件').toUpperCase()}</span>}
            </div>
            <span className="truncate text-caption text-ink-sub" title={file.name}>
              <span className="num">{index + 1}.</span> {file.name}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
