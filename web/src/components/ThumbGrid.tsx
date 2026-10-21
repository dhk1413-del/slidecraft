/**
 * 缩略图网格（业务组件）：
 * 状态 —— 未选 / 已选（2px accent 描边 + 10% 底）/ 生成中（呼吸）/ 失败 / 可编辑 / 图片直通
 * 角标必须用「文字」明示，不得只靠颜色（components.md）
 */
import { useEffect, useState, type ReactNode } from 'react'
import { cn, pageNo } from '../lib/format'
import type { JobProgressEvent, Slide } from '../types'

/** 页面在网格里的可视状态 */
export type ThumbState = 'pending' | 'generating' | 'done' | 'failed' | 'interrupted'

export interface ThumbBadge {
  text: string
  cls: string
  /** 悬停说明：降级/失败类角标必须能一眼看到原因 */
  hint?: string
}

export function slideState(slide: Slide | undefined, progress?: JobProgressEvent): ThumbState {
  if (!slide) return progress ? 'generating' : 'pending'
  const s = slide.status
  if (s === 'interrupted') return 'interrupted'
  if (s === 'failed' || s === 'error') return 'failed'
  if (s === 'running' || s === 'queued') return 'generating'
  if (s === 'done' && slide.image_url) return 'done'
  if (s === 'generating') return 'generating'
  return 'pending'
}

/** 角标：图片版 / 生成中 / 失败 / 本地渲染（"原生可编辑"角标随内置引擎下线一并移除——
 *  转可编辑已独立成 #/editable 模块，其状态不在生成流程的缩略图上体现）。 */
export function thumbBadge(state: ThumbState, slide?: Slide): ThumbBadge {
  if (state === 'interrupted') return {text:'已中断',cls:'status-warn',hint:'未完成页未生成，可重新生成；旧版本保留'}
  if (state === 'failed') return { text: '失败', cls: 'status-danger' }
  if (state === 'generating') return { text: '处理中', cls: 'status-warn' }
  if (state === 'pending') return { text: '未就绪', cls: 'status-info' }
  // 生成成功但走的是本地兜底：要么没配 key（配置态），要么生图调用失败（异常态）——必须区分，别把失败说成"图片版"
  if (slide?.provider === 'local_render') {
    const reason = slide.error || ''
    const noKey = /未配置/.test(reason)
    return noKey
      ? { text: '本地渲染（无 key）', cls: 'status-info', hint: reason }
      : { text: '生图失败·已降级', cls: 'status-danger', hint: reason || '生图调用失败，已降级为本地兜底渲染' }
  }
  return { text: '已完成', cls: 'status-info' }
}

export interface SlideThumbProps {
  pageNoValue: number
  title?: string
  slide?: Slide
  progress?: JobProgressEvent
  selected?: boolean
  selectable?: boolean
  disabled?: boolean
  /** 禁用原因（disabeld 需给 tooltip 说明，components.md） */
  disabledReason?: string
  onToggle?: () => void
  onOpen?: () => void
  /** 覆盖默认角标（转可编辑进度页需要「图片版 / 转换中 / 排队中 / 已完成」口径） */
  badgeOverride?: ThumbBadge
  /** 缩略图上的浮层（转换进度：spinner / 排队中） */
  overlay?: ReactNode
  /** 是否显示缩略图下方的「源页号 / 展示序号」说明（转可编辑进度页不需要） */
  showMeta?: boolean
}

export function SlideThumb({
  pageNoValue,
  title,
  slide,
  progress,
  selected = false,
  selectable = true,
  disabled = false,
  disabledReason,
  onToggle,
  onOpen,
  badgeOverride,
  overlay,
  showMeta = true,
}: SlideThumbProps) {
  const [broken, setBroken] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(()=>{setBroken(false);setLoaded(false)},[slide?.image_url])
  const state = slideState(slide, progress)
  const badge = badgeOverride ?? thumbBadge(state, slide)
  const showImage = slide?.image_url && !broken

  const tooltip = disabled && disabledReason
    ? disabledReason
    : (title ?? `第 ${pageNoValue} 页`) + (badge.hint ? ` · ${badge.hint}` : '')

  return (
    <div className="flex flex-col gap-1">
      <div
        role={selectable ? 'checkbox' : 'img'}
        aria-checked={selectable ? selected : undefined}
        aria-label={`第 ${pageNoValue} 页${title ? ` · ${title}` : ''}（${badge.text}）`}
        aria-disabled={disabled}
        tabIndex={0}
        title={tooltip}
        className={cn(
          'thumb',
          selected && 'selected',
          state === 'generating' && 'df-breathing',
          disabled && 'cursor-not-allowed opacity-60',
        )}
        onClick={() => {
          if (disabled) return
          if (selectable) onToggle?.()
          else onOpen?.()
        }}
        onDoubleClick={() => onOpen?.()}
        onKeyDown={(e) => {
          if (e.key === ' ') {
            e.preventDefault()
            if (!disabled) onToggle?.()
          }
          if (e.key === 'Enter') onOpen?.()
        }}
      >
        {showImage ? (
          <>
            {!loaded && <div className="df-skeleton absolute inset-0 rounded-[10px]" />}
            <img
              src={slide!.image_url}
              alt={`第 ${pageNoValue} 页：${title ?? ''}`}
              loading="lazy"
              className="h-full w-full object-cover"
              onLoad={() => setLoaded(true)}
              onError={() => setBroken(true)}
            />
          </>
        ) : (
          <span className="px-3 text-center text-caption text-ink-sub">
            {state === 'generating' && progress?.message ? progress.message : badge.text}
          </span>
        )}

        {/* 角标：文字明示（状态色，不用主色） */}
        <span className={cn('corner status', badge.cls, 'font-medium')} title={badge.hint}>
          {slide?.image_url && state !== 'done' ? `${badge.text} · 上一版本` : badge.text}
        </span>
        {selected && (
          <span className="absolute right-1.5 top-1.5 status status-info">已选</span>
        )}
        <span className="pageno num">
          {pageNo(pageNoValue)}
          {Array.isArray(slide?.verify?.issues) && slide.verify.issues.length > 0 && (
            <span className="ml-1 status status-warn" title={slide.verify.issues.join('；')}>
              校验 {slide.verify.issues.length}
            </span>
          )}
        </span>
        {overlay && <div className="absolute inset-0 z-10">{overlay}</div>}
      </div>

      {showMeta && slide && <p className="num m-0 text-caption">源页号 {slide.source_page_no ?? '—'} / 展示序号 {slide.display_order ?? slide.page_no} · {state==='done'?'已完成':badge.text}</p>}
      {slide?.content_stale && <span className="status status-warn">基于旧内容</span>}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-caption text-ink-sub" title={title}>
          {title || '（无标题）'}
        </span>
        {onOpen && (
          <button
            type="button"
            className="link shrink-0 text-caption"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
          >
            看大图
          </button>
        )}
      </div>
    </div>
  )
}

export function ThumbGrid({ children }: { children: ReactNode }) {
  return <div className="thumb-grid">{children}</div>
}
