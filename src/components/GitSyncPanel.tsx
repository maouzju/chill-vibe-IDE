import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  flashWindowOnce,
  fetchGitStatus,
  openChatStream,
  pullGitChanges,
  pushGitChanges,
  requestChat,
  stopChat,
} from '../api'
import type { AppLanguage, GitStatus } from '../../shared/schema'
import { getGitLocaleText } from '../../shared/i18n'
import { getDefaultReasoningEffort } from '../../shared/reasoning'
import { errorMessage } from './git-utils'

type SyncStep =
  | { kind: 'pull' }
  | { kind: 'conflict'; streamId: string }
  | { kind: 'push' }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }

type GitSyncPanelProps = {
  gitStatus: GitStatus
  workspacePath: string
  language: AppLanguage
  gitAgentModel: string
  systemPrompt: string
  crossProviderSkillReuseEnabled: boolean
  onClose: () => void
  onStatusChange: (status: GitStatus) => void
}

export const GitSyncPanel = ({
  gitStatus,
  workspacePath,
  language,
  gitAgentModel,
  systemPrompt,
  crossProviderSkillReuseEnabled,
  onClose,
  onStatusChange,
}: GitSyncPanelProps) => {
  const text = useMemo(() => getGitLocaleText(language), [language])
  const [step, setStep] = useState<SyncStep>({ kind: 'pull' })
  const startedRef = useRef(false)

  const resolveConflicts = useCallback((conflictStatus: GitStatus): Promise<GitStatus> => {
    return new Promise((resolve, reject) => {
      const conflictFiles = conflictStatus.changes
        .filter((c) => c.conflicted)
        .map((c) => c.path)
        .join(', ')

      const prompt = language === 'zh-CN'
        ? `当前 Git 仓库在 pull 后出现了合并冲突。请自动解决以下文件的冲突，保留双方有意义的改动，然后执行 git add 暂存已解决的文件；如果 Git 仍处于合并中，请完成合并提交，让仓库恢复到可以 push 的状态：\n冲突文件: ${conflictFiles}`
        : `The Git repository has merge conflicts after pulling. Please automatically resolve the conflicts in these files, keep the meaningful changes from both sides, run git add to stage the resolved files, and if Git is still mid-merge, complete the merge commit so the repository is ready to push:\nConflict files: ${conflictFiles}`

      const agentParts = gitAgentModel.trim().split(/\s+/)
      void requestChat({
        provider: 'codex',
        workspacePath,
        language,
        systemPrompt,
        crossProviderSkillReuseEnabled,
        prompt,
        model: agentParts[0] || '',
        reasoningEffort: agentParts[1] || getDefaultReasoningEffort('codex'),
        thinkingEnabled: true,
        planMode: false,
        attachments: [],
      }).then((result) => {
        setStep({ kind: 'conflict', streamId: result.streamId })

        let settled = false
        let source: ReturnType<typeof openChatStream> | null = null
        const timeout = setTimeout(() => {
          settled = true
          source?.close()
          void stopChat(result.streamId).catch(() => {})
          reject(new Error(language === 'zh-CN' ? '冲突解决超时。' : 'Conflict resolution timed out.'))
        }, 60000)

        source = openChatStream(result.streamId, {
          onDone: () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            source?.close()
            void flashWindowOnce().catch(() => undefined)
            void fetchGitStatus(workspacePath).then(resolve, reject)
          },
          onError: (payload) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            source?.close()
            reject(new Error(payload.message || text.syncError))
          },
        })
      }).catch(reject)
    })
  }, [
    crossProviderSkillReuseEnabled,
    gitAgentModel,
    language,
    systemPrompt,
    text.syncError,
    workspacePath,
  ])

  const runSync = useCallback(async () => {
    setStep({ kind: 'pull' })
    let latestStatus = gitStatus
    let pullFailedMessage = ''

    try {
      const pullResult = await pullGitChanges({ workspacePath })
      latestStatus = pullResult.status
      startTransition(() => onStatusChange(latestStatus))
    } catch (error) {
      pullFailedMessage = errorMessage(error, text.pullError)

      try {
        latestStatus = await fetchGitStatus(workspacePath)
        startTransition(() => onStatusChange(latestStatus))
      } catch {
        setStep({ kind: 'error', message: pullFailedMessage })
        return
      }

      if (!latestStatus.hasConflicts) {
        setStep({ kind: 'error', message: pullFailedMessage })
        return
      }
    }

    if (latestStatus.hasConflicts) {
      try {
        latestStatus = await resolveConflicts(latestStatus)
        startTransition(() => onStatusChange(latestStatus))
      } catch (error) {
        setStep({ kind: 'error', message: errorMessage(error, text.syncError) })
        return
      }

      if (latestStatus.hasConflicts) {
        setStep({
          kind: 'error',
          message:
            language === 'zh-CN'
              ? '冲突仍未解决，请先手动完成合并后再同步。'
              : 'Merge conflicts are still present. Finish the merge manually before syncing again.',
        })
        return
      }
    }

    setStep({ kind: 'push' })
    try {
      const pushResult = await pushGitChanges({ workspacePath })
      latestStatus = pushResult.status
      startTransition(() => onStatusChange(latestStatus))
      setStep({ kind: 'done', message: text.syncSuccess })
    } catch (error) {
      setStep({ kind: 'error', message: errorMessage(error, text.pushError) })
    }
  }, [gitStatus, language, onStatusChange, resolveConflicts, text.pullError, text.pushError, text.syncError, text.syncSuccess, workspacePath])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    // Mount-driven sync kickoff is intentional here; retries happen from explicit user actions.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runSync()
  }, [runSync])

  const stepLabel =
    step.kind === 'pull' ? text.syncStepPull
      : step.kind === 'conflict' ? text.syncConflictResolving
        : step.kind === 'push' ? text.syncStepPush
          : ''

  return (
    <div className="git-agent-panel">
      {(step.kind === 'pull' || step.kind === 'conflict' || step.kind === 'push') ? (
        <div className="git-agent-loading">
          <span>{stepLabel}</span>
        </div>
      ) : null}

      {step.kind === 'done' ? (
        <div className="git-tool-notice is-success" role="status">
          {step.message}
          <button type="button" className="git-tool-button" onClick={onClose}>
            {text.closeFullGit}
          </button>
        </div>
      ) : null}

      {step.kind === 'error' ? (
        <div className="git-tool-notice is-error" role="alert">
          {step.message}
          <div className="git-agent-error-actions">
            <button
              type="button"
              className="git-tool-button"
              onClick={() => {
                startedRef.current = false
                void runSync()
              }}
            >
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
