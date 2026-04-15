import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchFileContent, saveFileContent } from '../api'
import type { AppLanguage } from '../../shared/schema'
import { shouldFlushTextEditorSave } from './tool-card-state'
import { getTextEditorCardText } from './tool-card-text'
import { resolveTextEditorMonacoTheme } from './text-editor-monaco-config'

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

const getCurrentUiTheme = (): UiTheme => {
  if (typeof document === 'undefined') {
    return 'dark'
  }

  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

const TextEditorCardInner = ({ workspacePath, filePath, language }: TextEditorCardProps) => {
  const text = getTextEditorCardText(language)
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

  useEffect(() => {
    let cancelled = false

    fetchFileContent(workspacePath, filePath)
      .then((result) => {
        if (!cancelled && mountedRef.current) {
          contentRef.current = result.content
          savedContentRef.current = result.content
          setContent(result.content)
          setSavedContent(result.content)
          setFileLanguage(result.language)
          setError(null)
          setLoading(false)
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
  }, [filePath, workspacePath])

  const save = useCallback(async (textContent: string, options?: PersistOptions) => {
    const indicateSaving = options?.indicateSaving ?? true

    if (indicateSaving && mountedRef.current) {
      setSaving(true)
    }

    try {
      await saveFileContent(workspacePath, filePath, textContent)
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
  }, [filePath, workspacePath])

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
    scheduleSave(value)
  }, [scheduleSave])

  useEffect(() => {
    if (loading || error || !editorContainerRef.current) {
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

        const model = await module.createTextEditorModel(contentRef.current, filePath, fileLanguage)
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
  }, [error, fileLanguage, filePath, flushPendingSave, handleEditorContentChange, loading])

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
      key={`${workspacePath}\0${filePath}`}
      workspacePath={workspacePath}
      filePath={filePath}
      language={language}
    />
  )
}
