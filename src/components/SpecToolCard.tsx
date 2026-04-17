import { useEffect, useMemo, useState } from 'react'

import { buildSpecChatPrompt, buildSpecFileSet, getSpecInitialTitle } from '../../shared/spec-first'
import type { AppLanguage } from '../../shared/schema'
import { ensureSpecDocuments } from '../api'
import { getSpecToolText } from './tool-card-text'

type SpecToolCardProps = {
  title: string
  workspacePath: string
  language: AppLanguage
  onChangeTitle: (title: string) => void
  onOpenFile?: (relativePath: string) => void
  onLaunchSpec?: (payload: {
    title: string
    prompt: string
    requirementsPath: string
    designPath: string
    tasksPath: string
  }) => Promise<void>
}

export function SpecToolCard({
  title,
  workspacePath,
  language,
  onChangeTitle,
  onOpenFile,
  onLaunchSpec,
}: SpecToolCardProps) {
  const text = getSpecToolText(language)
  const [draftTitle, setDraftTitle] = useState(title || getSpecInitialTitle(language))
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [docPaths, setDocPaths] = useState<{
    requirementsPath: string
    designPath: string
    tasksPath: string
  } | null>(null)

  useEffect(() => {
    setDraftTitle(title || getSpecInitialTitle(language))
  }, [language, title])

  const normalizedTitle = useMemo(() => {
    const nextTitle = draftTitle.trim()
    return nextTitle || getSpecInitialTitle(language)
  }, [draftTitle, language])

  const fallbackFiles = useMemo(() => buildSpecFileSet(normalizedTitle), [normalizedTitle])
  const effectiveFiles = docPaths
    ? {
        ...fallbackFiles,
        ...docPaths,
      }
    : fallbackFiles

  const hasWorkspace = workspacePath.trim().length > 0

  const createDocs = async () => {
    if (!hasWorkspace) {
      setError(text.missingWorkspace)
      return null
    }

    setCreating(true)
    setError('')

    try {
      const result = await ensureSpecDocuments(workspacePath, normalizedTitle, language)
      setDocPaths({
        requirementsPath: result.requirementsPath,
        designPath: result.designPath,
        tasksPath: result.tasksPath,
      })
      if (title !== result.title) {
        onChangeTitle(result.title)
      }
      return result
    } catch (error) {
      setError(error instanceof Error && error.message.trim() ? error.message : text.genericError)
      return null
    } finally {
      setCreating(false)
    }
  }

  const handleLaunchAgent = async () => {
    const result = await createDocs()
    if (!result || !onLaunchSpec) {
      return
    }

    await onLaunchSpec({
      title: result.title,
      prompt: buildSpecChatPrompt(result, language),
      requirementsPath: result.requirementsPath,
      designPath: result.designPath,
      tasksPath: result.tasksPath,
    })
  }

  const openFile = (relativePath: string) => {
    onOpenFile?.(relativePath)
  }

  return (
    <div className="spec-tool-card">
      <div className="spec-tool-shell">
        <div className="spec-tool-header">
          <label className="spec-tool-field">
            <span className="spec-tool-label">{text.titleLabel}</span>
            <input
              className="spec-tool-input"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={() => {
                if ((title || '').trim() !== normalizedTitle) {
                  onChangeTitle(normalizedTitle)
                }
              }}
              placeholder={text.titlePlaceholder}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="spec-tool-primary"
            disabled={creating}
            onClick={() => {
              void createDocs()
            }}
          >
            {creating ? text.creating : text.startButton}
          </button>
        </div>

        <div className="spec-tool-summary">
          <p>{text.docsReady}</p>
          <p className="spec-tool-launch-hint">{text.launchHint}</p>
        </div>

        <div className="spec-tool-doc-grid">
          <button type="button" className="spec-tool-doc-card" onClick={() => openFile(effectiveFiles.requirementsPath)}>
            <span className="spec-tool-doc-label">{text.requirementsLabel}</span>
            <span className="spec-tool-doc-path">{effectiveFiles.requirementsPath}</span>
            <span className="spec-tool-doc-action">{text.openRequirements}</span>
          </button>
          <button type="button" className="spec-tool-doc-card" onClick={() => openFile(effectiveFiles.designPath)}>
            <span className="spec-tool-doc-label">{text.designLabel}</span>
            <span className="spec-tool-doc-path">{effectiveFiles.designPath}</span>
            <span className="spec-tool-doc-action">{text.openDesign}</span>
          </button>
          <button type="button" className="spec-tool-doc-card" onClick={() => openFile(effectiveFiles.tasksPath)}>
            <span className="spec-tool-doc-label">{text.tasksLabel}</span>
            <span className="spec-tool-doc-path">{effectiveFiles.tasksPath}</span>
            <span className="spec-tool-doc-action">{text.openTasks}</span>
          </button>
        </div>

        <div className="spec-tool-actions">
          <button
            type="button"
            className="spec-tool-launch"
            disabled={creating || !onLaunchSpec}
            onClick={() => {
              void handleLaunchAgent()
            }}
          >
            {text.launchAgent}
          </button>
        </div>

        {error ? (
          <div className="panel-alert" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
}
