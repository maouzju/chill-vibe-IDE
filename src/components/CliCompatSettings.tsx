import { useCallback, useEffect, useRef, useState } from 'react'

import { cliCompatNeedsAction, type CliCompatEntry, type CliCompatStatus } from '../../shared/cli-compat'
import type { AppLanguage } from '../../shared/schema'
import { fetchCliCompatStatus, installCliCompat, setCliCompatActive } from '../api'
import { AppButton } from './AppButton'

const texts = {
  'zh-CN': {
    title: 'CLI 兼容版本',
    note: '本版本 IDE 已验证兼容下列 CLI 版本。一键下载后装在 IDE 数据目录，不影响系统全局 CLI，并自动切换为使用兼容版。',
    compatible: '兼容版本',
    system: '系统 CLI',
    notFound: '未找到',
    using: '当前使用',
    usingCompat: '兼容版',
    usingSystem: '系统 CLI',
    systemIsCompat: '（已是兼容版本，无需切换）',
    download: '下载兼容版并切换',
    downloading: '下载中…',
    useCompat: '切换到兼容版',
    useSystem: '改用系统 CLI',
    failed: '下载失败：',
    outdated: '（旧兼容版 {v}）',
  },
  en: {
    title: 'CLI compatibility',
    note: 'This IDE build is verified against the CLI versions below. One click downloads it into the IDE data folder (your global CLI is untouched) and switches to it.',
    compatible: 'Compatible',
    system: 'System CLI',
    notFound: 'not found',
    using: 'In use',
    usingCompat: 'compatible build',
    usingSystem: 'system CLI',
    download: 'Download & switch',
    systemIsCompat: ' (already the compatible version, nothing to do)',
    downloading: 'Downloading…',
    useCompat: 'Use compatible build',
    useSystem: 'Use system CLI',
    failed: 'Download failed: ',
    outdated: ' (older compat build {v})',
  },
} as const

const providerLabels: Record<CliCompatEntry['provider'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

export function CliCompatSettings({
  language,
  onStatusChange,
}: {
  language: AppLanguage
  /** 让宿主（设置页的环境健康卡）与这里看到同一份状态，避免两处各拉各的、灯和按钮打架。 */
  onStatusChange?: (status: CliCompatStatus) => void
}) {
  const text = texts[language === 'zh-CN' ? 'zh-CN' : 'en']
  const [status, setStatusState] = useState<CliCompatStatus | null>(null)
  const onStatusChangeRef = useRef(onStatusChange)
  onStatusChangeRef.current = onStatusChange
  const setStatus = useCallback((next: CliCompatStatus) => {
    setStatusState(next)
    onStatusChangeRef.current?.(next)
  }, [])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await fetchCliCompatStatus()
      if (mountedRef.current) setStatus(next)
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [setStatus])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  // 下载是后台任务，进行中轮询到结束。
  const anyRunning = status?.entries.some((entry) => entry.task?.status === 'running') ?? false
  useEffect(() => {
    if (!anyRunning) return
    const timer = window.setInterval(() => void refresh(), 1500)
    return () => window.clearInterval(timer)
  }, [anyRunning, refresh])

  const run = async (action: () => Promise<CliCompatStatus>) => {
    setPending(true)
    setError(null)
    try {
      const next = await action()
      if (mountedRef.current) setStatus(next)
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (mountedRef.current) setPending(false)
    }
  }

  return (
    <div className="settings-section cli-compat-settings">
      <h3 className="settings-group-title">{text.title}</h3>
      <p className="settings-note">{text.note}</p>
      {status?.entries.map((entry) => {
        const running = entry.task?.status === 'running'
        const inUse = entry.activeVersion
          ? `${text.usingCompat} v${entry.activeVersion}${entry.active ? '' : text.outdated.replace('{v}', entry.activeVersion)}`
          : `${text.usingSystem}${cliCompatNeedsAction(entry) ? '' : text.systemIsCompat}`

        return (
          <div key={entry.provider} className="cli-compat-row" data-provider={entry.provider}>
            <p className="settings-note">
              <strong>{providerLabels[entry.provider]}</strong>
              {` · ${text.compatible} v${entry.compatibleVersion}`}
              {` · ${text.system} ${entry.systemVersion ? `v${entry.systemVersion}` : text.notFound}`}
              {` · ${text.using}: ${inUse}`}
            </p>
            <div className="settings-actions">
              {cliCompatNeedsAction(entry) && (!entry.installed || !entry.active) ? (
                entry.installed ? (
                  <AppButton
                    type="button"
                    disabled={pending}
                    onClick={() => void run(() => setCliCompatActive(entry.provider, true))}
                  >
                    {text.useCompat}
                  </AppButton>
                ) : (
                  <AppButton
                    type="button"
                    disabled={pending || running}
                    onClick={() => void run(() => installCliCompat(entry.provider))}
                  >
                    {running ? text.downloading : text.download}
                  </AppButton>
                )
              ) : null}
              {entry.activeVersion ? (
                <AppButton
                  type="button"
                  disabled={pending || running}
                  onClick={() => void run(() => setCliCompatActive(entry.provider, false))}
                >
                  {text.useSystem}
                </AppButton>
              ) : null}
            </div>
            {entry.task?.status === 'failed' ? (
              <p className="settings-note" role="alert">
                {text.failed}
                {entry.task.message}
              </p>
            ) : null}
          </div>
        )
      })}
      {error ? (
        <p className="settings-note" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
