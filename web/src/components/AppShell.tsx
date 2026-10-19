/** 应用外壳：左侧边栏（品牌 + 导航）+ 顶栏右侧供应商状态 */
import { type ComponentType, type ReactNode, type SVGProps } from 'react'
import { cn } from '../lib/format'
import { Link, useRoute, type RouteName } from '../router'
import {
  IconChart,
  IconFolder,
  IconNote,
  IconPalette,
  IconSliders,
  IconSparkles,
} from './Icons'
import { BrandMark } from './BrandMark'
import { ProviderHealth, ProviderStatus } from './ProviderStatus'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

const NAV: Array<{ to: string; label: string; match: RouteName[]; icon: IconComponent }> = [
  { to: '/', label: 'PPT 生成', match: ['home', 'wizard'], icon: IconSparkles },
  { to: '/notes', label: '备注生成', match: ['notes', 'note-detail'], icon: IconNote },
  { to: '/projects', label: '我的项目', match: ['projects', 'workbench'], icon: IconFolder },
  { to: '/styles', label: '风格选择', match: ['styles', 'style-detail'], icon: IconPalette },
  { to: '/usage', label: 'Token 用量', match: ['usage'], icon: IconChart },
  { to: '/settings', label: '系统设置', match: ['settings'], icon: IconSliders },
]

export function AppShell({ children }: { children: ReactNode }) {
  const route = useRoute()

  return (
    <ProviderHealth>
    <div className="min-h-screen bg-neutral text-ink">
      {/* 左侧边栏 */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[228px] flex-col overflow-y-auto border-r border-border bg-surface px-3 py-3 md:flex">
        <Link to="/" className="flex items-center gap-2 px-2 no-underline">
          <BrandMark className="h-7 w-7 shrink-0" />
          <span className="text-h3 font-semibold text-ink">SlideCraft</span>
        </Link>

        <nav className="mt-4 flex flex-col gap-1" aria-label="主导航">
          {NAV.map((item) => {
            const active = item.match.includes(route.name)
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'flex items-center gap-2 rounded-full px-3 py-2.5 text-body-md no-underline transition-colors',
                  active
                    ? 'bg-surface-tag font-semibold text-accent-tint-ink'
                    : 'text-ink-sub hover:bg-surface-alt hover:text-ink',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            )
          })}
        </nav>
      </aside>

      {/* 主区 */}
      <div className="md:pl-[228px]">
        <header className="sticky top-0 z-10 flex min-h-[60px] items-center gap-3 border-b border-border bg-surface px-6">
          {/* 窄屏（无侧边栏）时把导航放到顶栏 */}
          <nav className="flex max-w-full flex-wrap items-center gap-1 md:hidden" aria-label="主导航">
            {NAV.map((item) => {
              const active = item.match.includes(route.name)
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-2 py-1.5 text-body-sm no-underline',
                    active ? 'bg-surface-tag font-semibold text-accent-tint-ink' : 'text-ink-sub',
                  )}
                >
                  <item.icon className="h-3.5 w-3.5 shrink-0" />
                  {item.label}
                </Link>
              )
            })}
          </nav>

          <span className="flex-1" />
          <ProviderStatus />
        </header>

        <main className="mx-auto max-w-[1320px] px-6 py-6">{children}</main>

      </div>
    </div>
    </ProviderHealth>
  )
}
