/** 设置：生图（左）/ 文本与视觉（右）左右布局；key 密码型输入 + 掩码回显 + 连通性测试。
 *  网络模式模块按用户要求从界面移除（后端 PUT /api/settings 的 network 字段仍在，需要时可恢复 UI）。 */
import { useEffect, useState } from 'react'
import { getSettings, putSettings, testProvider, type ApiError } from '../api'
import { useAsync } from '../hooks/useAsync'
import { cn } from '../lib/format'
import { IconChevronRight } from '../components/Icons'
import { EmptyState, ErrorState, Loading, Notice } from '../components/StateBlock'
import { useToast } from '../components/Toast'
import type {
  ProviderSetting,
  SettingsResponse,
  SettingsTestResponse,
} from '../types'

/** 已保存 key 的验证结论只对当前掩码有效；输入新 key 或保存后均不能沿用。 */
function useKeyVerification(keyMasked: string, keySet: boolean, pendingKey: string) {
  const [verifiedKeyMasked, setVerifiedKeyMasked] = useState<string | null>(null)
  const hasPendingKey = pendingKey.trim().length > 0
  const passedVerification = !hasPendingKey && keySet && verifiedKeyMasked === keyMasked

  useEffect(() => {
    setVerifiedKeyMasked(null)
  }, [keyMasked])

  return {
    hasPendingKey,
    passedVerification,
    clearVerification: () => setVerifiedKeyMasked(null),
    recordTest: (test: SettingsTestResponse) => {
      setVerifiedKeyMasked(
        !hasPendingKey && test.ok && test.status >= 200 && test.status < 300 ? keyMasked : null,
      )
    },
  }
}

function KeyStatusBadge({
  keySet,
  verification,
  emptyHint = 'key 未配置',
}: {
  keySet: boolean
  verification: ReturnType<typeof useKeyVerification>
  emptyHint?: string
}) {
  const label = verification.passedVerification
    ? '已通过连通性测试'
    : keySet || verification.hasPendingKey
      ? 'key 已填写（未验证）'
      : emptyHint
  return <span className={cn('status', verification.passedVerification ? 'status-success' : 'status-info')}>{label}</span>
}

/** 单个供应商卡片：key 输入 + 模型 + 尺寸 + 单价（生图用）+ 保存 + 测试 */
function ProviderCard({
  provider,
  onSaved,
  defaultOpen = false,
  showPrice = true,
}: {
  provider: ProviderSetting
  onSaved: (next: SettingsResponse) => void
  /** 设置页卡片多：默认收起，需要配置时再展开（否则整页远超一屏） */
  defaultOpen?: boolean
  /** 视觉模型按 token 计费，没有"元/张"概念 → 该卡片不显示单价 */
  showPrice?: boolean
}) {
  const toast = useToast()
  const [open, setOpen] = useState(defaultOpen)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(provider.base_url ?? '')
  const [model, setModel] = useState(provider.default_model ?? '')
  const [size, setSize] = useState(provider.default_size ?? '2K')
  const [price, setPrice] = useState(provider.unit_price_cny != null ? String(provider.unit_price_cny) : '')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<SettingsTestResponse | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  const needsKey = provider.id !== 'local_render'
  const verification = useKeyVerification(provider.key_masked, provider.key_set, apiKey)

  // 保存或重新读取后，只要后端的掩码变化，旧 key 的测试结论就不能再使用。
  useEffect(() => {
    setTest(null)
  }, [provider.key_masked])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const next = await putSettings({
        provider_id: provider.id,
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
        default_model: model,
        default_size: size,
        unit_price_cny: price.trim(),
      })
      onSaved(next)
      setApiKey('')
      setTest(null)
      verification.clearVerification()
      toast.success(`「${provider.label}」已保存 —— 已热加载，无需重启`)
    } catch (e) {
      setError(e as ApiError)
      toast.error('保存失败', (e as ApiError).detail)
    } finally {
      setSaving(false)
    }
  }

  async function runTest() {
    setTesting(true)
    setTest(null)
    try {
      const res = await testProvider(provider.id, apiKey || undefined)
      setTest(res)
      verification.recordTest(res)
      res.ok ? toast.success(`「${provider.label}」${res.message}`) : toast.warn(`「${provider.label}」${res.message}`)
    } catch (e) {
      setError(e as ApiError)
      toast.error('连通性测试失败', (e as ApiError).detail)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="card p-3!">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-ghost h-7! px-1! text-body-sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={open ? '收起配置' : '展开配置'}
        >
          <IconChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
        </button>
        <h2 className="card-title m-0! text-h3">{provider.label}</h2>
        <span className="tag num">{provider.id}</span>
        <KeyStatusBadge
          keySet={provider.key_set}
          verification={verification}
          emptyHint={provider.id === 'qwen_vl'
            ? provider.fallback ? '未单独配置，复用 GuaiHub key' : 'key 未配置（图片识别不可用）'
            : undefined}
        />
        {provider.fallback && <span className="status status-info">复用 GuaiHub key</span>}
        {provider.needs_proxy && <span className="status status-warn">需代理</span>}
        {!needsKey && <span className="status status-success">本地兜底 · 无需 key</span>}
        {!open && (
          <span className="truncate text-caption text-ink-sub">
            {provider.key_set
              ? `key 已配置（${provider.key_masked || '••••••'}）`
              : needsKey
                ? '还没填 key —— 点箭头展开'
                : '无需 key'}
            {' · '}
            默认 {provider.default_model || '—'} / {provider.default_size || '2K'}
          </span>
        )}
        <span className="flex-1" />
        {typeof provider.unit_price_cny === 'number' && (
          <span className="num text-caption text-ink-sub">单价 ¥{provider.unit_price_cny}</span>
        )}
      </div>

      {open && needsKey && (
        <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-6">
          <label className="flex flex-col gap-1 lg:col-span-2">
            <span className="metric-label">API Key</span>
            <input
              className="input num"
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={
                provider.key_set
                  ? `已配置：${provider.key_masked || '••••••'}（留空则保持不变）`
                  : '未配置，粘贴 API Key 后点保存'
              }
              onChange={(e) => {
                setApiKey(e.target.value)
                setTest(null)
                verification.clearVerification()
              }}
            />
            {provider.key_set && provider.key_masked && (
              <span className="text-caption text-ink-sub">
                掩码回显（GET /api/settings）：<span className="num">{provider.key_masked}</span>
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 lg:col-span-2">
            <span className="metric-label">API Base URL</span>
            <input
              className="input num"
              type="url"
              value={baseUrl}
              placeholder="https://api.guaihub.cc/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="metric-label">默认模型</span>
            <input
              className="input num"
              value={model}
              placeholder="如 gpt-image-2"
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="metric-label">默认尺寸</span>
            <select className="input" value={size} onChange={(e) => setSize(e.target.value)}>
              {['1K', '2K', '4K'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {showPrice && (
            <label className="flex flex-col gap-1 lg:col-span-2">
              <span className="metric-label">单价（元/张）</span>
              <input
                className="input num"
                value={price}
                inputMode="decimal"
                placeholder="留空 = 未知"
                onChange={(e) => setPrice(e.target.value)}
              />
              <span className="text-caption text-ink-muted">
                未填单价时账本金额记 0，<b>不代表免费</b>
              </span>
            </label>
          )}
        </div>
      )}

      {open && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary h-8! text-body-sm" disabled={saving} onClick={save}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn btn-secondary h-8! text-body-sm"
              disabled={testing}
              onClick={runTest}
              title="POST /api/settings/test（后端按 needs_proxy 自动决定走不走代理）"
            >
              {testing ? '测试中…' : '连通性测试'}
            </button>
            {test && (
              <span className="flex items-center gap-2 text-body-sm">
                <span className={cn('status', test.ok ? 'status-success' : 'status-warn')}>
                  {test.ok ? '已连通' : '未连通'}
                </span>
                <span className="num text-ink-sub">
                  HTTP {test.status} · {test.latency_ms} ms
                </span>
                <span className="text-ink-sub">{test.message}</span>
              </span>
            )}
          </div>

          {error && (
            <div className="mt-2">
              <ErrorState compact error={error} onRetry={runTest} title="操作失败" />
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function SettingsPage() {
  const toast = useToast()
  const settings = useAsync(getSettings, [])
  const [draft, setDraft] = useState<SettingsResponse | null>(null)
  const [textKey, setTextKey] = useState('')
  const [textModel, setTextModel] = useState('')
  const [savingText, setSavingText] = useState(false)
  const [testingText, setTestingText] = useState(false)
  const [textTest, setTextTest] = useState<SettingsTestResponse | null>(null)

  // 服务器数据回来后初始化本地草稿（保存后用返回值覆盖）
  useEffect(() => {
    if (settings.data) {
      setDraft(settings.data)
      setTextModel(settings.data.text?.model ?? '')
    }
  }, [settings.data])

  const textVerification = useKeyVerification(draft?.text?.key_masked ?? '', Boolean(draft?.text?.key_set), textKey)

  useEffect(() => {
    setTextTest(null)
  }, [draft?.text?.key_masked])

  if (settings.loading && !draft) return <Loading rows={4} label="加载设置…" />
  if (settings.error && !draft) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="m-0 text-h1 font-semibold">设置</h1>
        <ErrorState
          error={settings.error}
          onRetry={settings.reload}
          title="读取设置失败（GET /api/settings）"
        />
      </div>
    )
  }
  if (!draft) return null

  const imageProviders = draft.providers ?? []

  async function saveText() {
    setSavingText(true)
    try {
      const next = await putSettings({
        provider_id: 'deepseek',
        api_key: textKey || undefined,
        model: textModel || undefined,
      })
      setDraft(next)
      setTextKey('')
      setTextTest(null)
      textVerification.clearVerification()
      toast.success('DeepSeek 已保存 —— 已热加载，无需重启')
    } catch (e) {
      toast.error('保存 DeepSeek 配置失败', (e as ApiError).detail)
    } finally {
      setSavingText(false)
    }
  }

  async function runTextTest() {
    setTestingText(true)
    try {
      const res = await testProvider('deepseek', textKey || undefined)
      setTextTest(res)
      textVerification.recordTest(res)
      res.ok ? toast.success(res.message) : toast.warn(res.message)
    } catch (e) {
      toast.error('DeepSeek 连通性测试失败', (e as ApiError).detail)
    } finally {
      setTestingText(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="m-0 text-h1 font-semibold">设置</h1>
        </div>
        <span className="flex-1" />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={settings.reload}
          title="重新读取 GET /api/settings"
        >
          重新读取
        </button>
      </div>

      {/* 生图（左）/ 文本与视觉（右）左右布局 */}
      <div className="band grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-2">
          <h2 className="m-0 text-h3 font-semibold">生图供应商（点左侧箭头展开改 key）</h2>
          {imageProviders.length === 0 ? (
            <div className="card">
              <EmptyState
                title="后端没有返回任何供应商"
                desc="GET /api/settings 的 providers 为空 —— 检查后端 config/ 里的供应商注册表，然后重新读取。"
                actionLabel="重新读取"
                onAction={settings.reload}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {imageProviders.map((p) => (
                <ProviderCard key={p.id} provider={p} onSaved={setDraft} />
              ))}
            </div>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-3">
      <h2 className="m-0 text-h3 font-semibold">文本模型（内容梳理）</h2>
      <div className="card p-4!">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="card-title m-0! text-h3">DeepSeek</h3>
          <KeyStatusBadge
            keySet={Boolean(draft.text?.key_set)}
            verification={textVerification}
            emptyHint="key 未配置（将本地规则切页兜底）"
          />
          <span className="flex-1" />
          <span className="num text-caption text-ink-sub">id: deepseek</span>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
          <label className="flex flex-col gap-1 md:col-span-2">
            <span className="metric-label">DeepSeek API Key</span>
            <input
              className="input num"
              type="password"
              autoComplete="off"
              value={textKey}
              placeholder={draft.text?.key_set ? '已配置（留空则保持不变）' : '未配置，粘贴 sk-… 后点保存'}
              onChange={(e) => {
                setTextKey(e.target.value)
                setTextTest(null)
                textVerification.clearVerification()
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="metric-label">模型名</span>
            <input
              className="input num"
              value={textModel}
              placeholder="如 deepseek-chat"
              onChange={(e) => setTextModel(e.target.value)}
            />
          </label>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary h-8! text-body-sm" disabled={savingText} onClick={saveText}>
            {savingText ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="btn btn-secondary h-8! text-body-sm"
            disabled={testingText}
            onClick={runTextTest}
          >
            {testingText ? '测试中…' : '连通性测试'}
          </button>
          {textTest && (
            <span className="flex items-center gap-2 text-body-sm">
              <span className={cn('status', textTest.ok ? 'status-success' : 'status-warn')}>
                {textTest.ok ? '已连通' : '未连通'}
              </span>
              <span className="num text-ink-sub">
                HTTP {textTest.status} · {textTest.latency_ms} ms
              </span>
              <span className="text-ink-sub">{textTest.message}</span>
            </span>
          )}
        </div>
      </div>

      <h2 className="m-0 text-h3 font-semibold">视觉模型（图片/版式识别）</h2>
      <Notice kind="info">
        备注生成、风格构建与图片重建会调用视觉模型读出画面里的文字、卡片、图表与插画区域。
        {draft.vision?.fallback
          ? ' 当前未单独填视觉 key：自动复用 GuaiHub 中转 key 做识别（默认 gemini-2.5-flash，可在下面改「默认模型」覆盖）。'
          : ' 填了百炼 Qwen-VL 的 key 时用百炼官方端点（直连）；也可把 Base URL 指向任意 OpenAI 兼容视觉端点。'}
      </Notice>
      {draft.vision ? <ProviderCard provider={draft.vision} onSaved={setDraft} showPrice={false} /> : null}

        </section>
      </div>
    </div>
  )
}
