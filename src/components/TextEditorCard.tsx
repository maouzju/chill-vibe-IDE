import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import {
  fetchFileContent,
  fetchGitFileLineDiff,
  fetchGitHeadFileState,
  fetchNearestTsconfig,
  saveFileContent,
  subscribeFileChanges,
} from '../api'
import type { AppLanguage, FileReadResponse } from '../../shared/schema'
import { resolveTextEditorExternalRefresh, shouldFlushTextEditorSave } from './tool-card-state'
import { getTextEditorCardText } from './tool-card-text'
import {
  cacheTextEditorModel,
  getTextEditorModelCacheKey,
  peekCachedTextEditorModel,
  takeCachedTextEditorModel,
  type TextEditorModelCacheEntry,
} from './text-editor-model-cache'
import { getTextEditorSettings, subscribeTextEditorSettings } from './text-editor-settings'
import { mapTsconfigToMonacoCompilerOptions } from './text-editor-tsconfig'
import { resolveTextEditorMonacoTheme } from './text-editor-monaco-config'
import { FileTextIcon } from './Icons'

type TextEditorCardProps = {
  workspacePath: string
  filePath: string
  language: AppLanguage
}

type PersistOptions = {
  indicateSaving?: boolean
  force?: boolean
}

type FileGuard = { kind: 'binary' } | { kind: 'tooLarge' }

type DiffViewMode = { kind: 'conflict' } | { kind: 'head'; headContent: string }

type TextEditorMonacoModule = typeof import('./text-editor-monaco')
type MonacoEditorInstance = import('monaco-editor').editor.IStandaloneCodeEditor
type MonacoDiffEditorInstance = import('monaco-editor').editor.IStandaloneDiffEditor
type MonacoTextModel = import('monaco-editor').editor.ITextModel
type MonacoViewState = import('monaco-editor').editor.ICodeEditorViewState
type MonacoDecorationsCollection = import('monaco-editor').editor.IEditorDecorationsCollection
type CachedEditorEntry = TextEditorModelCacheEntry<MonacoTextModel, MonacoViewState>
type UiTheme = 'light' | 'dark'
const TEXT_EDITOR_GUTTER_DEBOUNCE_MS = 1_000
const TEXT_EDITOR_REFRESH_INTERVAL_MS = 2_000
// With a push watcher armed, polling is only a slow safety net.
const TEXT_EDITOR_WATCHED_REFRESH_INTERVAL_MS = 30_000
const TEXT_EDITOR_WATCH_DEBOUNCE_MS = 200

const getCurrentUiTheme = (): UiTheme => {
  if (typeof document === 'undefined') {
    return 'dark'
  }

  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

// One tsconfig application per workspace per session keeps the worker stable.
const appliedTsconfigWorkspaces = new Set<string>()

// Server encoding ids → human labels for the statusbar.
const encodingDisplayLabels: Record<string, string> = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 BOM',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
  gb18030: 'GB18030',
  big5: 'Big5',
  shiftjis: 'Shift-JIS',
  euckr: 'EUC-KR',
}

const formatEncodingLabel = (encoding: string): string =>
  encodingDisplayLabels[encoding] ?? encoding.toUpperCase()

const TextEditorCardInner = ({ workspacePath, filePath, language }: TextEditorCardProps) => {
  const text = getTextEditorCardText(language)
  const normalizedFilePath = filePath.trim()
  const modelCacheKey = getTextEditorModelCacheKey(workspacePath, normalizedFilePath)
  const editorSettings = useSyncExternalStore(
    subscribeTextEditorSettings,
    getTextEditorSettings,
    // Server snapshot keeps SSR-based component tests rendering cleanly.
    getTextEditorSettings,
  )
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [guard, setGuard] = useState<FileGuard | null>(null)
  const [isLargeFile, setIsLargeFile] = useState(false)
  const [conflictDiskContent, setConflictDiskContent] = useState<string | null>(null)
  const [fileLanguage, setFileLanguage] = useState('plaintext')
  const [uiTheme, setUiTheme] = useState<UiTheme>(getCurrentUiTheme)
  const [diffView, setDiffView] = useState<DiffViewMode | null>(null)
  const [gitTracked, setGitTracked] = useState(false)
  const [gitTick, setGitTick] = useState(0)
  const [editorTick, setEditorTick] = useState(0)
  const [cursorPosition, setCursorPosition] = useState<{ line: number; column: number } | null>(null)
  const [eol, setEol] = useState<'LF' | 'CRLF' | null>(null)
  const [fileEncoding, setFileEncoding] = useState<string | null>(null)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const diffContainerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const diffEditorRef = useRef<MonacoDiffEditorInstance | null>(null)
  const gutterDecorationsRef = useRef<MonacoDecorationsCollection | null>(null)
  const modelRef = useRef<MonacoTextModel | null>(null)
  const monacoModuleRef = useRef<TextEditorMonacoModule | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const contentRef = useRef('')
  const savedContentRef = useRef('')
  const revisionRef = useRef<string | null>(null)
  const encodingRef = useRef<string | null>(null)
  const conflictRef = useRef(false)
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

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }, [])

  const enterConflict = useCallback((diskContent: string) => {
    conflictRef.current = true
    clearSaveTimer()

    if (mountedRef.current) {
      setConflictDiskContent(diskContent)
    }
  }, [clearSaveTimer])

  const clearConflict = useCallback(() => {
    conflictRef.current = false

    if (mountedRef.current) {
      setConflictDiskContent(null)
      setDiffView((current) => (current?.kind === 'conflict' ? null : current))
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
    if (result.binary || result.tooLarge) {
      if (mountedRef.current) {
        setGuard(result.binary ? { kind: 'binary' } : { kind: 'tooLarge' })
        setError(null)
        setLoading(false)
      }
      return
    }

    const resolution = resolveTextEditorExternalRefresh(
      savedContentRef.current,
      contentRef.current,
      result.content,
    )

    if (resolution?.kind === 'conflict') {
      enterConflict(resolution.diskContent)
    } else if (resolution?.kind === 'refresh') {
      applyResolvedRefresh(resolution.content)
      revisionRef.current = result.revision ?? null
      setGitTick((tick) => tick + 1)

      if (conflictRef.current) {
        clearConflict()
      }
    } else if (!conflictRef.current) {
      // No content change; still adopt the freshest fingerprint for future saves.
      revisionRef.current = result.revision ?? revisionRef.current
    }

    // The on-disk encoding is a property of the file itself — adopt it on
    // every snapshot so saves always echo back what the read detected.
    encodingRef.current = result.encoding ?? null

    if (mountedRef.current) {
      setIsLargeFile(result.large === true)
      setFileLanguage(result.language)
      setFileEncoding(result.encoding ?? null)
      setError(null)
      setLoading(false)
    }
  }, [applyResolvedRefresh, clearConflict, enterConflict])

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

    // Restore the cached buffer (dirty edits, revision, language) before the
    // first disk read so tab switches keep unsaved work and undo history.
    const cached = peekCachedTextEditorModel(modelCacheKey) as CachedEditorEntry | undefined
    if (cached) {
      const bufferContent = cached.model.getValue()
      contentRef.current = bufferContent
      savedContentRef.current = cached.savedContent
      revisionRef.current = cached.revision
      encodingRef.current = cached.encoding
      setContent(bufferContent)
      setSavedContent(cached.savedContent)
      setFileLanguage(cached.languageId)
      setFileEncoding(cached.encoding)
      setLoading(false)
    }

    fetchFileContent(workspacePath, normalizedFilePath)
      .then((result) => {
        if (!cancelled && mountedRef.current) {
          syncFileSnapshot(result)
        }
      })
      .catch((err) => {
        // With a cached buffer the editor stays usable even if the refresh fails.
        if (!cancelled && mountedRef.current && !cached) {
          setError(err instanceof Error ? err.message : 'Failed to load file')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [modelCacheKey, normalizedFilePath, syncFileSnapshot, workspacePath])

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
    const force = options?.force ?? false

    if (!normalizedFilePath || (conflictRef.current && !force)) {
      return
    }

    if (indicateSaving && mountedRef.current) {
      setSaving(true)
    }

    try {
      const result = await saveFileContent(
        workspacePath,
        normalizedFilePath,
        textContent,
        force ? undefined : revisionRef.current ?? undefined,
        encodingRef.current ?? undefined,
      )

      if (result.conflict) {
        // Re-read the disk so the conflict banner can offer both versions.
        const diskResult = await fetchFileContent(workspacePath, normalizedFilePath).catch(() => null)
        const resolution = diskResult && !diskResult.binary && !diskResult.tooLarge
          ? resolveTextEditorExternalRefresh(savedContentRef.current, contentRef.current, diskResult.content)
          : null

        if (resolution?.kind === 'refresh') {
          // The disk already matches the local buffer — adopt it instead of alarming.
          applyResolvedRefresh(resolution.content)
          revisionRef.current = diskResult?.revision ?? null
          clearConflict()
        } else {
          enterConflict(diskResult && !diskResult.binary && !diskResult.tooLarge ? diskResult.content : '')
        }
        return
      }

      savedContentRef.current = textContent
      revisionRef.current = result.revision ?? null

      if (force) {
        clearConflict()
      }

      if (mountedRef.current) {
        setSavedContent(textContent)
        setSaveFailed(false)
        setGitTick((tick) => tick + 1)
      }
    } catch {
      // Keep the failure visible so the user can retry instead of assuming success.
      if (mountedRef.current) {
        setSaveFailed(true)
      }
    } finally {
      if (indicateSaving && mountedRef.current) {
        setSaving(false)
      }
    }
  }, [applyResolvedRefresh, clearConflict, enterConflict, normalizedFilePath, workspacePath])

  const flushPendingSave = useCallback((options?: PersistOptions) => {
    clearSaveTimer()

    if (!shouldFlushTextEditorSave(savedContentRef.current, contentRef.current)) {
      return Promise.resolve()
    }

    return save(contentRef.current, options)
  }, [clearSaveTimer, save])

  const scheduleSave = useCallback((value: string) => {
    clearSaveTimer()

    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      void save(value)
    }, 1500)
  }, [clearSaveTimer, save])

  const handleEditorContentChange = useCallback((value: string) => {
    contentRef.current = value
    setContent(value)

    if (suppressEditorChangeRef.current) {
      suppressEditorChangeRef.current = false
      return
    }

    if (conflictRef.current || !shouldFlushTextEditorSave(savedContentRef.current, value)) {
      clearSaveTimer()
      return
    }

    scheduleSave(value)
  }, [clearSaveTimer, scheduleSave])

  const keepLocalVersion = useCallback(() => {
    void save(contentRef.current, { force: true })
  }, [save])

  const openConflictDiff = useCallback(() => {
    setDiffView({ kind: 'conflict' })
  }, [])

  const openHeadDiff = useCallback(async () => {
    if (!normalizedFilePath) {
      return
    }

    try {
      const headState = await fetchGitHeadFileState(workspacePath, normalizedFilePath)
      if (!mountedRef.current || headState.headContent === null) {
        return
      }

      setDiffView({ kind: 'head', headContent: headState.headContent })
    } catch {
      // Without a HEAD version there is simply nothing to compare against.
    }
  }, [normalizedFilePath, workspacePath])

  const exitDiff = useCallback(() => {
    setDiffView(null)
  }, [])

  const toggleEol = useCallback(() => {
    const model = modelRef.current
    const monacoModule = monacoModuleRef.current
    if (!model || !monacoModule) {
      return
    }

    const next = model.getEOL() === '\n'
      ? monacoModule.monaco.editor.EndOfLineSequence.CRLF
      : monacoModule.monaco.editor.EndOfLineSequence.LF
    // setEOL rewrites every line ending, which flows through the normal
    // content-change → dirty → autosave pipeline.
    model.setEOL(next)
  }, [])

  const adoptDiskVersion = useCallback(async () => {
    if (!normalizedFilePath) {
      return
    }

    try {
      const result = await fetchFileContent(workspacePath, normalizedFilePath)
      if (!mountedRef.current) {
        return
      }

      if (result.binary || result.tooLarge) {
        setGuard(result.binary ? { kind: 'binary' } : { kind: 'tooLarge' })
        clearConflict()
        return
      }

      // Replace the buffer first — running the regular snapshot resolver here
      // would see the still-dirty local content and re-enter the conflict.
      applyResolvedRefresh(result.content)
      revisionRef.current = result.revision ?? null
      encodingRef.current = result.encoding ?? null
      setFileLanguage(result.language)
      setFileEncoding(result.encoding ?? null)
      setIsLargeFile(result.large === true)
      setGitTick((tick) => tick + 1)
      clearConflict()
    } catch {
      // Keep the conflict banner; the user can retry either action.
    }
  }, [applyResolvedRefresh, clearConflict, normalizedFilePath, workspacePath])

  const [watcherArmed, setWatcherArmed] = useState(false)

  useEffect(() => {
    if (!normalizedFilePath || loading || error || guard || typeof window === 'undefined') {
      return
    }

    let debounceTimer: number | null = null

    const unsubscribe = subscribeFileChanges(workspacePath, normalizedFilePath, () => {
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer)
      }

      debounceTimer = window.setTimeout(() => {
        debounceTimer = null
        void refreshFileFromDisk().catch(() => {
          // The slow polling safety net still covers a failed push refresh.
        })
      }, TEXT_EDITOR_WATCH_DEBOUNCE_MS)
    })

    setWatcherArmed(unsubscribe !== null)

    return () => {
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer)
      }
      unsubscribe?.()
      setWatcherArmed(false)
    }
  }, [error, guard, loading, normalizedFilePath, refreshFileFromDisk, workspacePath])

  useEffect(() => {
    if (
      loading ||
      error ||
      guard ||
      conflictDiskContent !== null ||
      (isLargeFile && !watcherArmed) ||
      typeof window === 'undefined' ||
      typeof document === 'undefined'
    ) {
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

    // Large files only refresh on push events and window focus, never on a
    // tight polling loop that would re-read megabytes every two seconds.
    const interval = isLargeFile
      ? null
      : window.setInterval(
          refreshIfVisible,
          watcherArmed ? TEXT_EDITOR_WATCHED_REFRESH_INTERVAL_MS : TEXT_EDITOR_REFRESH_INTERVAL_MS,
        )
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      if (interval !== null) {
        window.clearInterval(interval)
      }
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [conflictDiskContent, error, guard, isLargeFile, loading, refreshFileFromDisk, watcherArmed])

  useEffect(() => {
    if (!normalizedFilePath || loading || error || guard || !editorContainerRef.current) {
      return
    }

    let cancelled = false
    let changeSubscription: { dispose(): void } | null = null
    let blurSubscription: { dispose(): void } | null = null
    let cursorSubscription: { dispose(): void } | null = null

    // Claim ownership of any cached model up front; it is either adopted by the
    // editor below or handed back/disposed on every early-exit path.
    const cachedEntry = takeCachedTextEditorModel(modelCacheKey) as CachedEditorEntry | undefined

    void import('./text-editor-monaco')
      .then(async (module) => {
        if (cancelled || !mountedRef.current || !editorContainerRef.current) {
          if (cachedEntry) {
            cacheTextEditorModel(modelCacheKey, cachedEntry)
          }
          return
        }

        monacoModuleRef.current = module
        module.ensureTextEditorMonacoEnvironment()
        module.monaco.editor.setTheme(resolveTextEditorMonacoTheme(getCurrentUiTheme()))

        const model = cachedEntry && !cachedEntry.model.isDisposed()
          ? cachedEntry.model
          : await module.createTextEditorModel(contentRef.current, normalizedFilePath, fileLanguage)
        if (cancelled || !mountedRef.current || !editorContainerRef.current) {
          if (cachedEntry && model === cachedEntry.model) {
            cacheTextEditorModel(modelCacheKey, cachedEntry)
          } else {
            model.dispose()
          }
          return
        }
        modelRef.current = model

        const settings = getTextEditorSettings()
        const editor = module.monaco.editor.create(editorContainerRef.current, {
          automaticLayout: true,
          detectIndentation: false,
          folding: !isLargeFile,
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: settings.fontSize,
          insertSpaces: true,
          lineNumbersMinChars: 3,
          minimap: { enabled: settings.minimap && !isLargeFile },
          model,
          padding: { top: 8, bottom: 8 },
          scrollBeyondLastLine: false,
          tabSize: settings.tabSize,
          wordWrap: settings.wordWrap ? 'on' : 'off',
        })
        model.updateOptions({ tabSize: settings.tabSize })

        editorRef.current = editor

        if (cachedEntry && model === cachedEntry.model && cachedEntry.viewState) {
          editor.restoreViewState(cachedEntry.viewState)
        }

        changeSubscription = editor.onDidChangeModelContent(() => {
          handleEditorContentChange(editor.getValue())
          setEol(model.getEOL() === '\n' ? 'LF' : 'CRLF')
        })
        blurSubscription = editor.onDidBlurEditorText(() => {
          void flushPendingSave()
        })
        cursorSubscription = editor.onDidChangeCursorPosition((event) => {
          setCursorPosition({ line: event.position.lineNumber, column: event.position.column })
        })

        editor.addCommand(
          module.monaco.KeyMod.CtrlCmd | module.monaco.KeyCode.KeyS,
          () => {
            void flushPendingSave()
          },
        )

        const initialPosition = editor.getPosition()
        setCursorPosition(
          initialPosition
            ? { line: initialPosition.lineNumber, column: initialPosition.column }
            : { line: 1, column: 1 },
        )
        setEol(model.getEOL() === '\n' ? 'LF' : 'CRLF')
        setEditorTick((tick) => tick + 1)
      })
      .catch((reason) => {
        if (cachedEntry && modelRef.current !== cachedEntry.model && !cachedEntry.model.isDisposed()) {
          cacheTextEditorModel(modelCacheKey, cachedEntry)
        }
        if (!cancelled && mountedRef.current) {
          setError(reason instanceof Error ? reason.message : 'Failed to load editor')
        }
      })

    return () => {
      cancelled = true
      changeSubscription?.dispose()
      blurSubscription?.dispose()
      cursorSubscription?.dispose()
      gutterDecorationsRef.current = null

      const editor = editorRef.current
      const model = modelRef.current

      if (editor && model && !model.isDisposed()) {
        // Park the model (undo stack, buffer) and view state (cursor, scroll)
        // so reopening this file restores the full editing session.
        cacheTextEditorModel(modelCacheKey, {
          model,
          viewState: editor.saveViewState(),
          revision: revisionRef.current,
          savedContent: savedContentRef.current,
          languageId: model.getLanguageId(),
          encoding: encodingRef.current,
        })
        editor.dispose()
      } else {
        editor?.dispose()
        if (model && !model.isDisposed()) {
          model.dispose()
        }
      }

      editorRef.current = null
      modelRef.current = null
    }
  }, [error, fileLanguage, flushPendingSave, guard, handleEditorContentChange, isLargeFile, loading, modelCacheKey, normalizedFilePath])

  useEffect(() => {
    const monacoModule = monacoModuleRef.current
    if (!monacoModule) {
      return
    }

    monacoModule.monaco.editor.setTheme(resolveTextEditorMonacoTheme(uiTheme))
  }, [uiTheme])

  // Feed the workspace tsconfig into the TS/JS workers for project-aware
  // diagnostics (target, jsx, strict, paths) — light semantics, not a full LSP.
  useEffect(() => {
    if (
      editorTick === 0 ||
      (fileLanguage !== 'typescript' && fileLanguage !== 'javascript') ||
      appliedTsconfigWorkspaces.has(workspacePath)
    ) {
      return
    }

    appliedTsconfigWorkspaces.add(workspacePath)

    void fetchNearestTsconfig(workspacePath, normalizedFilePath)
      .then((result) => {
        // The mapper only emits enum numbers, booleans, strings, and the paths
        // record, all of which are valid CompilerOptionsValue shapes.
        const mapped = mapTsconfigToMonacoCompilerOptions(
          result.compilerOptions,
        ) as import('monaco-editor').typescript.CompilerOptions
        // Monaco ≥0.55 exposes the TS language service on the top-level
        // `typescript` namespace; `languages.typescript` is a deprecated stub.
        const typescriptApi = monacoModuleRef.current?.monaco.typescript
        if (Object.keys(mapped).length === 0 || !typescriptApi) {
          return
        }

        typescriptApi.typescriptDefaults.setCompilerOptions({
          ...typescriptApi.typescriptDefaults.getCompilerOptions(),
          ...mapped,
        })
        typescriptApi.javascriptDefaults.setCompilerOptions({
          ...typescriptApi.javascriptDefaults.getCompilerOptions(),
          ...mapped,
        })
      })
      .catch(() => {
        // Allow a retry on the next editor mount for this workspace.
        appliedTsconfigWorkspaces.delete(workspacePath)
      })
  }, [editorTick, fileLanguage, normalizedFilePath, workspacePath])

  // Settings changes flow through updateOptions so the editor never rebuilds.
  useEffect(() => {
    if (editorTick === 0) {
      return
    }

    editorRef.current?.updateOptions({
      fontSize: editorSettings.fontSize,
      minimap: { enabled: editorSettings.minimap && !isLargeFile },
      wordWrap: editorSettings.wordWrap ? 'on' : 'off',
    })
    modelRef.current?.updateOptions({ tabSize: editorSettings.tabSize })
  }, [editorSettings, editorTick, isLargeFile])

  // ── Git gutter decorations ────────────────────────────────────────────────
  useEffect(() => {
    if (editorTick === 0 || !normalizedFilePath || loading || error || guard) {
      return
    }

    let cancelled = false

    const timer = window.setTimeout(() => {
      void fetchGitFileLineDiff(workspacePath, normalizedFilePath)
        .then((diff) => {
          if (cancelled || !mountedRef.current) {
            return
          }

          setGitTracked(diff.tracked)

          const editor = editorRef.current
          const monacoModule = monacoModuleRef.current
          if (!editor || !monacoModule) {
            return
          }

          if (!diff.tracked) {
            gutterDecorationsRef.current?.clear()
            return
          }

          const { Range } = monacoModule.monaco
          const decorations = [
            ...diff.added.map((range) => ({
              range: new Range(range.start, 1, range.end, 1),
              options: { linesDecorationsClassName: 'text-editor-gutter-added' },
            })),
            ...diff.modified.map((range) => ({
              range: new Range(range.start, 1, range.end, 1),
              options: { linesDecorationsClassName: 'text-editor-gutter-modified' },
            })),
            ...diff.removed.map((line) => {
              const anchor = Math.max(line, 1)
              return {
                range: new Range(anchor, 1, anchor, 1),
                options: { linesDecorationsClassName: 'text-editor-gutter-removed' },
              }
            }),
          ]

          gutterDecorationsRef.current ??= editor.createDecorationsCollection()
          gutterDecorationsRef.current.set(decorations)
        })
        .catch(() => {
          // Gutter decorations are best-effort; the editor works fine without them.
        })
    }, TEXT_EDITOR_GUTTER_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [editorTick, error, gitTick, guard, loading, normalizedFilePath, workspacePath])

  // ── Diff view (conflict + vs HEAD) ────────────────────────────────────────
  useEffect(() => {
    if (!diffView || !diffContainerRef.current) {
      return
    }

    let cancelled = false
    let diffEditor: MonacoDiffEditorInstance | null = null
    let originalModel: MonacoTextModel | null = null

    const originalContent = diffView.kind === 'conflict'
      ? conflictDiskContent ?? ''
      : diffView.headContent

    void import('./text-editor-monaco')
      .then(async (module) => {
        if (cancelled || !mountedRef.current || !diffContainerRef.current || !modelRef.current) {
          return
        }

        originalModel = await module.createTextEditorInMemoryModel(originalContent, fileLanguage)
        if (cancelled || !mountedRef.current || !diffContainerRef.current || !modelRef.current) {
          originalModel.dispose()
          originalModel = null
          return
        }

        diffEditor = module.monaco.editor.createDiffEditor(diffContainerRef.current, {
          automaticLayout: true,
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 13,
          minimap: { enabled: false },
          originalEditable: false,
          readOnly: false,
          renderSideBySide: true,
          scrollBeyondLastLine: false,
        })
        diffEditor.setModel({ original: originalModel, modified: modelRef.current })
        diffEditorRef.current = diffEditor
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) {
          setDiffView(null)
        }
      })

    return () => {
      cancelled = true
      diffEditorRef.current = null
      diffEditor?.dispose()
      originalModel?.dispose()
    }
  }, [conflictDiskContent, diffView, fileLanguage])

  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    // A pending conflict means a blind unmount save could overwrite external edits.
    if (!conflictRef.current && shouldFlushTextEditorSave(savedContentRef.current, contentRef.current)) {
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

  if (guard) {
    return (
      <div className="text-editor-card">
        <div className="text-editor-toolbar">
          <span className="text-editor-filepath">{filePath}</span>
        </div>
        <div className="text-editor-empty">
          <FileTextIcon className="text-editor-empty-icon" />
          <div className="text-editor-empty-title">
            {guard.kind === 'binary' ? text.binaryTitle : text.tooLargeTitle}
          </div>
          <div className="text-editor-empty-description">
            {guard.kind === 'binary' ? text.binaryDescription : text.tooLargeDescription}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="text-editor-card">
      <div className="text-editor-toolbar">
        <span className="text-editor-filepath">{filePath}</span>
        <div className="text-editor-toolbar-actions">
          {diffView !== null ? (
            <button type="button" className="text-editor-toolbar-button" onClick={exitDiff}>
              {text.exitDiff}
            </button>
          ) : gitTracked ? (
            <button
              type="button"
              className="text-editor-toolbar-button"
              onClick={() => void openHeadDiff()}
            >
              {text.compareWithHead}
            </button>
          ) : null}
          <span className="text-editor-status">
            {saving ? (
              text.saving
            ) : saveFailed ? (
              <button
                type="button"
                className="text-editor-save-retry"
                onClick={() => void flushPendingSave()}
              >
                {text.saveFailed} — {text.retry}
              </button>
            ) : isDirty ? (
              text.unsaved
            ) : (
              ''
            )}
          </span>
        </div>
      </div>
      {conflictDiskContent !== null && (
        <div className="text-editor-conflict" role="alert">
          <span className="text-editor-conflict-message">{text.conflictMessage}</span>
          <div className="text-editor-conflict-actions">
            {diffView?.kind !== 'conflict' && (
              <button
                type="button"
                className="text-editor-conflict-button"
                onClick={openConflictDiff}
              >
                {text.conflictViewDiff}
              </button>
            )}
            <button
              type="button"
              className="text-editor-conflict-button"
              onClick={() => void adoptDiskVersion()}
            >
              {text.conflictTakeDisk}
            </button>
            <button
              type="button"
              className="text-editor-conflict-button is-primary"
              onClick={keepLocalVersion}
            >
              {text.conflictKeepMine}
            </button>
          </div>
        </div>
      )}
      <div
        ref={editorContainerRef}
        className={diffView === null ? 'text-editor-surface' : 'text-editor-surface is-hidden'}
      />
      {diffView !== null && (
        <div
          ref={diffContainerRef}
          className="text-editor-diff-surface"
        />
      )}
      <div className="text-editor-statusbar">
        <span className="text-editor-statusbar-item">
          {cursorPosition ? `${cursorPosition.line}:${cursorPosition.column}` : ''}
        </span>
        <span className="text-editor-statusbar-spacer" />
        {fileEncoding !== null && (
          <span className="text-editor-statusbar-item">{formatEncodingLabel(fileEncoding)}</span>
        )}
        <span className="text-editor-statusbar-item">{fileLanguage}</span>
        {eol !== null && (
          <button
            type="button"
            className="text-editor-statusbar-button"
            title={text.switchEol}
            onClick={toggleEol}
          >
            {eol}
          </button>
        )}
      </div>
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
