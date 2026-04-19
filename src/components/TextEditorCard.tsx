import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchFileContent, saveFileContent } from '../api'
import type { AppLanguage, FileReadResponse } from '../../shared/schema'
import { resolveTextEditorExternalRefresh, shouldFlushTextEditorSave } from './tool-card-state'
import { getTextEditorCardText } from './tool-card-text'
import { resolveTextEditorMonacoTheme } from './text-editor-monaco-config'
import { FileTextIcon } from './Icons'

type TextEditorCardProps = {
  workspacePath: string
  filePath: string
  language: AppLanguage
}

type PersistOptions = {
  indicateSaving?: boolean
}

type TextEditorMonacoModule = typeof import('./text-editor-monaco')
type MonacoEditorInstance = import('monaco-editor').editor.IStandaloneCodeEditor
type MonacoTextModel = import('monaco-editor').editor.ITextModel
type UiTheme = 'light' | 'dark'
const TEXT_EDITOR_REFRESH_INTERVAL_MS = 2_000

const getCurrentUiTheme = (): UiTheme => {
  if (typeof document === 'undefined') {
    return 'dark'
  }

  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

const TextEditorCardInner = ({ workspacePath, filePath, language }: TextEditorCardProps) => {
  const text = getTextEditorCardText(language)
  const normalizedFilePath = filePath.trim()
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [fileLanguage, setFileLanguage] = useState('plaintext')
  const [uiTheme, setUiTheme] = useState<UiTheme>(getCurrentUiTheme)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const modelRef = useRef<MonacoTextModel | null>(null)
  const monacoModuleRef = useRef<TextEditorMonacoModule | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const contentRef = useRef('')
  const savedContentRef = useRef('')
  const suppressEditorChangeRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    const root = document.documentElement
    const observer = new MutationObserver(() => {
      setUiTheme(getCurrentUiTheme())
    })

    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    return () => {
      observer.disconnect()
    }
  }, [])

  const applyResolvedRefresh = useCallback((nextContent: string) => {
    contentRef.current = nextContent
    savedContentRef.current = nextContent

    const model = modelRef.current
    if (model && model.getValue() !== nextContent) {
      suppressEditorChangeRef.current = true
      model.setValue(nextContent)
    }

    if (mountedRef.current) {
      setContent(nextContent)
      setSavedContent(nextContent)
    }
  }, [])

  const syncFileSnapshot = useCallback((result: FileReadResponse) => {
    const refresh = resolveTextEditorExternalRefresh(
      savedContentRef.current,
      contentRef.current,
      result.content,
    )

    if (refresh) {
      applyResolvedRefresh(refresh.content)
    }

    if (mountedRef.current) {
      setFileLanguage(result.language)
      setError(null)
      setLoading(false)
    }
  }, [applyResolvedRefresh])

  useEffect(() => {
    if (!normalizedFilePath) {
      setLoading(false)
      setError(null)
      setContent('')
      setSavedContent('')
      contentRef.current = ''
      savedContentRef.current = ''
      return
    }

    let cancelled = false

    fetchFileContent(workspacePath, normalizedFilePath)
      .then((result) => {
        if (!cancelled && mountedRef.current) {
          syncFileSnapshot(result)
        }
      })
      .catch((err) => {
        if (!cancelled && mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to load file')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [normalizedFilePath, syncFileSnapshot, workspacePath])

  const refreshFileFromDisk = useCallback(async () => {
    if (!normalizedFilePath) {
      return
    }

    const result = await fetchFileContent(workspacePath, normalizedFilePath)
    if (!mountedRef.current) {
      return
    }

    syncFileSnapshot(result)
  }, [normalizedFilePath, syncFileSnapshot, workspacePath])

  const save = useCallback(async (textContent: string, options?: PersistOptions) => {
    const indicateSaving = options?.indicateSaving ?? true

    if (indicateSaving && mountedRef.current) {
      setSaving(true)
    }

    try {
      if (!normalizedFilePath) {
        return
      }

      await saveFileContent(workspacePath, normalizedFilePath, textContent)
      savedContentRef.current = textContent

      if (mountedRef.current) {
        setSavedContent(textContent)
      }
    } catch {
      // Save failures stay non-blocking so the user can retry with Ctrl+S.
    } finally {
      if (indicateSaving && mountedRef.current) {
        setSaving(false)
      }
    }
  }, [normalizedFilePath, workspacePath])

  const flushPendingSave = useCallback((options?: PersistOptions) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    if (!shouldFlushTextEditorSave(savedContentRef.current, contentRef.current)) {
      return Promise.resolve()
    }

    return save(contentRef.current, options)
  }, [save])

  const scheduleSave = useCallback((value: string) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
    }

    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      void save(value)
    }, 1500)
  }, [save])

  const handleEditorContentChange = useCallback((value: string) => {
    contentRef.current = value
    setContent(value)

    if (suppressEditorChangeRef.current) {
      suppressEditorChangeRef.current = false
      return
    }

    if (!shouldFlushTextEditorSave(savedContentRef.current, value)) {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      return
    }

    scheduleSave(value)
  }, [scheduleSave])

  useEffect(() => {
    if (loading || error || typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    const refreshIfVisible = () => {
      if (document.hidden) {
        return
      }

      void refreshFileFromDisk().catch(() => {
        // Ignore background refresh failures and keep the current editor state.
      })
    }

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshIfVisible()
      }
    }

    const interval = window.setInterval(refreshIfVisible, TEXT_EDITOR_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [error, loading, refreshFileFromDisk])

  useEffect(() => {
    if (!normalizedFilePath || loading || error || !editorContainerRef.current) {
      return
    }

    let cancelled = false
    let changeSubscription: { dispose(): void } | null = null
    let blurSubscription: { dispose(): void } | null = null

    void import('./text-editor-monaco')
      .then(async (module) => {
        if (cancelled || !mountedRef.current || !editorContainerRef.current) {
          return
        }

        monacoModuleRef.current = module
        module.ensureTextEditorMonacoEnvironment()
        module.monaco.editor.setTheme(resolveTextEditorMonacoTheme(getCurrentUiTheme()))

        const model = await module.createTextEditorModel(contentRef.current, normalizedFilePath, fileLanguage)
        if (cancelled || !mountedRef.current || !editorContainerRef.current) {
          model.dispose()
          return
        }
        modelRef.current = model

        const editor = module.monaco.editor.create(editorContainerRef.current, {
          automaticLayout: true,
          detectIndentation: false,
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 13,
          insertSpaces: true,
          lineNumbersMinChars: 3,
          minimap: { enabled: false },
          model,
          padding: { top: 8, bottom: 8 },
          scrollBeyondLastLine: false,
          tabSize: 2,
          wordWrap: 'off',
        })

        editorRef.current = editor

        changeSubscription = editor.onDidChangeModelContent(() => {
          handleEditorContentChange(editor.getValue())
        })
        blurSubscription = editor.onDidBlurEditorText(() => {
          void flushPendingSave()
        })

        editor.addCommand(
          module.monaco.KeyMod.CtrlCmd | module.monaco.KeyCode.KeyS,
          () => {
            void flushPendingSave()
          },
        )
      })
      .catch((reason) => {
        if (!cancelled && mountedRef.current) {
          setError(reason instanceof Error ? reason.message : 'Failed to load editor')
        }
      })

    return () => {
      cancelled = true
      changeSubscription?.dispose()
      blurSubscription?.dispose()
      editorRef.current?.dispose()
      editorRef.current = null
      modelRef.current?.dispose()
      modelRef.current = null
    }
  }, [error, fileLanguage, flushPendingSave, handleEditorContentChange, loading, normalizedFilePath])

  useEffect(() => {
    const monacoModule = monacoModuleRef.current
    if (!monacoModule) {
      return
    }

    monacoModule.monaco.editor.setTheme(resolveTextEditorMonacoTheme(uiTheme))
  }, [uiTheme])

  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    if (shouldFlushTextEditorSave(savedContentRef.current, contentRef.current)) {
      void save(contentRef.current, { indicateSaving: false })
    }
  }, [save])

  const isDirty = content !== savedContent

  if (!normalizedFilePath) {
    return (
      <div className="text-editor-card">
        <div className="text-editor-empty">
          <FileTextIcon className="text-editor-empty-icon" />
          <div className="text-editor-empty-title">{text.emptyTitle}</div>
          <div className="text-editor-empty-description">{text.emptyDescription}</div>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="text-editor-card">
        <div className="text-editor-loading">{text.loading}</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-editor-card">
        <div className="text-editor-error">{error}</div>
      </div>
    )
  }

  return (
    <div className="text-editor-card">
      <div className="text-editor-toolbar">
        <span className="text-editor-filepath">{filePath}</span>
        <span className="text-editor-status">
          {saving
            ? text.saving
            : isDirty
              ? text.unsaved
              : ''}
        </span>
      </div>
      <div
        ref={editorContainerRef}
        className="text-editor-surface"
      />
    </div>
  )
}

export function TextEditorCard({ workspacePath, filePath, language }: TextEditorCardProps) {
  return (
    <TextEditorCardInner
      key={`${workspacePath}\0${filePath.trim()}`}
      workspacePath={workspacePath}
      filePath={filePath}
      language={language}
    />
  )
}
