import { useMemo } from 'react'

import type { AppLanguage } from '../../shared/schema'
import { getGitLocaleText } from '../../shared/i18n'
import type { GitAgentPhase } from './git-operation-hub'
import { GitAgentStrategyList } from './GitAgentStrategyList'
import type { CommitStrategy } from './git-agent-panel-utils'

// 纯展示组件：分析/执行的生命周期由 git-operation-hub 持有，
// 卡片 unmount/remount 不影响后台操作，这里只渲染 hub 快照里的阶段。
type GitAgentPanelProps = {
  phase: GitAgentPhase
  language: AppLanguage
  onExecute: (strategy: CommitStrategy, index: number) => void
  onRetry: () => void
  onClose: () => void
}

export const GitAgentPanel = ({
  phase,
  language,
  onExecute,
  onRetry,
  onClose,
}: GitAgentPanelProps) => {
  const text = useMemo(() => getGitLocaleText(language), [language])

  return (
    <div className="git-agent-panel">
      {phase.kind === 'idle' || phase.kind === 'analyzing' ? (
        <div className="git-agent-loading" role="status" aria-live="polite">
          <span>{text.analyzing}</span>
          <span className="streaming-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      ) : null}

      {phase.kind === 'result' ? (
        <>
          <GitAgentStrategyList
            data={phase.data}
            title={text.agentSuggestion}
            commitAllLabel={text.agentCommitAll}
            commitPartialLabel={text.agentCommitPartial}
            onExecute={onExecute}
          />
          <button type="button" className="git-tool-button" onClick={onClose}>
            {text.cancelStrategy}
          </button>
        </>
      ) : null}

      {phase.kind === 'executing' ? (
        <div className="git-agent-loading" role="status" aria-live="polite">
          <span>{phase.progress || text.analyzing}</span>
          <span className="streaming-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      ) : null}

      {phase.kind === 'done' ? (
        <div className={`git-tool-notice is-${phase.success ? 'success' : 'error'}`} role="status">
          {phase.message}
          <button type="button" className="git-tool-button" onClick={onClose}>
            {text.closeFullGit}
          </button>
        </div>
      ) : null}

      {phase.kind === 'error' ? (
        <div className="git-tool-notice is-error" role="alert">
          {phase.message}
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
