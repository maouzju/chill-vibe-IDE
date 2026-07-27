import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { getLocaleText } from '../../shared/i18n'
import type {
  AppLanguage,
  StickyNoteSummary,
  StickyNoteVersionSummary,
  StickyNoteViewState,
} from '../../shared/schema'
import {
  listStickyNotes,
  loadStickyNote,
  restoreStickyNoteVersion,
  revealStickyNoteLocation,
  saveStickyNote,
  searchStickyNotes,
} from '../api'

type StickyNoteCardProps = {
  content: string
  workspacePath: string
  noteId: string
  title: string
  archivedContent?: string
  archivedViewState?: StickyNoteViewState
  language: AppLanguage
  onChange: (content: string) => void
  onViewStateChange?: (viewState: StickyNoteViewState) => void
  onBindNote: (noteId: string, title: string, content: string) => void
  onChangeTitle: (title: string) => void
}

const checkpointDelayMs = 5_000

export function StickyNoteCard({
  content,
  workspacePath,
  noteId,
  title,
  archivedContent = '',
  archivedViewState,
  language,
  onChange,
  onViewStateChange,
  onBindNote,
  onChangeTitle,
}: StickyNoteCardProps) {
  const text = getLocaleText(language)
  const [local, setLocal] = useState(content)
  const [savedNotes, setSavedNotes] = useState<StickyNoteSummary[]>([])
  const [versions, setVersions] = useState<StickyNoteVersionSummary[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [localError, setLocalError] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<StickyNoteSummary[]>([])
  const [searching, setSearching] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkpointTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<string | null>(null)
  const pendingViewStateRef = useRef<StickyNoteViewState | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const shouldRestoreViewStateRef = useRef(true)
  const hasLocalDocumentRef = useRef(false)
  const activeNoteIdRef = useRef(noteId)
  const latestLocalRef = useRef(local)
  const latestTitleRef = useRef(title)
  const onChangeRef = useRef(onChange)
  const onViewStateChangeRef = useRef(onViewStateChange)
  const onChangeTitleRef = useRef(onChangeTitle)
  const searchRequestRef = useRef(0)

  useEffect(() => {
    onChangeRef.current = onChange
    onViewStateChangeRef.current = onViewStateChange
    onChangeTitleRef.current = onChangeTitle
    latestLocalRef.current = local
    latestTitleRef.current = title
    activeNoteIdRef.current = noteId
  })

  const refreshSavedNotes = useCallback(async () => {
    if (!workspacePath.trim()) return []
    const response = await listStickyNotes({ workspacePath })
    setSavedNotes(response.notes)
    return response.notes
  }, [workspacePath])

  const saveLocalDocument = useCallback(async (value: string, checkpoint: boolean) => {
    const effectiveNoteId = activeNoteIdRef.current.trim()
    if (!workspacePath.trim() || !effectiveNoteId) return null
    if (!hasLocalDocumentRef.current && value.trim() === '') return null

    try {
      const document = await saveStickyNote({
        workspacePath,
        noteId: effectiveNoteId,
        title: latestTitleRef.current,
        content: value,
        checkpoint,
      })
      hasLocalDocumentRef.current = true
      setVersions(document.versions)
      setLocalError('')
      void refreshSavedNotes().catch(() => undefined)
      return document
    } catch (error) {
      setLocalError(`${text.stickyNoteLocalSaveError}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }, [refreshSavedNotes, text.stickyNoteLocalSaveError, workspacePath])

  const scheduleCheckpoint = useCallback(() => {
    if (checkpointTimerRef.current) clearTimeout(checkpointTimerRef.current)
    checkpointTimerRef.current = setTimeout(() => {
      checkpointTimerRef.current = null
      void saveLocalDocument(latestLocalRef.current, true)
    }, checkpointDelayMs)
  }, [saveLocalDocument])

  useEffect(() => {
    let cancelled = false
    hasLocalDocumentRef.current = false
    activeNoteIdRef.current = noteId

    if (!workspacePath.trim() || !noteId.trim()) return () => { cancelled = true }

    void refreshSavedNotes().then(async (notes) => {
      if (cancelled) return
      if (!notes.some((entry) => entry.noteId === noteId)) {
        if (latestLocalRef.current.trim() !== '') {
          await saveLocalDocument(latestLocalRef.current, true)
        }
        return
      }

      const document = await loadStickyNote({ workspacePath, noteId })
      if (cancelled) return
      hasLocalDocumentRef.current = true
      setVersions(document.versions)
      if (document.content !== latestLocalRef.current) {
        latestLocalRef.current = document.content
        setLocal(document.content)
        onChangeRef.current(document.content)
      }
      if (document.title !== latestTitleRef.current) {
        latestTitleRef.current = document.title
        onChangeTitleRef.current(document.title)
      }
      setLocalError('')
    }).catch((error) => {
      if (!cancelled) {
        setLocalError(error instanceof Error ? error.message : String(error))
      }
    })

    return () => { cancelled = true }
  }, [noteId, refreshSavedNotes, saveLocalDocument, workspacePath])

  useEffect(() => {
    const query = searchQuery.trim()
    searchRequestRef.current += 1
    const requestId = searchRequestRef.current
    if (!query || !workspacePath.trim()) {
      setSearchResults([])
      setSearching(false)
      return
    }

    setSearching(true)
    const timer = setTimeout(() => {
      void searchStickyNotes({ workspacePath, query }).then((response) => {
        if (searchRequestRef.current !== requestId) return
        setSearchResults(response.notes)
        setSearching(false)
      }).catch((error) => {
        if (searchRequestRef.current !== requestId) return
        setSearchResults([])
        setSearching(false)
        setLocalError(error instanceof Error ? error.message : String(error))
      })
    }, 200)

    return () => clearTimeout(timer)
  }, [searchQuery, workspacePath])

  const flushViewState = useCallback(() => {
    if (viewStateTimerRef.current) clearTimeout(viewStateTimerRef.current)
    viewStateTimerRef.current = null
    if (pendingViewStateRef.current) {
      onViewStateChangeRef.current?.(pendingViewStateRef.current)
      pendingViewStateRef.current = null
    }
  }, [])

  const rememberViewState = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    pendingViewStateRef.current = {
      scrollTop: textarea.scrollTop,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    }
    if (viewStateTimerRef.current) clearTimeout(viewStateTimerRef.current)
    viewStateTimerRef.current = setTimeout(flushViewState, 250)
  }, [flushViewState])

  useLayoutEffect(() => {
    if (!shouldRestoreViewStateRef.current || !archivedViewState) return
    const textarea = textareaRef.current
    if (!textarea) return
    shouldRestoreViewStateRef.current = false
    const contentLength = textarea.value.length
    const selectionStart = Math.min(contentLength, archivedViewState.selectionStart)
    const selectionEnd = Math.min(contentLength, Math.max(selectionStart, archivedViewState.selectionEnd))
    textarea.setSelectionRange(selectionStart, selectionEnd)
    textarea.scrollTop = archivedViewState.scrollTop
  }, [archivedViewState, local])

  useEffect(() => {
    if (!timerRef.current) {
      queueMicrotask(() => {
        if (!timerRef.current && content !== latestLocalRef.current) {
          latestLocalRef.current = content
          setLocal(content)
        }
      })
    }
  }, [content])

  useEffect(() => {
    latestTitleRef.current = title
    if (hasLocalDocumentRef.current) {
      void saveLocalDocument(latestLocalRef.current, false)
    }
  }, [saveLocalDocument, title])

  const handleChange = (value: string) => {
    latestLocalRef.current = value
    setLocal(value)
    pendingRef.current = value
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      pendingRef.current = null
      onChangeRef.current(value)
      void saveLocalDocument(value, false)
    }, 500)
    scheduleCheckpoint()
  }

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (checkpointTimerRef.current) clearTimeout(checkpointTimerRef.current)
    if (pendingRef.current !== null) {
      onChangeRef.current(pendingRef.current)
      latestLocalRef.current = pendingRef.current
      pendingRef.current = null
    }
    void saveLocalDocument(latestLocalRef.current, true)
    flushViewState()
  }, [flushViewState, saveLocalDocument])

  const openSavedNote = async (summary: StickyNoteSummary) => {
    try {
      const document = await loadStickyNote({ workspacePath, noteId: summary.noteId })
      activeNoteIdRef.current = document.noteId
      hasLocalDocumentRef.current = true
      latestLocalRef.current = document.content
      latestTitleRef.current = document.title
      shouldRestoreViewStateRef.current = true
      setLocal(document.content)
      setVersions(document.versions)
      onBindNote(document.noteId, document.title, document.content)
      setSearchQuery('')
      setLocalError('')
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
      void refreshSavedNotes().catch(() => undefined)
    }
  }

  const restoreLegacyArchive = () => {
    latestLocalRef.current = archivedContent
    setLocal(archivedContent)
    onChangeRef.current(archivedContent)
    void saveLocalDocument(archivedContent, true)
  }

  const toggleHistory = async () => {
    const nextOpen = !historyOpen
    setHistoryOpen(nextOpen)
    if (!nextOpen || !hasLocalDocumentRef.current) return
    setLoadingHistory(true)
    try {
      const document = await loadStickyNote({ workspacePath, noteId: activeNoteIdRef.current })
      setVersions(document.versions)
      setLocalError('')
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingHistory(false)
    }
  }

  const restoreVersion = async (version: StickyNoteVersionSummary) => {
    setLoadingHistory(true)
    try {
      const document = await restoreStickyNoteVersion({
        workspacePath,
        noteId: activeNoteIdRef.current,
        versionId: version.id,
      })
      latestLocalRef.current = document.content
      latestTitleRef.current = document.title
      setLocal(document.content)
      setVersions(document.versions)
      onBindNote(document.noteId, document.title, document.content)
      setLocalError('')
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingHistory(false)
    }
  }

  const otherSavedNotes = useMemo(
    () => savedNotes.filter((entry) => entry.noteId !== noteId),
    [noteId, savedNotes],
  )
  const searchActive = searchQuery.trim() !== ''
  const displayedNotes = searchActive ? searchResults : otherSavedNotes
  const showExistingNotes = searchActive || (local.trim() === '' && otherSavedNotes.length > 0)
  const showLegacyRestore =
    local.trim() === '' && archivedContent.trim() !== '' && savedNotes.length === 0

  return (
    <div className="sticky-note-card">
      <div className="sticky-note-toolbar">
        <input
          type="search"
          className="sticky-note-search-input"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={text.stickyNoteSearchPlaceholder}
          aria-label={text.stickyNoteSearchPlaceholder}
          maxLength={200}
        />
        <button
          type="button"
          className="sticky-note-history-button"
          aria-expanded={historyOpen}
          onClick={() => void toggleHistory()}
        >
          {text.stickyNoteHistoryAction}
        </button>
        <button
          type="button"
          className="sticky-note-location-button"
          onClick={() => void revealStickyNoteLocation(workspacePath).catch((error) => {
            setLocalError(error instanceof Error ? error.message : String(error))
          })}
        >
          {text.stickyNoteLocationAction}
        </button>
      </div>

      {localError ? <div className="sticky-note-error" role="status">{localError}</div> : null}

      {showExistingNotes || showLegacyRestore ? (
        <div className="sticky-note-existing-panel">
          <div className="sticky-note-existing-title">
            {searchActive ? text.stickyNoteSearchResults : text.stickyNoteExistingTitle}
          </div>
          {searching ? (
            <div className="sticky-note-history-empty">{text.stickyNoteHistoryLoading}</div>
          ) : searchActive && displayedNotes.length === 0 ? (
            <div className="sticky-note-history-empty">{text.stickyNoteNoSearchResults}</div>
          ) : displayedNotes.map((entry) => (
            <button
              key={entry.noteId}
              type="button"
              className="sticky-note-existing-entry"
              onClick={() => void openSavedNote(entry)}
            >
              <span>
                <strong>{entry.title}</strong>
                <small>{entry.preview || entry.fileName}</small>
              </span>
              <span>{text.stickyNoteOpenAction}</span>
            </button>
          ))}
          {!searchActive && showLegacyRestore ? (
            <button type="button" className="sticky-note-existing-entry" onClick={restoreLegacyArchive}>
              <span>
                <strong>{text.stickyNoteRestorePrompt}</strong>
                <small>{archivedContent.trim().split('\n')[0].slice(0, 80)}</small>
              </span>
              <span>{text.stickyNoteRestoreAction}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {historyOpen ? (
        <div className="sticky-note-history-panel">
          {loadingHistory ? (
            <div className="sticky-note-history-empty">{text.stickyNoteHistoryLoading}</div>
          ) : versions.length === 0 ? (
            <div className="sticky-note-history-empty">{text.stickyNoteNoHistory}</div>
          ) : versions.map((version) => (
            <div key={version.id} className="sticky-note-history-entry">
              <div>
                <strong>{new Date(version.createdAt).toLocaleString(language)}</strong>
                <small>{version.preview || version.title}</small>
              </div>
              <button type="button" onClick={() => void restoreVersion(version)}>
                {text.stickyNoteRestoreVersionAction}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        className="sticky-note-textarea"
        value={local}
        onChange={(event) => handleChange(event.target.value)}
        onScroll={rememberViewState}
        onSelect={rememberViewState}
        onBlur={() => {
          flushViewState()
          void saveLocalDocument(latestLocalRef.current, true)
        }}
        placeholder={text.stickyNotePlaceholder}
        spellCheck={false}
      />
    </div>
  )
}
