/** 路由出口：5 个页面 + 404 */


import { useEffect, useState } from 'react'
import { AppShell } from './components/AppShell'
import { BeautifyPanel } from './components/BeautifyPanel'
import { NotesWorkbench } from './components/NotesWorkbench'

import { EmptyState, Loading } from './components/StateBlock'

import { getProject, listStylePacks } from './api'
import { useAsync } from './hooks/useAsync'
import { NotesPage } from './pages/NotesPage'
import { HomePage } from './pages/HomePage'
import { ProjectsPage } from './pages/ProjectsPage'
import { SettingsPage } from './pages/SettingsPage'
import { StyleDetailRoute, StylesPage } from './pages/StylesPage'
import { StyleBuilderPage } from './pages/StyleBuilderPage'
import { UsagePage } from './pages/UsagePage'
import { WizardPage } from './pages/WizardPage'
import { EditableFlowPage } from './pages/EditableFlowPage'
import { readQuery, useRoute } from './router'

const noop = () => {}

/**
 * `#/projects/{id}`：按项目**真实所属的流程**恢复到上一次执行到的步骤，布局与「PPT 生成」里同一步完全一致。
 * · beautify（磁盘上有美化现场 data/files/<pid>/beautify/）→ 恢复 PPT 美化五步流程
 * · 其它 → 生成向导（WizardPage 自己按 resume_step 跳步）
 */
function ProjectRoute({ id }: { id: string }) {
  const [flow, setFlow] = useState<'loading' | 'beautify' | 'editable' | 'wizard'>('loading')
  const packs = useAsync(listStylePacks, [])
  useEffect(() => {
    let active = true
    getProject(id)
      .then((project) => { if (active) setFlow(project.flow === 'beautify' ? 'beautify' : project.flow === 'editable' ? 'editable' : 'wizard') })
      .catch(() => { if (active) setFlow('wizard') })   // 取不到就让向导页自己去报错，不在这里编状态
    return () => { active = false }
  }, [id])
  if (flow === 'loading') return <Loading rows={3} label="正在恢复项目…" />
  if (flow === 'beautify') {
    return <BeautifyPanel packs={packs.data?.items ?? []} loadingPacks={packs.loading} onStepChange={noop} resumeProjectId={id} />
  }
  if (flow === 'editable') return <EditableFlowPage projectId={id} />
  return <WizardPage />
}

export default function App() {
  const route = useRoute()

  return (
    <AppShell>
      {route.name === 'home' && (readQuery().style ? <WizardPage /> : <HomePage />)}
      {route.name === 'wizard' && <WizardPage />}
      {route.name === 'editable' && <EditableFlowPage projectId={route.params.id ?? ''} />}
      {route.name === 'notes' && <NotesPage />}
      {route.name === 'note-detail' && <NotesWorkbench nid={route.params.id ?? ''} />}
      {route.name === 'projects' && <ProjectsPage />}
      {route.name === 'workbench' && <ProjectRoute id={route.params.id ?? ''} />}
      {route.name === 'styles' && <StylesPage />}
      {route.name === 'style-detail' && <StyleDetailRoute />}
      {route.name === 'style-builder' && <StyleBuilderPage />}
      {route.name === 'usage' && <UsagePage />}
      {route.name === 'settings' && <SettingsPage />}
      {route.name === 'not-found' && (
        <div className="card">
          <EmptyState
            title="页面不存在"
            desc={`没有这个路由：${route.path}。可用页面：生成 / 备注 / 项目 / 风格 / 用量 / 设置。`}
            actionLabel="回到生成向导"
            to="/"
          />
        </div>
      )}
    </AppShell>
  )
}

