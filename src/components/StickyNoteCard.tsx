import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage, StickyNoteViewState } from '../../shared/schema'

type StickyNoteCardProps = {
  content: string
  archivedContent?: string
  archivedViewState?: StickyNoteViewState
  language: AppLanguage
  onChange: (content: string) => void
  onViewStateChange?: (viewState: StickyNoteViewState) => void
  onDiscardArchive?: () => void
}

export function StickyNoteCard({
  content,
  archivedContent = '',
  archivedViewState,
  language,
  onChange,
  onViewStateChange,
  onDiscardArchive,
}: StickyNoteCardProps) {
  const text = getLocaleText(language)
  const [local, setLocal] = useState(content)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<string | null>(null)
  const pendingViewStateRef = useRef<StickyNoteViewState | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const shouldRestoreViewStateRef = useRef(true)
  const onChangeRef = useRef(onChange)
  const onViewStateChangeRef = useRef(onViewStateChange)
  useEffect(() => {
    onChangeRef.current = onChange
    onViewStateChangeRef.current = onViewStateChange
  })

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
    const selectionEnd = Math.min(
      contentLength,
      Math.max(selectionStart, archivedViewState.selectionEnd),
    )
    textarea.setSelectionRange(selectionStart, selectionEnd)
    textarea.scrollTop = archivedViewState.scrollTop
  }, [archivedViewState, local])

  useLayoutEffect(
    () => () => {
      rememberViewState()
      flushViewState()
    },
    [flushViewState, rememberViewState],
  )

  useEffect(() => {
    if (!timerRef.current) {
      queueMicrotask(() => {
        if (!timerRef.current) {
          setLocal(content)
        }
      })
    }
  }, [content])

  const handleChange = (value: string) => {
    setLocal(value)
    pendingRef.current = value
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      pendingRef.current = null
      onChange(value)
    }, 500)
  }

  // Flush the debounced value on unmount so closing the tab or the workspace
  // column never drops the last half second of typing.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (pendingRef.current !== null) {
      onChangeRef.current(pendingRef.current)
      pendingRef.current = null
    }
    flushViewState()
  }, [flushViewState])

  const handleRestore = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    pendingRef.current = null
    shouldRestoreViewStateRef.current = true
    setLocal(archivedContent)
    onChange(archivedContent)
  }

  const showRestoreBar = local.trim() === '' && archivedContent.trim() !== ''
  const archivePreview = archivedContent.trim().split('\n')[0].slice(0, 80)

  return (
    <div className="sticky-note-card">
      {showRestoreBar && (
        <div className="sticky-note-restore-bar">
          <div className="sticky-note-restore-text">
            <span className="sticky-note-restore-title">{text.stickyNoteRestorePrompt}</span>
            <span className="sticky-note-restore-preview">{archivePreview}</span>
          </div>
          <div className="sticky-note-restore-actions">
            <button type="button" className="sticky-note-restore-button" onClick={handleRestore}>
              {text.stickyNoteRestoreAction}
            </button>
            <button
              type="button"
              className="sticky-note-discard-button"
              onClick={() => onDiscardArchive?.()}
            >
              {text.stickyNoteDiscardAction}
            </button>
          </div>
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="sticky-note-textarea"
        value={local}
        onChange={(e) => handleChange(e.target.value)}
        onScroll={rememberViewState}
        onSelect={rememberViewState}
        onBlur={flushViewState}
        placeholder={text.stickyNotePlaceholder}
        spellCheck={false}
      />
    </div>
  )
}
