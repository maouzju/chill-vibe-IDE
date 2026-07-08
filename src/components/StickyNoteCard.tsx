import { useEffect, useRef, useState } from 'react'

import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage } from '../../shared/schema'

type StickyNoteCardProps = {
  content: string
  archivedContent?: string
  language: AppLanguage
  onChange: (content: string) => void
  onDiscardArchive?: () => void
}

export function StickyNoteCard({
  content,
  archivedContent = '',
  language,
  onChange,
  onDiscardArchive,
}: StickyNoteCardProps) {
  const text = getLocaleText(language)
  const [local, setLocal] = useState(content)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<string | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

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
  }, [])

  const handleRestore = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    pendingRef.current = null
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
        className="sticky-note-textarea"
        value={local}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={text.stickyNotePlaceholder}
        spellCheck={false}
      />
    </div>
  )
}
