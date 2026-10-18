/**
 * 轻量 hash 路由（不引第三方路由库）：
 *   #/            首页（三模式切换：文档导入生成 / 图片转可编辑 / PPT美化 v2：生图预览 → 确认后逐页精细重建）
 *   #/?mode=x     首页并切到指定模式（topic|editable|reskin）
 *   #/wizard/<id>/<step>  生成向导（5 步）
 *   #/projects    项目列表
 *   #/projects/:id 工作台（生成结果 + 转可编辑）
 *   #/styles      风格库
 *   #/styles/:id  风格详情
 *   #/style-builder 风格构建（上传模板/参考图 → 自动解析 → 生成新风格包）
 *   #/usage       用量账本
 *   #/settings    设置
 */
import { useCallback, useEffect, useMemo, useState, type AnchorHTMLAttributes } from 'react'

export type RouteName =
  | 'home'
  | 'wizard'
  | 'editable'
  | 'projects'
  | 'workbench'
  | 'notes'
  | 'note-detail'
  | 'styles'
  | 'style-detail'
  | 'style-builder'
  | 'usage'
  | 'settings'
  | 'not-found'

export interface Route {
  name: RouteName
  params: Record<string, string>
  path: string
}

const readHash = () => {
  const raw = window.location.hash.replace(/^#/, '')
  const path = raw.split('?')[0] || '/'
  return path.startsWith('/') ? path : `/${path}`
}

/** 读取 hash 里的查询串（`#/editable/:id?auto=1`）；路由只认 path，query 由页面自取 */
export function readQuery(): Record<string, string> {
  const raw = window.location.hash.replace(/^#/, '')
  const qs = raw.split('?')[1] ?? ''
  const out: Record<string, string> = {}
  for (const kv of qs.split('&')) {
    if (!kv) continue
    const i = kv.indexOf('=')
    const k = i < 0 ? kv : kv.slice(0, i)
    out[decodeURIComponent(k)] = decodeURIComponent(i < 0 ? '' : kv.slice(i + 1))
  }
  return out
}

function match(path: string): Route {
  const seg = path.split('/').filter(Boolean)
  const at = (i: number) => decodeURIComponent(seg[i] ?? '')
  if (seg.length === 0) return { name: 'home', params: {}, path }
  if (seg[0] === 'wizard') return { name: 'wizard', params: { id: at(1), step: at(2) }, path }
  if (seg[0] === 'editable') return { name: 'editable', params: { id: at(1) }, path }
  if (seg[0] === 'projects' && seg.length === 1) return { name: 'projects', params: {}, path }
  if (seg[0] === 'projects' && seg.length >= 2)
    return { name: 'workbench', params: { id: at(1) }, path }
  if (seg[0] === 'styles' && seg.length === 1) return { name: 'styles', params: {}, path }
  if (seg[0] === 'styles' && seg.length >= 2)
    return { name: 'style-detail', params: { id: at(1) }, path }
  if (seg[0] === 'style-builder') return { name: 'style-builder', params: {}, path }
  if (seg[0] === 'notes' && seg.length === 1) return { name: 'notes', params: {}, path }
  if (seg[0] === 'notes' && seg.length >= 2) return { name: 'note-detail', params: { id: at(1) }, path }
  if (seg[0] === 'usage') return { name: 'usage', params: {}, path }
  if (seg[0] === 'settings') return { name: 'settings', params: {}, path }
  return { name: 'not-found', params: {}, path }
}

export function useRoute(): Route {
  const [path, setPath] = useState(readHash)
  useEffect(() => {
    const onChange = () => setPath(readHash())
    window.addEventListener('deckforge:route', onChange)
    if (!window.location.hash) window.location.hash = '#/'
    return () => window.removeEventListener('deckforge:route', onChange)
  }, [])
  return useMemo(() => match(path), [path])
}

const leaveGuards = new Set<()=>Promise<boolean>>()
export function registerLeaveGuard(guard:()=>Promise<boolean>) {leaveGuards.add(guard);return()=>{leaveGuards.delete(guard)}}
export async function finishPendingSaves() {for(const guard of [...leaveGuards]) if(!await guard())return false;return true}
let acceptedHash=window.location.hash
let navigationSerial=0
window.addEventListener('hashchange',()=>{
  const target=window.location.hash
  if(target===acceptedHash)return
  const serial=++navigationSerial
  const notify=()=>window.dispatchEvent(new Event('deckforge:route'))
  if(!leaveGuards.size){acceptedHash=target;notify();return}
  window.history.replaceState(window.history.state,'',window.location.href.split('#')[0]+acceptedHash)
  void finishPendingSaves().then(ok=>{
    if(serial!==navigationSerial)return
    if(ok){acceptedHash=target;window.history.replaceState(window.history.state,'',window.location.href.split('#')[0]+target);notify()}
    else window.alert('保存失败，草稿已保留。请重试保存后离开。')
  })
})
export function navigate(to: string) {
  // Hash changes (including browser back) all pass through the same save guard.
  const next = to.startsWith('#') ? to : `#${to}`
  if (window.location.hash === next) return
  window.location.hash = next
  window.scrollTo({ top: 0 })
}

export function useNavigate() {
  return useCallback((to: string) => navigate(to), [])
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string
}

/** 语义化链接：href 用 hash，支持键盘与中键新开 */
export function Link({ to, children, ...rest }: LinkProps) {
  const href = to.startsWith('#') ? to : `#${to}`
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e)
        if (e.defaultPrevented) return
        e.preventDefault()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}
