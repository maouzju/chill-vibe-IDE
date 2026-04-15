import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  commitGitChanges,
  flashWindowOnce,
  openChatStream,
  requestChat,
  setGitStage,
  stopChat,
  type ChatStreamSource,
} from '../api'
import type { AppLanguage, GitStatus } from '../../shared/schema'
import { getGitLocaleText } from '../../shared/i18n'
import { getDefaultReasoningEffort } from '../../shared/reasoning'
import {
  getGitAgentAnalysisTimeouts,
  refreshGitAgentAnalysisTimeout,
  settleGitAgentAnalysisStream,
} from './git-agent-stream'
import { errorMessage } from './git-utils'
import { GitAgentStrategyList } from './GitAgentStrategyList'
import {
  buildAnalysisPrompt,
  parseAnalysisResult,
  type AnalysisResult,
  type CommitStrategy,
} from './git-agent-panel-utils'

type AgentPhase =
  | { kind: 'idle' }
  | { kind: 'analyzing'; streamId: string }
  | { kind: 'result'; data: AnalysisResult }
  | { kind: 'executing'; strategyIndex: number; progress: string }
  | { kind: 'done'; success: boolean; message: string }
  | { kind: 'error'; message: string }

type GitAgentPanelProps = {
  gitStatus: GitStatus
  workspacePath: string
  language: AppLanguage
  gitAgentModel: string
  systemPrompt: string
  onClose: () => void
  onStatusChange: (status: GitStatus) => void
  onAnalysisPendingChange?: (pending: boolean) => void
}

export const GitAgentPanel = ({
  gitStatus,
  workspacePath,
  language,
  gitAgentModel,
  systemPrompt,
  onClose,
  onStatusChange,
  onAnalysisPendingChange,
}: GitAgentPanelProps) => {
  const text = useMemo(() => getGitLocaleText(language), [language])
  const [phase, setPhase] = useState<AgentPhase>({ kind: 'idle' })
  const accumulatedContent = useRef('')
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const doneRef = useRef(false)
  const streamSourceRef = useRef<ChatStreamSource | null>(null)

  const startAnalysis = useCallback(async () => {
    if (!workspacePath.trim()) return

    accumulatedContent.current = ''
    doneRef.current = false
    streamSourceRef.current?.close()
    streamSourceRef.current = null

    try {
      const prompt = buildAnalysisPrompt(gitStatus, language)
      const parts = gitAgentModel.trim().split(/\s+/)
      const model = parts[0] || ''
      const reasoningEffort = parts[1] || getDefaultReasoningEffort('codex')
      const result = await requestChat({
        provider: 'codex',
        workspacePath,
        language,
        systemPrompt,
        prompt,
        model,
        reasoningEffort,
        sandboxMode: 'read-only',
        thinkingEnabled: true,
        planMode: false,
        attachments: [],
      })

      setPhase({ kind: 'analyzing', streamId: result.streamId })

      const { firstByteTimeoutMs, stallTimeoutMs } = getGitAgentAnalysisTimeouts(gitStatus.changes.length)
      const handleAnalysisTimeout = () => {
        if (doneRef.current) return

        settleGitAgentAnalysisStream({
          streamSourceRef,
          timeoutRef,
          doneRef,
        })
        void stopChat(result.streamId).catch(() => {})
        setPhase({
          kind: 'error',
          message: language === 'zh-CN' ? '分析超时，请重试。' : 'Analysis timed out. Please try again.',
        })
      }

      refreshGitAgentAnalysisTimeout({
        timeoutRef,
        doneRef,
        timeoutMs: firstByteTimeoutMs,
        onTimeout: handleAnalysisTimeout,
      })

      streamSourceRef.current = openChatStream(result.streamId, {
        onSession: () => {
          refreshGitAgentAnalysisTimeout({
            timeoutRef,
            doneRef,
            timeoutMs: firstByteTimeoutMs,
            onTimeout: handleAnalysisTimeout,
          })
        },
        onDelta: (payload) => {
          accumulatedContent.current += payload.content
          refreshGitAgentAnalysisTimeout({
            timeoutRef,
            doneRef,
            timeoutMs: stallTimeoutMs,
            onTimeout: handleAnalysisTimeout,
          })
        },
        onAssistantMessage: (payload) => {
          accumulatedContent.current = payload.content
          refreshGitAgentAnalysisTimeout({
            timeoutRef,
            doneRef,
            timeoutMs: stallTimeoutMs,
            onTimeout: handleAnalysisTimeout,
          })
        },
        onActivity: () => {
          refreshGitAgentAnalysisTimeout({
            timeoutRef,
            doneRef,
            timeoutMs: stallTimeoutMs,
            onTimeout: handleAnalysisTimeout,
          })
        },
        onLog: () => {
          refreshGitAgentAnalysisTimeout({
            timeoutRef,
            doneRef,
            timeoutMs: stallTimeoutMs,
            onTimeout: handleAnalysisTimeout,
          })
        },
        onDone: () => {
          settleGitAgentAnalysisStream({
            streamSourceRef,
            timeoutRef,
            doneRef,
          })
          void flashWindowOnce().catch(() => undefined)

          const data = parseAnalysisResult(accumulatedContent.current)
          if (data) {
            setPhase({ kind: 'result', data })
            return
          }

          setPhase({
            kind: 'error',
            message:
              language === 'zh-CN'
                ? '无法解析 Agent 返回的结果，请手动操作。'
                : 'Could not parse agent result. Please commit manually.',
          })
        },
        onError: (payload) => {
          settleGitAgentAnalysisStream({
            streamSourceRef,
            timeoutRef,
            doneRef,
          })
          setPhase({
            kind: 'error',
            message: payload.message || text.commitError,
          })
        },
      })
    } catch (error) {
      settleGitAgentAnalysisStream({
        streamSourceRef,
        timeoutRef,
        doneRef,
      })
      setPhase({
        kind: 'error',
        message: errorMessage(
          error,
          language === 'zh-CN' ? '无法启动分析。' : 'Unable to start analysis.',
        ),
      })
    }
  }, [gitAgentModel, gitStatus, language, systemPrompt, text.commitError, workspacePath])

  useEffect(() => {
    void startAnalysis()
    return () => {
      settleGitAgentAnalysisStream({
        streamSourceRef,
        timeoutRef,
        doneRef,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    onAnalysisPendingChange?.(phase.kind === 'idle' || phase.kind === 'analyzing')

    return () => {
      onAnalysisPendingChange?.(false)
    }
  }, [onAnalysisPendingChange, phase.kind])

  const executeStrategy = async (strategy: CommitStrategy, index: number) => {
    if (!workspacePath.trim()) return
    setPhase({ kind: 'executing', strategyIndex: index, progress: '' })

    let latestStatus = gitStatus

    try {
      for (let i = 0; i < strategy.commits.length; i++) {
        const commit = strategy.commits[i]!
        const progressLabel = `${i + 1}/${strategy.commits.length}: ${commit.summary}`
        setPhase({ kind: 'executing', strategyIndex: index, progress: progressLabel })

        latestStatus = await setGitStage({
          workspacePath,
          paths: commit.paths,
          staged: true,
        })

        const result = await commitGitChanges({
          workspacePath,
          summary: commit.summary,
          description: '',
        })
        latestStatus = result.status
      }

      startTransition(() => {
        onStatusChange(latestStatus)
        setPhase({
          kind: 'done',
          success: true,
          message:
            language === 'zh-CN'
              ? `已按策略完成 ${strategy.commits.length} 个提交。`
              : `Completed ${strategy.commits.length} commits per strategy.`,
        })
      })
    } catch (error) {
      onStatusChange(latestStatus)
      setPhase({
        kind: 'error',
        message: errorMessage(
          error,
          language === 'zh-CN' ? '执行策略时出错。' : 'Error executing strategy.',
        ),
      })
    }
  }

  return (
    <div className="git-agent-panel">
      {phase.kind === 'idle' || phase.kind === 'analyzing' ? (
        <div className="git-agent-loading">
          <span>{text.analyzing}</span>
        </div>
      ) : null}

      {phase.kind === 'result' ? (
        <>
          <GitAgentStrategyList
            data={phase.data}
            title={text.agentSuggestion}
            commitAllLabel={text.agentCommitAll}
            commitPartialLabel={text.agentCommitPartial}
            onExecute={(strategy, index) => {
              void executeStrategy(strategy, index)
            }}
          />
          <button type="button" className="git-tool-button" onClick={onClose}>
            {text.cancelStrategy}
          </button>
        </>
      ) : null}

      {phase.kind === 'executing' ? (
        <div className="git-agent-loading">
          <span>{phase.progress || text.analyzing}</span>
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
            <button type="button" className="git-tool-button" onClick={() => void startAnalysis()}>
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
