/**
 * 未接模型时的用户引导（2026-10-22 用户要求）。
 *
 * 产品约定：
 * - **没有模型也能进页面**：浏览、上传、梳理、看已有项目都照常；
 * - **生成页面 / 转可编辑**需要先配置/就绪：点这两个动作时先弹引导，而不是直接开跑；
 * - 用户仍可**显式选择**「先用本地演示（质量有限、费用 0）」，不做静默降级、也不偷偷花钱；
 * - 零 key 的 API 兜底能力保留（`tools/e2e_mvp.py` 的零 key 基线依赖它），这里只做**交互层**引导。
 */
import { useState, type ReactNode } from 'react'
import { Link } from '../router'
import { useImageReady } from './ProviderStatus'
import { cn } from '../lib/format'
import type { EditableEngine } from '../types'

const DISMISS_KEY = 'slidecraft:onboarding-dismissed:v1'

export function isOnboardingDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissOnboarding(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* 隐私模式下 localStorage 可能不可用：忽略，下次还会提示 */
  }
}

/**
 * 主动提示条：未配置生图模型时出现在入口页，说明「能做什么 / 缺什么 / 去哪配」。
 * 可「稍后」关闭（本机记住），避免每次都挡视线。
 */
export function ModelSetupNotice({ className, extra }: { className?: string; extra?: ReactNode }) {
  const imageReady = useImageReady()
  const [dismissed, setDismissed] = useState(isOnboardingDismissed)
  if (dismissed || imageReady !== false) return null
  return (
    <section
      role="status"
      aria-label="配置模型引导"
      className={cn('panel-alt flex flex-wrap items-center gap-3', className)}
    >
      <span className="status status-warn shrink-0">未配置生图模型</span>
      <div className="min-w-0 flex-1 text-body-sm">
        可以浏览、上传和梳理内容；<strong>生成页面</strong>要先配置生图模型，
        <strong>转可编辑</strong>还需要本机重建引擎可用。
        <span className="text-ink-sub">（点生成时也可以选「先用本地演示」，质量有限、费用 0）</span>
        {extra}
      </div>
      <Link to="/settings" className="btn btn-primary h-8! text-body-sm">
        去配置密钥
      </Link>
      <button
        type="button"
        className="link text-body-sm"
        onClick={() => {
          setDismissed(true)
          dismissOnboarding()
        }}
      >
        稍后
      </button>
    </section>
  )
}

/**
 * 点「生成」时的选择弹窗：去配置 vs 先用本地演示。
 * 只有用户**明确**点了「先用本地演示」才会走本地兜底，不会静默降级。
 */
export function LocalDemoDialog({
  open,
  actionLabel = '生成页面',
  onCancel,
  onDemo,
}: {
  open: boolean
  actionLabel?: string
  onCancel: () => void
  onDemo: () => void
}) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="未配置生图模型"
      onClick={onCancel}
    >
      <div className="panel w-full max-w-lg" onClick={(event) => event.stopPropagation()}>
        <h3 className="m-0 text-h3 font-semibold">还没配置生图模型</h3>
        <p className="mt-2 text-body-sm text-ink-sub">
          配置后可以{actionLabel}（真实设计，质量最佳）。也可以先用<strong>本地演示</strong>：
          费用 0，但只是兜底排版，不代表真实设计效果。
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn btn-secondary" onClick={onDemo}>
            先用本地演示
          </button>
          <Link to="/settings" className="btn btn-primary" onClick={onCancel}>
            去配置密钥
          </Link>
        </div>
      </div>
    </div>
  )
}

/** 转可编辑：引擎不可用时的提示（缺 Harness/CLI/skill，或未登录）。 */
export function EngineUnavailableNotice({ engine }: { engine: EditableEngine | null }) {
  if (!engine || engine.ok) return null
  return (
    <section
      role="status"
      aria-label="重建引擎不可用"
      className="panel-alt flex flex-wrap items-center gap-3"
    >
      <span className="status status-warn shrink-0">重建引擎不可用</span>
      <div className="min-w-0 flex-1 text-body-sm">
        {engine.reason || '缺少重建所需的组件。'}
        <span className="text-ink-sub">
          {' '}
          首次启动会自动安装；也可以在项目目录运行 <code>make install-agent</code> 重试，并在 Harness 里登录一次。
        </span>
      </div>
    </section>
  )
}
