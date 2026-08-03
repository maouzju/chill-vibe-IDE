import {
  type ClipboardEvent as ReactClipboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { getImageAttachmentUrl } from '../../shared/chat-attachments'
import {
  createImageAttachmentClipboardHtml,
  parseImageAttachmentsFromClipboardHtml,
} from '../../shared/image-attachment-clipboard'
import { getLocaleText } from '../../shared/i18n'
import type {
  AppLanguage,
  ImageAttachment,
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
  uploadImageAttachment,
} from '../api'
import { getStructuredLabels } from './chat-card-rendering'
import { CloseIcon, CopyIcon, ImageIcon } from './Icons'
import { useDialogFocus } from './dialog-focus'
import {
  mergeStickyNoteAttachments,
  shouldPersistStickyNoteDocument,
} from './sticky-note-images'

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
const maxStickyNoteImages = 50
const supportedImageMimeTypes = new Set<ImageAttachment['mimeType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

const readFileAsDataUrl = (file: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      resolve(reader.result)
    } else {
      reject(new Error('Unable to read image data.'))
    }
  }
  reader.onerror = () => reject(reader.error ?? new Error('Unable to read image data.'))
  reader.readAsDataURL(file)
})

const uploadStickyNoteImage = async (file: File): Promise<ImageAttachment> => {
  const dataUrl = await readFileAsDataUrl(file)
  const separator = dataUrl.indexOf(',')
  if (separator < 0) throw new Error('Unable to read image data.')

  return uploadImageAttachment({
    fileName: file.name,
    mimeType: file.type as ImageAttachment['mimeType'],
    dataBase64: dataUrl.slice(separator + 1),
  })
}

const StickyNoteImagePreviewDialog = ({
  language,
  attachment,
  copied,
  onCopy,
  onClose,
}: {
  language: AppLanguage
  attachment: ImageAttachment
  copied: boolean
  onCopy: (attachment: ImageAttachment) => void
  onClose: () => void
}) => {
  const text = getLocaleText(language)
  const labels = getStructuredLabels(language)
  const titleId = useId()
  const dialogRef = useDialogFocus<HTMLElement>({ isOpen: true, onClose })
  const layer = (
    <div className="structured-preview-layer">
      <div className="structured-preview-backdrop" onClick={onClose} />
      <section
        ref={dialogRef}
        className="structured-preview-dialog sticky-note-image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="structured-preview-card sticky-note-image-preview-card">
          <div className="structured-preview-header">
            <div className="structured-preview-copy">
              <h3 id={titleId}>{attachment.fileName}</h3>
            </div>
            <div className="sticky-note-image-preview-actions">
              <button
                type="button"
                className="btn btn-ghost sticky-note-image-preview-copy"
                onClick={() => onCopy(attachment)}
              >
                <CopyIcon />
                <span>{copied ? text.stickyNoteImageCopied : text.stickyNoteImageCopyAction}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost structured-preview-close sticky-note-image-preview-close"
                onClick={onClose}
                aria-label={labels.closeDetails}
              >
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="structured-preview-body sticky-note-image-preview-body">
            <img
              className="sticky-note-image-preview-image"
              src={getImageAttachmentUrl(attachment.id)}
              alt={attachment.fileName}
            />
          </div>
        </div>
      </section>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(layer, document.body) : layer
}

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
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const [previewAttachment, setPreviewAttachment] = useState<ImageAttachment | null>(null)
  const [uploadingImageCount, setUploadingImageCount] = useState(0)
  const [copiedAttachmentId, setCopiedAttachmentId] = useState('')
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
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<string | null>(null)
  const pendingViewStateRef = useRef<StickyNoteViewState | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const shouldRestoreViewStateRef = useRef(true)
  const hasLocalDocumentRef = useRef(false)
  const activeNoteIdRef = useRef(noteId)
  const latestLocalRef = useRef(local)
  const latestAttachmentsRef = useRef<ImageAttachment[]>(attachments)
  const latestTitleRef = useRef(title)
  const onChangeRef = useRef(onChange)
  const onViewStateChangeRef = useRef(onViewStateChange)
  const onChangeTitleRef = useRef(onChangeTitle)
  const searchRequestRef = useRef(0)
  const uploadGenerationRef = useRef(0)

  useEffect(() => {
    onChangeRef.current = onChange
    onViewStateChangeRef.current = onViewStateChange
    onChangeTitleRef.current = onChangeTitle
    latestLocalRef.current = local
    latestAttachmentsRef.current = attachments
    latestTitleRef.current = title
    activeNoteIdRef.current = noteId
  })

  const refreshSavedNotes = useCallback(async () => {
    if (!workspacePath.trim()) return []
    const response = await listStickyNotes({ workspacePath })
    setSavedNotes(response.notes)
    return response.notes
  }, [workspacePath])

  const saveLocalDocument = useCallback(async (
    value: string,
    checkpoint: boolean,
    nextAttachments = latestAttachmentsRef.current,
  ) => {
    const effectiveNoteId = activeNoteIdRef.current.trim()
    if (!workspacePath.trim() || !effectiveNoteId) return null
    if (!shouldPersistStickyNoteDocument(
      hasLocalDocumentRef.current,
      value,
      nextAttachments,
    )) return null

    try {
      const document = await saveStickyNote({
        workspacePath,
        noteId: effectiveNoteId,
        title: latestTitleRef.current,
        content: value,
        attachments: nextAttachments,
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
    const uploadGeneration = ++uploadGenerationRef.current
    hasLocalDocumentRef.current = false
    activeNoteIdRef.current = noteId
    latestAttachmentsRef.current = []
    setAttachments([])
    setPreviewAttachment(null)

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
      if (cancelled || uploadGenerationRef.current !== uploadGeneration) return
      hasLocalDocumentRef.current = true
      setVersions(document.versions)
      latestAttachmentsRef.current = document.attachments
      setAttachments(document.attachments)
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

    return () => {
      cancelled = true
      uploadGenerationRef.current += 1
    }
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
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
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
      latestAttachmentsRef.current = document.attachments
      latestTitleRef.current = document.title
      shouldRestoreViewStateRef.current = true
      setLocal(document.content)
      setAttachments(document.attachments)
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
      latestAttachmentsRef.current = document.attachments
      latestTitleRef.current = document.title
      setLocal(document.content)
      setAttachments(document.attachments)
      setVersions(document.versions)
      onBindNote(document.noteId, document.title, document.content)
      setLocalError('')
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingHistory(false)
    }
  }

  const markAttachmentCopied = useCallback((attachmentId: string) => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    setCopiedAttachmentId(attachmentId)
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = null
      setCopiedAttachmentId('')
    }, 1_500)
  }, [])

  const copyAttachment = useCallback(async (attachment: ImageAttachment) => {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.write !== 'function') {
      setLocalError(text.stickyNoteImageCopyError)
      return
    }

    let imageSource = getImageAttachmentUrl(attachment.id)
    try {
      const response = await fetch(imageSource)
      if (response.ok) imageSource = await readFileAsDataUrl(await response.blob())
    } catch {
      // The internal metadata remains lossless even if this Electron runtime
      // cannot fetch the custom protocol for the external HTML data-url fallback.
    }

    try {
      const html = createImageAttachmentClipboardHtml(attachment, imageSource)
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([attachment.fileName], { type: 'text/plain' }),
        }),
      ])
      setLocalError('')
      markAttachmentCopied(attachment.id)
    } catch (error) {
      setLocalError(`${text.stickyNoteImageCopyError}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [markAttachmentCopied, text.stickyNoteImageCopyError])

  const copyAttachmentFromEvent = (
    event: ReactClipboardEvent<HTMLElement>,
    attachment: ImageAttachment,
  ) => {
    event.preventDefault()
    event.clipboardData.setData(
      'text/html',
      createImageAttachmentClipboardHtml(attachment, getImageAttachmentUrl(attachment.id)),
    )
    event.clipboardData.setData('text/plain', attachment.fileName)
    markAttachmentCopied(attachment.id)
  }

  const commitAttachments = useCallback((next: ImageAttachment[], checkpoint = false) => {
    latestAttachmentsRef.current = next
    setAttachments(next)
    void saveLocalDocument(latestLocalRef.current, checkpoint, next)
    if (!checkpoint) scheduleCheckpoint()
  }, [saveLocalDocument, scheduleCheckpoint])

  const appendStoredAttachments = useCallback((incoming: readonly ImageAttachment[]) => {
    const current = latestAttachmentsRef.current
    const next = mergeStickyNoteAttachments(current, incoming, maxStickyNoteImages)
    if (next.length !== current.length) commitAttachments(next)
  }, [commitAttachments])

  const addImageFiles = useCallback(async (files: readonly File[]) => {
    const remaining = maxStickyNoteImages - latestAttachmentsRef.current.length
    const accepted = files
      .filter((file) => supportedImageMimeTypes.has(file.type as ImageAttachment['mimeType']))
      .slice(0, Math.max(0, remaining))
    if (accepted.length === 0) return

    const generation = uploadGenerationRef.current
    const targetNoteId = activeNoteIdRef.current
    setUploadingImageCount((count) => count + accepted.length)
    const results = await Promise.allSettled(accepted.map(uploadStickyNoteImage))
    setUploadingImageCount((count) => Math.max(0, count - accepted.length))

    if (
      generation !== uploadGenerationRef.current ||
      targetNoteId !== activeNoteIdRef.current
    ) return

    const uploaded = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    if (uploaded.length > 0) appendStoredAttachments(uploaded)
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') {
      setLocalError(`${text.stickyNoteImageUploadError}: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}`)
    } else {
      setLocalError('')
    }
  }, [appendStoredAttachments, text.stickyNoteImageUploadError])

  const handleImagePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const copied = parseImageAttachmentsFromClipboardHtml(event.clipboardData.getData('text/html'))
    if (copied.length > 0) {
      event.preventDefault()
      appendStoredAttachments(copied)
      return
    }

    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && supportedImageMimeTypes.has(item.type as ImageAttachment['mimeType']))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (imageFiles.length === 0) return

    event.preventDefault()
    void addImageFiles(imageFiles)
  }

  const removeAttachment = (attachmentId: string) => {
    const next = latestAttachmentsRef.current.filter((attachment) => attachment.id !== attachmentId)
    setPreviewAttachment((current) => current?.id === attachmentId ? null : current)
    commitAttachments(next)
  }

  const otherSavedNotes = useMemo(
    () => savedNotes.filter((entry) => entry.noteId !== noteId),
    [noteId, savedNotes],
  )
  const searchActive = searchQuery.trim() !== ''
  const displayedNotes = searchActive ? searchResults : otherSavedNotes
  const showExistingNotes = searchActive || (
    local.trim() === '' && attachments.length === 0 && otherSavedNotes.length > 0
  )
  const showLegacyRestore =
    local.trim() === '' && attachments.length === 0 && archivedContent.trim() !== '' && savedNotes.length === 0

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
          className="sticky-note-image-insert-button"
          onClick={() => imageInputRef.current?.click()}
        >
          <ImageIcon />
          <span>{text.stickyNoteImageInsertAction}</span>
        </button>
        <input
          ref={imageInputRef}
          type="file"
          className="sticky-note-image-input"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            void addImageFiles(files)
          }}
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

      {attachments.length > 0 || uploadingImageCount > 0 ? (
        <div className="sticky-note-image-strip" aria-label={text.stickyNoteImagesLabel}>
          {attachments.map((attachment, index) => (
            <div
              key={attachment.id}
              className="sticky-note-image-item"
              onCopy={(event) => copyAttachmentFromEvent(event, attachment)}
            >
              <button
                type="button"
                className="sticky-note-image-preview-trigger"
                aria-label={getStructuredLabels(language).openDetails(attachment.fileName)}
                onClick={() => setPreviewAttachment(attachment)}
              >
                <img
                  className="sticky-note-image-thumbnail"
                  src={getImageAttachmentUrl(attachment.id)}
                  alt={attachment.fileName || text.pastedImageAlt(index + 1)}
                  loading="lazy"
                />
              </button>
              <div className="sticky-note-image-actions">
                <button
                  type="button"
                  className="sticky-note-image-copy"
                  aria-label={text.stickyNoteImageCopyAction}
                  title={text.stickyNoteImageCopyAction}
                  onClick={() => void copyAttachment(attachment)}
                >
                  <CopyIcon />
                </button>
                <button
                  type="button"
                  className="sticky-note-image-remove"
                  aria-label={text.removeAttachment}
                  title={text.removeAttachment}
                  onClick={() => removeAttachment(attachment.id)}
                >
                  <CloseIcon />
                </button>
              </div>
              {copiedAttachmentId === attachment.id ? (
                <span className="sticky-note-image-copied" role="status">
                  {text.stickyNoteImageCopied}
                </span>
              ) : null}
            </div>
          ))}
          {uploadingImageCount > 0 ? (
            <div className="sticky-note-image-uploading" role="status">
              <span className="spinner" aria-hidden="true" />
              <span>{text.stickyNoteImageUploading}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {previewAttachment ? (
        <StickyNoteImagePreviewDialog
          language={language}
          attachment={previewAttachment}
          copied={copiedAttachmentId === previewAttachment.id}
          onCopy={(attachment) => void copyAttachment(attachment)}
          onClose={() => setPreviewAttachment(null)}
        />
      ) : null}

      <textarea
        ref={textareaRef}
        className="sticky-note-textarea"
        value={local}
        onChange={(event) => handleChange(event.target.value)}
        onPaste={handleImagePaste}
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
