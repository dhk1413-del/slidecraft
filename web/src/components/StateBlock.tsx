/** 三态组件：加载 / 空 / 错误 + 降级提示条（components.md：空态给一句话 + 一个主按钮；错误态写清「缺什么 · 去哪填 · 怎么重试」） */
import type { ReactNode } from 'react'
import type { ApiError } from '../api'
import { BACKEND_HINT } from '../lib/format'
import { Link } from '../router'

/** 骨架加载：占位块保持高度，避免布局跳动 */
export function Loading({ rows = 3, label = '加载中…' }: { rows?: number; label?: string }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label={label}>
      <div className="df-skeleton h-4 w-32" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="df-skeleton h-12 w-full" />
      ))}
    </div>
  )
}

export function EmptyState({
  title,
  desc,
  actionLabel,
  onAction,
  to,
}: {
  title: string
  desc: string
  actionLabel?: string
  onAction?: () => void
  to?: string
}) {
  return (
    <div className="empty">
      <div className="text-ink font-semibold">{title}</div>
      <p className="mx-auto mt-1 max-w-[420px] text-ink-sub">{desc}</p>
      {actionLabel && to && (
        <Link to={to} className="btn btn-primary mt-4">
          {actionLabel}
        </Link>
      )}
      {actionLabel && !to && (
        <button type="button" className="btn btn-primary mt-4" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}

/** 错误文案：把「缺什么 / 去哪填 / 怎么重试」讲清楚，不裸奔 code */
function explain(error: ApiError): { missing: string; where: string } {
  if (error.offline) {
    return {
      missing: BACKEND_HINT,
      where: '按上述命令启动后端，或检查服务是否被防火墙/代理拦截',
    }
  }
  if (error.status === 404) {
    return { missing: '后端没有这个资源（可能项目 ID 不对或已被删除）', where: '回到「项目」列表重新选择' }
  }
  if (error.status >= 500) {
    return { missing: `后端内部错误：${error.detail}`, where: '查看后端日志（终端里的 uvicorn 输出）后重试' }
  }
  return { missing: error.detail, where: '检查输入或后端配置后重试' }
}

export function ErrorState({
  error,
  onRetry,
  title = '加载失败',
  compact = false,
}: {
  error: ApiError
  onRetry?: () => void
  title?: string
  compact?: boolean
}) {
  const { missing, where } = explain(error)
  return (
    <div className="error-box" role="alert">
      <div className="font-semibold">
        {title}
        <span className="num ml-2 opacity-70">{error.status ? `HTTP ${error.status}` : '客户端错误'}</span>
      </div>
      <ul className={compact ? 'mt-1 text-body-sm' : 'mt-2 text-body-md'}>
        <li>· 缺什么：{missing}</li>
        <li>· 去哪填/查：{where}</li>
        <li>· 怎么重试：{onRetry ? '点右侧「重试」按钮重新拉取' : '修复上述问题后刷新页面'}</li>
      </ul>
      {onRetry && (
        <button type="button" className="btn btn-secondary mt-3" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  )
}

/** 模型未配置（契约：HTTP 200 + configured:false）→ 提示而非报错 */
export function NotConfiguredBanner({
  reason,
  hint,
  fellback,
  action,
}: {
  reason?: string
  hint?: string
  fellback?: string
  action?: ReactNode
}) {
  const fallbackText =
    fellback === 'local_render'
      ? '将使用本地兜底渲染（Pillow 画 16:9 PNG，费用 0 元）'
      : fellback === 'local_split'
        ? '已使用本地规则切页兜底'
        : fellback
          ? `后端降级方案：${fellback}`
          : ''
  return (
    <div className="panel-alt flex flex-wrap items-center gap-3" role="status">
      <span className="status status-warn shrink-0">未配置模型</span>
      <div className="min-w-0 flex-1 text-body-sm">
        {reason && <span>{reason}。 </span>}
        {fallbackText && <span>{fallbackText}。 </span>}
        <span className="text-ink-sub">{hint ?? '到「设置 → 模型与密钥」填写对应 API Key'}</span>
      </div>
      {action ??
        (hint && (
          <Link to="/settings" className="btn btn-secondary h-8! text-body-sm">
            去设置填写
          </Link>
        ))}
    </div>
  )
}

/** 轻量信息条 */
export function Notice({
  kind = 'info',
  children,
  action,
}: {
  kind?: 'info' | 'warn' | 'success' | 'danger'
  children: ReactNode
  action?: ReactNode
}) {
  const cls =
    kind === 'warn'
      ? 'status-warn'
      : kind === 'success'
        ? 'status-success'
        : kind === 'danger'
          ? 'status-danger'
          : 'status-info'
  const label =
    kind === 'warn' ? '注意' : kind === 'success' ? '完成' : kind === 'danger' ? '失败' : '提示'
  return (
    <div className="panel-alt flex flex-wrap items-center gap-3">
      <span className={`status ${cls} shrink-0`}>{label}</span>
      <div className="min-w-0 flex-1 text-body-sm">{children}</div>
      {action}
    </div>
  )
}
