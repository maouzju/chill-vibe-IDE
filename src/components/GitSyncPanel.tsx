import { useMemo } from 'react'

import type { AppLanguage } from '../../shared/schema'
import { getGitLocaleText } from '../../shared/i18n'
import type { GitSyncStep } from './git-operation-hub'

// 纯展示组件：pull/push 的状态机由 git-operation-hub 持有，
// 卡片切到后台或被 unmount 时同步照常进行，这里只渲染 hub 快照里的步骤。
// 冲突不在这里处理：hub 会把它交给一个新开的可见会话（SPEC git-sync-conflict-session）。
type GitSyncPanelProps = {
  step: GitSyncStep
  language: AppLanguage
  onRetry: () => void
  onClose: () => void
}

export const GitSyncPanel = ({ step, language, onRetry, onClose }: GitSyncPanelProps) => {
  const text = useMemo(() => getGitLocaleText(language), [language])

  const stepLabel =
    step.kind === 'pull' ? text.syncStepPull
      : step.kind === 'push' ? text.syncStepPush
        : ''

  return (
    <div className="git-agent-panel">
      {(step.kind === 'pull' || step.kind === 'push') ? (
        <div className="git-agent-loading">
          <span>{stepLabel}</span>
        </div>
      ) : null}

      {step.kind === 'error' ? (
        <div className="git-tool-notice is-error" role="alert">
          {step.message}
          <div className="git-agent-error-actions">
            <button type="button" className="git-tool-button" onClick={onRetry}>
              {text.refresh}
            </button>
            <button type="button" className="git-tool-button" onClick={onClose}>
              {text.cancelStrategy}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
