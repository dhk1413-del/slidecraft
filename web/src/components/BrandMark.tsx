/**
 * 品牌标：渐变圆角底 + 叠页 + 星芒（纯内联 SVG，无外部图片依赖）。
 *
 * 设计说明：
 *  · 两页叠放 = 「整套幻灯片」；前页上的三行 = 标题/要点结构；
 *  · 右上角星芒 = AI 生成；渐变底用 ui-design 的品牌渐变令牌，深色主题自动跟随；
 *  · 图标内部不写任何文字（1em/28px 下文字必然糊），品牌名由旁边的字标承担。
 */
import { useId } from 'react'

const PRIMARY = 'var(--color-primary, #1E78FA)'

export function BrandMark({ className }: { className?: string }) {
  // 同一页面可能渲染多次：渐变 id 必须唯一（useId 自带冒号，去掉避免 url(#…) 解析问题）
  const gid = 'brand-' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="SlideCraft">
      <defs>
        <linearGradient id={gid} x1="2" y1="4" x2="30" y2="28" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: 'var(--color-brand-grad-from, #2E6BF2)' }} />
          <stop offset="1" style={{ stopColor: 'var(--color-brand-grad-to, #3E92F8)' }} />
        </linearGradient>
      </defs>

      <rect width="32" height="32" rx="9" fill={`url(#${gid})`} />
      {/* 内描边：让圆角边在浅色/深色底上都更利落 */}
      <rect x="0.7" y="0.7" width="30.6" height="30.6" rx="8.3" fill="none" stroke="#fff" strokeOpacity="0.26" />

      {/* 后面一页（半透明，做层叠感） */}
      <rect x="6.2" y="9.4" width="14.4" height="11.2" rx="2.6" fill="#fff" opacity="0.45" />
      {/* 前面一页 + 内容线条 */}
      <rect x="10.4" y="13" width="15.4" height="12" rx="2.8" fill="#fff" />
      <rect x="13.4" y="16.4" width="7" height="1.7" rx="0.85" style={{ fill: PRIMARY }} />
      <rect x="13.4" y="19.6" width="9.4" height="1.5" rx="0.75" style={{ fill: PRIMARY }} opacity="0.45" />
      <rect x="13.4" y="22.5" width="5.4" height="1.5" rx="0.75" style={{ fill: PRIMARY }} opacity="0.3" />

      {/* 星芒：AI 生成 */}
      <path d="M23.9 4.6l1.05 2.75 2.75 1.05-2.75 1.05-1.05 2.75-1.05-2.75-2.75-1.05 2.75-1.05z" fill="#fff" />
    </svg>
  )
}
