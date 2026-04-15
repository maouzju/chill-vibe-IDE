import { useEffect, useRef, useState } from 'react'

import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage } from '../../shared/schema'

type StickyNoteCardProps = {
  content: string
  language: AppLanguage
  onChange: (content: string) => void
}

export function StickyNoteCard({ content, language, onChange }: StickyNoteCardProps) {
  const text = getLocaleText(language)
  const [local, setLocal] = useState(content)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      onChange(value)
    }, 500)
  }

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  return (
    <div className="sticky-note-card">
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
