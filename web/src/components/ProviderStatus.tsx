/**
 * 右上角供应商状态：GET /api/health
 * 未配置不报错 —— 契约用 configured:false / 布尔位，提示「到设置填写」。
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from '../router'
import { useHealth } from '../hooks/useHealth'
import type { HealthResponse, ImageProviderId } from '../types'
import { cn } from '../lib/format'

const IMAGE_LABEL: Record<ImageProviderId, string> = {
  guaihub: 'GuaiHub · GPT Image 2',
  dashscope: '阿里百炼',
  local_render: '本地兜底渲染',
}

const IMAGE_ORDER: ImageProviderId[] = [
  'guaihub',
  'dashscope',
  'local_render',
]

const HealthContext = createContext<ReturnType<typeof useHealth> | null>(null)

/** 顶栏与首页共用原有探测，保持一份请求和 20 秒轮询。 */
export function ProviderHealth({ children }: { children: ReactNode }) {
  const health = useHealth()
  return <HealthContext.Provider value={health}>{children}</HealthContext.Provider>
}

/**
 * 文本模型是否已配置（复用顶栏那份健康探测，不额外发请求）。
 * 返回 null 表示探测还没回来——调用方给中性文案，别当成「未配置」。
 */
export function useTextReady(): boolean | null {
  const state = useContext(HealthContext)
  if (!state?.data) return null
  return !!state.data.providers.text?.deepseek
}

/**
 * 生图模型是否已配置（不含 local_render 兜底）。
 * 复用顶栏那份健康探测；null 表示还没探测回来，调用方不要当成「未配置」。
 */
export function useImageReady(): boolean | null {
  const state = useContext(HealthContext)
  const image = state?.data?.providers?.image
  if (!image) return null
  return !!(image.guaihub || image.dashscope)
}

export function ProviderStatus() {
  const healthState = useContext(HealthContext)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!healthState) return null
  const { data, loading, error, reload } = healthState

  if (error) {
    return (
      <div className="flex items-center gap-2">
        <span className="status status-danger" title={error.detail}>
          后端未连接
        </span>
        <button type="button" className="link text-caption" onClick={reload}>
          重试
        </button>
      </div>
    )
  }

  if (loading && !data) {
    return <span className="status status-info">探测中…</span>
  }
  if (!data) return null

  const health: HealthResponse = data
  const cloudConfigured = IMAGE_ORDER.filter(
    (k) => k !== 'local_render' && health.providers.image?.[k],
  )
  const localReady = health.providers.image?.local_render !== false
  const textReady = !!health.providers.text?.deepseek

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="btn btn-secondary provider-trigger text-body-sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="供应商与网络状态（点开详情）"
      >
        <span className={cn('status', cloudConfigured.length ? 'status-success' : 'status-info')}>
          {cloudConfigured.length ? `${cloudConfigured.length} 个生图 key` : '未配生图 key'}
        </span>
        <span className={cn('status', localReady ? 'status-success' : 'status-danger')}>
          {localReady ? '本地兜底可用' : '本地兜底不可用'}
        </span>
        <span className={cn('status', textReady ? 'status-success' : 'status-warn')}>
          DeepSeek {textReady ? '已配' : '未配'}
        </span>
        <span className="num">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-[380px] max-w-[calc(100vw-32px)] rounded-lg border border-border bg-surface p-4 shadow-[var(--shadow-overlay)]">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold">运行状态</span>
            <span className="num text-caption text-ink-sub">
              v{health.version} · :{health.port} · db {health.db}
            </span>
          </div>

          <div className="text-caption text-ink-sub">生图供应商</div>
          <ul className="m-0 list-none p-0">
            {IMAGE_ORDER.map((id) => {
              const on = !!health.providers.image?.[id]
              return (
                <li key={id} className="flex items-center gap-2 py-0.5">
                  <span className={cn('status', on ? 'status-success' : 'status-info')}>
                    {on ? '已配置' : '未配置'}
                  </span>
                  <span className="flex-1">{IMAGE_LABEL[id]}</span>
                </li>
              )
            })}
          </ul>

          <div className="mt-3 text-caption text-ink-sub">文本模型</div>
          <div className="flex items-center gap-2 py-0.5">
            <span className={cn('status', textReady ? 'status-success' : 'status-info')}>
              {textReady ? '已配置' : '未配置'}
            </span>
            <span className="flex-1">DeepSeek（内容梳理）</span>
          </div>

          <div className="mt-3 text-caption text-ink-sub">网络模式</div>
          <div className="flex items-center gap-2 py-0.5">
            <span className="tag num">{health.network?.mode ?? 'none'}</span>
            {health.network?.http_proxy && (
              <span className="num text-caption text-ink-sub">{health.network.http_proxy}</span>
            )}
          </div>

          {(!cloudConfigured.length || !textReady) && (
            <div className="panel-alt mt-3 text-body-sm">
              还有 {(!cloudConfigured.length ? 1 : 0) + (!textReady ? 1 : 0)} 项没配；
              当前可零 key 跑通（本地兜底渲染，费用 0 元）。
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <Link to="/settings" className="btn btn-primary h-8! text-body-sm">
              到设置填写
            </Link>
            <button type="button" className="btn btn-secondary h-8! text-body-sm" onClick={reload}>
              重新探测
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
