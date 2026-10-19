/**
 * 内联 SVG 图标集（零依赖）：统一 24 视窗 / stroke 取 currentColor / 默认 1em。
 * 用法： <IconFolder className="h-4 w-4" />
 * 说明：全部为几何线条，不用填充色，跟随所在文字的颜色与深浅。
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Base({ children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** 生成：星芒（AI 生成） */
export function IconSparkles(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M11 3.5l1.7 4.8L17.5 10l-4.8 1.7L11 16.5 9.3 11.7 4.5 10l4.8-1.7z" />
      <path d="M18 15.5l.75 2.1 2.1.75-2.1.75-.75 2.1-.75-2.1-2.1-.75 2.1-.75z" />
    </Base>
  )
}

/** 备注：便签 */
export function IconNote(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M8 9.5h8M8 13.5h5" />
    </Base>
  )
}

/** 项目：文件夹 */
export function IconFolder(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 6.5A2 2 0 0 1 5 4.5h3.7l2 2.2H19a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Base>
  )
}

/** 风格：调色盘 */
export function IconPalette(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 20.5a8.5 8.5 0 1 1 8.5-8.5c0 1.9-1.4 2.9-2.9 2.9h-1.3a1.9 1.9 0 0 0-1.4 3.2 1.7 1.7 0 0 1-1.3 2.4z" />
      <circle cx="8.6" cy="10.6" r="1" />
      <circle cx="12" cy="8" r="1" />
      <circle cx="15.4" cy="10.6" r="1" />
    </Base>
  )
}

/** 用量：柱状图 */
export function IconChart(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 20h16" />
      <path d="M7.5 20V12.5M12 20V6.5M16.5 20V15" />
    </Base>
  )
}

/** 设置：滑杆 */
export function IconSliders(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 8.5h5M15 8.5h5M4 15.5h9M19 15.5h1" />
      <circle cx="12" cy="8.5" r="2" />
      <circle cx="16.5" cy="15.5" r="2" />
    </Base>
  )
}

/** 状态：已完成（圆勾） */
export function IconCheck(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M8.4 12.3l2.5 2.5 4.7-5.1" />
    </Base>
  )
}

/** 状态：进行中（时钟） */
export function IconClock(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.8V12l2.9 1.9" />
    </Base>
  )
}

/** 全部项目：右尖角 */
export function IconChevronRight(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M9.5 6l6 6-6 6" />
    </Base>
  )
}

/** 上传：托盘 + 上箭头（首页上传区） */
export function IconUpload(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 15.4V5.2" />
      <path d="M8.2 8.9L12 5.1l3.8 3.8" />
      <path d="M5 14.6v3a1.9 1.9 0 0 0 1.9 1.9h10.2a1.9 1.9 0 0 0 1.9-1.9v-3" />
    </Base>
  )
}
