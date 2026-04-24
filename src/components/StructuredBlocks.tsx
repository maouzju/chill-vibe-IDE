import { memo, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { AppLanguage } from '../../shared/schema'
import type {
  StructuredAskUserMessage,
  StructuredCommandMessage,
  StructuredEditedFile,
  StructuredEditsMessage,
  StructuredTodoMessage,
  StructuredToolGroupItem,
  StructuredToolMessage,
} from './chat-card-parsing'
import { cleanCommandDisplay, buildToolGroupSummary, getStructuredLabels, summarizeCommandDisplay } from './chat-card-rendering'
import { resolveWorkspaceRelativeFilePath } from './structured-file-paths'
import {
  clearAskUserDraft,
  getAskUserDraft,
  setAskUserDraft,
} from './ask-user-draft-cache'
import {
  getNewlyCompletedStructuredTodoItemIds,
  structuredTodoCompletionFlashDurationMs,
} from './structured-todo-flash'
import { CloseIcon } from './Icons'

const StructuredDialog = ({
  language,
  titleId,
  dialogTitle,
  onClose,
  children,
}: {
  language: AppLanguage
  titleId: string
  dialogTitle: string
  onClose: () => void
  children: ReactNode
}) => {
  const labels = getStructuredLabels(language)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const dialogLayer = (
    <div className="structured-preview-layer">
      <div
        className="structured-preview-backdrop"
        onClick={onClose}
      />
      <section
        className="structured-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="structured-preview-card">
          <div className="structured-preview-header">
            <div className="structured-preview-copy">
              <h3 id={titleId}>{dialogTitle}</h3>
            </div>

            <button
              type="button"
              className="btn btn-ghost structured-preview-close"
              onClick={onClose}
              aria-label={labels.closeDetails}
            >
              <CloseIcon />
            </button>
          </div>

          <div className="structured-preview-body">{children}</div>
        </div>
      </section>
    </div>
  )

  return typeof document !== 'undefined'
    ? createPortal(dialogLayer, document.body)
    : dialogLayer
}

export const StructuredPreviewBlock = ({
  language,
  previewText,
  dialogTitle,
  variant,
  renderDialogContent,
  renderPreviewContent,
  actionPlacement = 'overlay',
}: {
  language: AppLanguage
  previewText: string
  dialogTitle: string
  variant: 'code' | 'prose'
  renderDialogContent: () => ReactNode
  renderPreviewContent?: () => ReactNode
  actionPlacement?: 'overlay' | 'footer'
}) => {
  const labels = getStructuredLabels(language)
  const titleId = useId()
  const previewRef = useRef<HTMLDivElement>(null)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [isDialogOpen, setIsDialogOpen] = useState(false)

  const measureOverflow = useEffectEvent(() => {
    const node = previewRef.current

    if (!node) {
      return
    }

    const nextOverflowing = node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1
    setIsOverflowing((current) => (current === nextOverflowing ? current : nextOverflowing))
  })

  useLayoutEffect(() => {
    const node = previewRef.current

    if (!node) {
      return
    }

    measureOverflow()

    let resizeObserver: ResizeObserver | null = null

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        measureOverflow()
      })
      resizeObserver.observe(node)
    }

    window.addEventListener('resize', measureOverflow)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', measureOverflow)
    }
  }, [previewText])

  useEffect(() => {
    if (!isDialogOpen) {
      return
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDialogOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isDialogOpen])

  const dialogLayer = isDialogOpen ? (
    <StructuredDialog
      language={language}
      titleId={titleId}
      dialogTitle={dialogTitle}
      onClose={() => setIsDialogOpen(false)}
    >
      {renderDialogContent()}
    </StructuredDialog>
  ) : null

  return (
    <>
      <div
        className={`structured-preview-shell${actionPlacement === 'footer' ? ' is-action-footer' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => setIsDialogOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setIsDialogOpen(true)
          }
        }}
      >
        <div
          ref={previewRef}
          className={`structured-preview-text is-${variant}${renderPreviewContent ? ' has-custom-content' : ''}${renderPreviewContent && variant === 'code' ? ' is-diff-preview' : ''}`}
          aria-label={dialogTitle}
        >
          {renderPreviewContent ? renderPreviewContent() : previewText}
        </div>

        {isOverflowing && actionPlacement === 'overlay' ? (
          <button
            type="button"
            className="btn btn-ghost structured-preview-trigger"
            aria-label={labels.openDetails(dialogTitle)}
            onClick={(e) => { e.stopPropagation(); setIsDialogOpen(true) }}
          >
            {labels.viewDetails}
          </button>
        ) : null}
        {isOverflowing && actionPlacement === 'footer' ? (
          <div className="structured-preview-footer">
            <button
              type="button"
              className="btn btn-ghost structured-preview-trigger"
              aria-label={labels.openDetails(dialogTitle)}
              onClick={(e) => { e.stopPropagation(); setIsDialogOpen(true) }}
            >
              {labels.viewDetails}
            </button>
          </div>
        ) : null}
      </div>
      {dialogLayer}
    </>
  )
}


export const StructuredCommandCard = ({
  language,
  data,
}: {
  language: AppLanguage
  data: StructuredCommandMessage
}) => {
  const labels = getStructuredLabels(language)
  const titleId = useId()
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const commandSummary = summarizeCommandDisplay(data.command, language)
  const commandText = cleanCommandDisplay(data.command) || data.command || labels.shell
  const showInlineCommandText = !commandText.includes('\n') && commandText.length <= 96

  useEffect(() => {
    if (!isDialogOpen) {
      return
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDialogOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isDialogOpen])

  return (
    <>
      <section className={`structured-command-inline is-${data.status}`}>
        <div
          className="structured-command-inline-row"
          role="button"
          tabIndex={0}
          aria-label={labels.openDetails(commandSummary)}
          onClick={() => setIsDialogOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setIsDialogOpen(true)
            }
          }}
        >
          <div className="structured-command-main">
            {showInlineCommandText ? (
              <>
                <strong className="structured-command-label">{commandSummary}</strong>
                <span className="structured-command-text">{commandText}</span>
              </>
            ) : (
              <>
                <strong className="structured-command-label">{labels.shell}</strong>
                <span className="structured-command-type">{commandSummary}</span>
              </>
            )}
          </div>
          {data.exitCode !== null && data.exitCode !== 0 ? (
            <span className="structured-command-exit is-inline">{labels.exitCode(data.exitCode)}</span>
          ) : null}
        </div>
      </section>

      {isDialogOpen ? (
        <StructuredDialog
          language={language}
          titleId={titleId}
          dialogTitle={commandSummary}
          onClose={() => setIsDialogOpen(false)}
        >
          <div className="structured-command-detail-shell">
            <section className="structured-command-detail-section">
              <span className="structured-block-label">{labels.command}</span>
              <pre className="structured-command-output is-dialog">{commandText}</pre>
            </section>
            {data.output ? (
              <section className="structured-command-detail-section">
                <span className="structured-block-label">{labels.shellOutput}</span>
                <pre className="structured-command-output is-dialog">{data.output}</pre>
              </section>
            ) : null}
            {data.exitCode !== null ? (
              <div className="structured-command-exit">{labels.exitCode(data.exitCode)}</div>
            ) : null}
          </div>
        </StructuredDialog>
      ) : null}
    </>
  )
}

type ToolDetail = { label: string; value: string }

const parseToolInputLineNumber = (value: string | undefined) => {
  if (!value) {
    return null
  }

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < 1) {
    return null
  }

  return parsed
}

const buildReadLinePresentation = (
  language: AppLanguage,
  toolInput?: Record<string, string>,
): { detail: ToolDetail; summarySuffix: string } | null => {
  if (!toolInput) {
    return null
  }

  const en = language === 'en'
  const offset = parseToolInputLineNumber(toolInput.offset)
  const limit = parseToolInputLineNumber(toolInput.limit)

  if (offset !== null && limit !== null) {
    const end = offset + limit - 1
    return {
      detail: {
        label: en ? 'lines' : '\u884c',
        value: `${offset}-${end}`,
      },
      summarySuffix: en ? ` (lines ${offset}-${end})` : `\uFF08\u7B2C ${offset}-${end} \u884C\uFF09`,
    }
  }

  if (offset !== null) {
    return {
      detail: {
        label: en ? 'lines' : '\u884c',
        value: String(offset),
      },
      summarySuffix: en ? ` (from line ${offset})` : `\uFF08\u4ECE\u7B2C ${offset} \u884C\uFF09`,
    }
  }

  if (limit !== null) {
    return {
      detail: {
        label: en ? 'lines' : '\u884c',
        value: `1-${limit}`,
      },
      summarySuffix: en ? ` (lines 1-${limit})` : `\uFF08\u7B2C 1-${limit} \u884C\uFF09`,
    }
  }

  return null
}

const buildToolSummary = (
  language: AppLanguage,
  toolName: string,
  summary: string,
  toolInput?: Record<string, string>,
) => {
  if (toolName !== 'Read') {
    return summary
  }

  const trimmedSummary = summary.trim()

  if (!trimmedSummary) {
    return summary
  }

  if (trimmedSummary.includes('(lines ') || trimmedSummary.includes('\uFF08\u7B2C ')) {
    return summary
  }

  const readLinePresentation = buildReadLinePresentation(language, toolInput)

  return readLinePresentation
    ? `${summary}${readLinePresentation.summarySuffix}`
    : summary
}

const buildToolDetails = (
  language: AppLanguage,
  toolName: string,
  toolInput?: Record<string, string>,
): ToolDetail[] => {
  if (!toolInput) return []
  const en = language === 'en'

  if (toolName === 'Read') {
    const details: ToolDetail[] = []
    if (toolInput.file_path) details.push({ label: en ? 'file' : '鏂囦欢', value: toolInput.file_path })
    const readLinePresentation = buildReadLinePresentation(language, toolInput)
    if (readLinePresentation) details.push(readLinePresentation.detail)
    return details
  }

  switch (toolName) {
    case 'Read': {
      const details: ToolDetail[] = []
      if (toolInput.file_path) details.push({ label: en ? 'file' : '文件', value: toolInput.file_path })
      if (toolInput.offset || toolInput.limit) {
        const from = toolInput.offset ?? '0'
        const to = toolInput.limit ? String(Number(toolInput.offset ?? 0) + Number(toolInput.limit)) : '...'
        details.push({ label: en ? 'lines' : '行', value: `${from}-${to}` })
      }
      return details
    }
    case 'Glob': {
      const details: ToolDetail[] = []
      if (toolInput.pattern) details.push({ label: en ? 'pattern' : '模式', value: toolInput.pattern })
      if (toolInput.path) details.push({ label: en ? 'in' : '目录', value: toolInput.path })
      return details
    }
    case 'Grep': {
      const details: ToolDetail[] = []
      if (toolInput.pattern) details.push({ label: en ? 'pattern' : '模式', value: toolInput.pattern })
      if (toolInput.glob) details.push({ label: en ? 'files' : '文件', value: toolInput.glob })
      if (toolInput.path) details.push({ label: en ? 'in' : '目录', value: toolInput.path })
      return details
    }
    case 'WebFetch': {
      const details: ToolDetail[] = []
      if (toolInput.url) details.push({ label: 'URL', value: toolInput.url })
      return details
    }
    case 'WebSearch': {
      const details: ToolDetail[] = []
      if (toolInput.query) details.push({ label: en ? 'query' : '搜索', value: toolInput.query })
      return details
    }
    default:
      return []
  }
}

export const StructuredToolCard = ({
  language,
  data,
}: {
  language: AppLanguage
  data: StructuredToolMessage
}) => {
  const details = buildToolDetails(language, data.toolName, data.toolInput)
  const summary = buildToolSummary(language, data.toolName, data.summary, data.toolInput)
  const [collapsed, setCollapsed] = useState(true)
  const hasDetails = details.length > 0

  return (
    <section className="structured-tool-card">
      <div
        className={`structured-command-inline-row${hasDetails ? '' : ' no-expand'}`}
        role={hasDetails ? 'button' : undefined}
        tabIndex={hasDetails ? 0 : undefined}
        onClick={hasDetails ? () => setCollapsed(!collapsed) : undefined}
        onKeyDown={hasDetails ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setCollapsed(!collapsed)
          }
        } : undefined}
      >
        <div className="structured-command-main">
          <strong className="structured-command-label">{data.toolName}</strong>
          <span className="structured-command-text">{summary}</span>
        </div>
        {hasDetails ? (
          <span className={`structured-tool-chevron${collapsed ? '' : ' is-open'}`} aria-hidden="true">&#x25B8;</span>
        ) : null}
      </div>
      {!collapsed && details.length > 0 ? (
        <div className="structured-tool-details">
          {details.map(({ label, value }) => (
            <div key={label} className="structured-tool-detail-row">
              <span className="structured-tool-detail-label">{label}</span>
              <code className="structured-tool-detail-value" title={value}>{value}</code>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

const StructuredToolGroupCardView = ({
  language,
  items,
  collapsed,
  onToggle,
  entryId,
  entryRef,
  workspacePath,
  onOpenFile,
}: {
  language: AppLanguage
  items: StructuredToolGroupItem[]
  collapsed: boolean
  onToggle: () => void
  entryId?: string
  entryRef?: (node: HTMLElement | null) => void
  workspacePath: string
  onOpenFile?: (relativePath: string) => void
}) => {
  const summary = buildToolGroupSummary(items, language)

  const header = (
    <div className="structured-group-header">
      <div
        className="structured-group-summary-row"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <span className="structured-group-summary-leading">
          <span className={`structured-group-chevron${collapsed ? '' : ' is-open'}`}>&#x25B6;</span>
          <span className="structured-group-summary-text">{summary}</span>
        </span>
        <span className="structured-group-summary-count" aria-hidden="true">{items.length}</span>
      </div>
    </div>
  )

  if (collapsed) {
    return (
      <article
        ref={entryRef}
        className="message message-assistant structured-command-group"
        data-renderable-id={entryId}
      >
        {header}
      </article>
    )
  }

  return (
    <article
      ref={entryRef}
      className="message message-assistant structured-command-group"
      data-renderable-id={entryId}
    >
      {header}
      <div className="structured-command-stack">
        {items.map((item) =>
          item.kind === 'command' ? (
            <StructuredCommandCard
              key={item.message.id}
              language={language}
              data={item.data}
            />
          ) : item.kind === 'edits' ? (
            <StructuredEditsCard
              key={item.message.id}
              language={language}
              data={item.data}
              workspacePath={workspacePath}
              onOpenFile={onOpenFile}
            />
          ) : (
            <StructuredToolCard
              key={item.message.id}
              language={language}
              data={item.data}
            />
          ),
        )}
      </div>
    </article>
  )
}

const getStructuredDiffLineClass = (line: string) => {
  if (line.startsWith('@@')) {
    return 'structured-diff-line is-hunk'
  }

  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'structured-diff-line is-added'
  }

  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'structured-diff-line is-removed'
  }

  return 'structured-diff-line is-context'
}

type StructuredDiffPreviewLine = {
  key: string
  kind: 'added' | 'removed' | 'context'
  marker: '+' | '-' | ' '
  content: string
}

const diffMetadataPrefixes = [
  'diff --git ',
  'index ',
  'new file mode ',
  'deleted file mode ',
  'similarity index ',
  'rename from ',
  'rename to ',
  '--- ',
  '+++ ',
]

const buildStructuredDiffPreviewLines = (patch: string): StructuredDiffPreviewLine[] => {
  const rows: StructuredDiffPreviewLine[] = []

  patch.split(/\r?\n/).forEach((line, index) => {
    if (!line || diffMetadataPrefixes.some((prefix) => line.startsWith(prefix)) || line.startsWith('@@')) {
      return
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      rows.push({
        key: `added:${index}`,
        kind: 'added',
        marker: '+',
        content: line.slice(1),
      })
      return
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      rows.push({
        key: `removed:${index}`,
        kind: 'removed',
        marker: '-',
        content: line.slice(1),
      })
      return
    }

    rows.push({
      key: `context:${index}`,
      kind: 'context',
      marker: ' ',
      content: line.startsWith(' ') ? line.slice(1) : line,
    })
  })

  return rows
}

const stripDiffMetadata = (patch: string) =>
  patch
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.startsWith('diff --git ') &&
        !line.startsWith('index ') &&
        !line.startsWith('new file mode ') &&
        !line.startsWith('deleted file mode ') &&
        !line.startsWith('similarity index ') &&
        !line.startsWith('rename from ') &&
        !line.startsWith('rename to ') &&
        !line.startsWith('--- ') &&
        !line.startsWith('+++ ') &&
        !line.startsWith('@@'),
    )
    .join('\n')

export const StructuredDiffBlock = ({ patch }: { patch: string }) => {
  const lines = patch.split(/\r?\n/)

  return (
    <div className="structured-diff-block">
      {lines.map((line, index) => (
        <div key={`${index}:${line}`} className={getStructuredDiffLineClass(line)}>
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

const StructuredInlineDiffPreview = ({ patch }: { patch: string }) => {
  const rows = buildStructuredDiffPreviewLines(patch)

  return (
    <div className="structured-inline-diff-preview" aria-hidden="true">
      {rows.map((row) => (
        <div
          key={row.key}
          className={`structured-inline-diff-row is-${row.kind}`}
        >
          <span className="structured-inline-diff-marker">{row.marker}</span>
          <code className="structured-inline-diff-code">{row.content || ' '}</code>
        </div>
      ))}
    </div>
  )
}

const splitStructuredEditPath = (path: string) => {
  const lastSlashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  if (lastSlashIndex < 0) {
    return {
      directory: null,
      fileName: path,
    }
  }

  return {
    directory: path.slice(0, lastSlashIndex + 1),
    fileName: path.slice(lastSlashIndex + 1),
  }
}

const getStructuredEditKindLabel = (
  language: AppLanguage,
  kind: StructuredEditedFile['kind'],
) => {
  if (language === 'en') {
    switch (kind) {
      case 'added':
        return 'Added'
      case 'deleted':
        return 'Deleted'
      case 'renamed':
        return 'Renamed'
      default:
        return 'Modified'
    }
  }

  switch (kind) {
    case 'added':
      return '新增'
    case 'deleted':
      return '删除'
    case 'renamed':
      return '重命名'
    default:
      return '修改'
  }
}

export const StructuredEditsCard = ({
  language,
  data,
  workspacePath,
  onOpenFile,
}: {
  language: AppLanguage
  data: StructuredEditsMessage
  workspacePath: string
  onOpenFile?: (relativePath: string) => void
}) => {
  const labels = getStructuredLabels(language)

  return (
    <section className="structured-edits-card">
      <div className="structured-edits-header">
        <span className="structured-block-label">{labels.editedFiles}</span>
        <span className="structured-command-summary">{labels.changedFiles(data.files.length)}</span>
      </div>
      <div className="structured-edits-list">
        {data.files.map((file) => {
          const { directory, fileName } = splitStructuredEditPath(file.path)
          const openPath = onOpenFile ? resolveWorkspaceRelativeFilePath(workspacePath, file.path) : null
          const summaryContent = (
            <>
              <div className="structured-edits-copy">
                <div className="structured-edits-title-row">
                  <div className="structured-edits-title">
                    <code
                      className="structured-edits-path structured-edits-path-name"
                      title={fileName}
                    >
                      {fileName}
                    </code>
                    {directory ? (
                      <span className="structured-edits-paths" title={directory}>
                        <span className="structured-edits-path-directory">{directory}</span>
                      </span>
                    ) : null}
                  </div>
                  {(file.addedLines > 0 || file.removedLines > 0) ? (
                    <div className="structured-edits-stats">
                      {file.addedLines > 0 ? (
                        <span className="structured-diff-stat is-added">{`+${file.addedLines}`}</span>
                      ) : null}
                      {file.removedLines > 0 ? (
                        <span className="structured-diff-stat is-removed">{`-${file.removedLines}`}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="structured-edits-meta-row">
                  <span className={`structured-edits-kind is-${file.kind}`}>
                    {getStructuredEditKindLabel(language, file.kind)}
                  </span>
                  {file.originalPath && file.originalPath !== file.path ? (
                    <span className="structured-edits-origin" title={file.originalPath}>
                      <span className="structured-edits-arrow" aria-hidden="true">←</span>
                      <code className="structured-edits-path is-original">{file.originalPath}</code>
                    </span>
                  ) : null}
                </div>
              </div>
            </>
          )

          return (
            <article key={`${file.path}:${file.kind}`} className="structured-edits-file">
              {openPath ? (
                <button
                  type="button"
                  className="structured-edits-summary structured-edits-summary-button"
                  title={file.path}
                  aria-label={labels.openFile(file.path)}
                  data-open-file-path={openPath}
                  onClick={() => onOpenFile?.(openPath)}
                >
                  {summaryContent}
                </button>
              ) : (
                <div className="structured-edits-summary">
                  {summaryContent}
                </div>
              )}
              <StructuredPreviewBlock
                language={language}
                previewText={stripDiffMetadata(file.patch)}
                dialogTitle={labels.filePatch(file.path)}
                variant="code"
                actionPlacement="footer"
                renderPreviewContent={() => <StructuredInlineDiffPreview patch={file.patch} />}
                renderDialogContent={() => <StructuredDiffBlock patch={file.patch} />}
              />
            </article>
          )
        })}
      </div>
    </section>
  )
}

const areStructuredToolGroupCardPropsEqual = (
  previous: Parameters<typeof StructuredToolGroupCardView>[0],
  next: Parameters<typeof StructuredToolGroupCardView>[0],
) => {
  if (
    previous.language !== next.language ||
    previous.collapsed !== next.collapsed ||
    previous.entryId !== next.entryId ||
    previous.workspacePath !== next.workspacePath ||
    Boolean(previous.onOpenFile) !== Boolean(next.onOpenFile) ||
    previous.items.length !== next.items.length
  ) {
    return false
  }

  for (let index = 0; index < next.items.length; index += 1) {
    const previousItem = previous.items[index]
    const nextItem = next.items[index]
    if (!previousItem || !nextItem) {
      return false
    }

    if (previousItem.kind !== nextItem.kind || previousItem.message !== nextItem.message) {
      return false
    }
  }

  return true
}

export const StructuredToolGroupCard = memo(
  StructuredToolGroupCardView,
  areStructuredToolGroupCardPropsEqual,
)
StructuredToolGroupCard.displayName = 'StructuredToolGroupCard'

const getTodoPriorityLabel = (
  labels: ReturnType<typeof getStructuredLabels>,
  priority: StructuredTodoMessage['items'][number]['priority'],
) => {
  switch (priority) {
    case 'high':
      return labels.priorityHigh
    case 'medium':
      return labels.priorityMedium
    case 'low':
      return labels.priorityLow
    default:
      return ''
  }
}

export const StructuredTodoCard = ({
  language,
  data,
}: {
  language: AppLanguage
  data: StructuredTodoMessage
}) => {
  const labels = getStructuredLabels(language)
  const completedCount = data.items.filter((item) => item.status === 'completed').length
  const previousItemsRef = useRef<StructuredTodoMessage['items'] | null>(null)
  const flashTimeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [flashingItemIds, setFlashingItemIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const previousItems = previousItemsRef.current
    previousItemsRef.current = data.items

    if (!previousItems) {
      return
    }

    const newlyCompletedItemIds = getNewlyCompletedStructuredTodoItemIds(previousItems, data.items)

    if (newlyCompletedItemIds.length === 0) {
      return
    }

    setFlashingItemIds((current) => {
      const next = new Set(current)

      for (const itemId of newlyCompletedItemIds) {
        next.add(itemId)
      }

      return next
    })

    for (const itemId of newlyCompletedItemIds) {
      const existingTimeout = flashTimeoutsRef.current.get(itemId)
      if (existingTimeout) {
        clearTimeout(existingTimeout)
      }

      flashTimeoutsRef.current.set(
        itemId,
        setTimeout(() => {
          flashTimeoutsRef.current.delete(itemId)
          setFlashingItemIds((current) => {
            if (!current.has(itemId)) {
              return current
            }

            const next = new Set(current)
            next.delete(itemId)
            return next
          })
        }, structuredTodoCompletionFlashDurationMs),
      )
    }
  }, [data.items])

  useEffect(
    () => () => {
      for (const timeoutId of flashTimeoutsRef.current.values()) {
        clearTimeout(timeoutId)
      }
      flashTimeoutsRef.current.clear()
    },
    [],
  )

  return (
    <section className="structured-todo-card">
      <div className="structured-todo-header">
        <span className="structured-block-label">{labels.tasks}</span>
        <span className="structured-todo-summary">
          {labels.tasksCompleted(completedCount, data.items.length)}
        </span>
      </div>

      {data.items.length === 0 ? (
        <div className="structured-todo-empty">{labels.noTasks}</div>
      ) : (
        <div className="structured-todo-list">
          {data.items.map((item) => {
            const priorityLabel = getTodoPriorityLabel(labels, item.priority)
            const detail =
              item.status === 'in_progress' && item.activeForm && item.activeForm !== item.content
                ? item.activeForm
                : null
            const isNewlyCompleted = flashingItemIds.has(item.id)

            return (
              <article
                key={item.id}
                className={`structured-todo-item is-${item.status}${isNewlyCompleted ? ' is-newly-completed' : ''}`}
              >
                <div className="structured-todo-main">
                  <span className={`structured-todo-status is-${item.status}`} aria-hidden="true">
                    {item.status === 'completed' ? '\u2713' : item.status === 'in_progress' ? '\u25CF' : ''}
                  </span>

                  <div className="structured-todo-copy">
                    <div className="structured-todo-title-row">
                      <span className="structured-todo-title">{item.content}</span>
                      {priorityLabel ? (
                        <span className={`structured-todo-badge is-priority is-${item.priority}`}>
                          {priorityLabel}
                        </span>
                      ) : null}
                    </div>

                    {detail ? <div className="structured-todo-detail">{detail}</div> : null}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

export const AskUserQuestionCard = ({
  data,
  answerKey,
  answeredOption,
  onSelectOption,
  language,
}: {
  data: StructuredAskUserMessage
  answerKey: string
  answeredOption: string | null
  onSelectOption: (label: string) => void
  language: AppLanguage
}) => {
  const isAnswered = answeredOption !== null
  const OTHER_LABEL = 'Other'
  const totalQuestions = data.questions.length
  const isMulti = totalQuestions > 1

  const cachedDraft = isAnswered ? null : getAskUserDraft(answerKey)
  // selections[i] holds the chosen label (or Other) for question i; null = unanswered.
  const [selections, setSelections] = useState<(string | null)[]>(() => {
    if (isAnswered && !isMulti) {
      return [answeredOption]
    }
    const base = new Array(totalQuestions).fill(null) as (string | null)[]
    if (cachedDraft?.selected != null) {
      base[0] = cachedDraft.selected
    }
    return base
  })
  const [otherTexts, setOtherTexts] = useState<string[]>(() => {
    const base = new Array(totalQuestions).fill('') as string[]
    if (cachedDraft?.otherText) {
      base[0] = cachedDraft.otherText
    }
    return base
  })
  const [currentIndex, setCurrentIndex] = useState(0)
  const [lastSubmittedItemId, setLastSubmittedItemId] = useState<string | null>(null)
  const otherInputRef = useRef<HTMLInputElement>(null)
  const submitStartedRef = useRef<string | null>(null)
  const isSubmitting = !isAnswered && lastSubmittedItemId === data.itemId

  const current = data.questions[currentIndex] ?? data.questions[0]!
  const selected = selections[currentIndex] ?? null
  const otherText = otherTexts[currentIndex] ?? ''

  const setSelected = (value: string | null) => {
    setSelections((prev) => {
      const next = prev.slice()
      next[currentIndex] = value
      return next
    })
    if (!isAnswered && !isMulti) {
      setAskUserDraft(answerKey, { selected: value, otherText })
    }
  }

  const setOtherText = (value: string) => {
    setOtherTexts((prev) => {
      const next = prev.slice()
      next[currentIndex] = value
      return next
    })
    if (!isAnswered && !isMulti) {
      setAskUserDraft(answerKey, { selected, otherText: value })
    }
  }

  const labels = language === 'en'
    ? {
        submit: 'Submit answers',
        submitted: 'Submitted',
        escHint: 'Esc to cancel',
        lockedHint: 'Selection locked',
        other: 'Other',
        prev: 'Previous',
        next: 'Next',
      }
    : {
        submit: '提交回答',
        submitted: '已提交',
        escHint: 'Esc 取消',
        lockedHint: '选择已锁定',
        other: '其他',
        prev: '上一题',
        next: '下一题',
      }

  const allAnswered = selections.every((sel) => sel !== null)

  const resolveAnswerLabel = (idx: number): string => {
    const sel = selections[idx]
    if (sel === null) return ''
    if (sel === OTHER_LABEL) return (otherTexts[idx] ?? '').trim() || OTHER_LABEL
    return sel
  }

  const handleSubmit = () => {
    if (isAnswered || submitStartedRef.current === data.itemId) return
    if (!allAnswered) return

    submitStartedRef.current = data.itemId
    setLastSubmittedItemId(data.itemId)

    if (isMulti) {
      const combined = data.questions
        .map((q, idx) => `[${idx + 1}] ${q.question} → ${resolveAnswerLabel(idx)}`)
        .join('\n')
      onSelectOption(combined)
    } else {
      onSelectOption(resolveAnswerLabel(0))
    }
    clearAskUserDraft(answerKey)
  }

  useEffect(() => {
    if (answeredOption !== null) {
      submitStartedRef.current = null
    }
  }, [answerKey, answeredOption, isAnswered])

  useEffect(() => {
    if (!isAnswered) {
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Enter' && allAnswered) {
          e.preventDefault()
          handleSubmit()
        } else if (isMulti && e.key === 'ArrowLeft' && currentIndex > 0) {
          e.preventDefault()
          setCurrentIndex(currentIndex - 1)
        } else if (isMulti && e.key === 'ArrowRight' && currentIndex < totalQuestions - 1) {
          e.preventDefault()
          setCurrentIndex(currentIndex + 1)
        }
      }
      window.addEventListener('keydown', handler)
      return () => window.removeEventListener('keydown', handler)
    }
  })

  const goPrev = () => {
    if (currentIndex > 0) setCurrentIndex(currentIndex - 1)
  }
  const goNext = () => {
    if (currentIndex < totalQuestions - 1) setCurrentIndex(currentIndex + 1)
  }

  const answeredForRadio = isAnswered && !isMulti ? answeredOption : selected

  return (
    <section className={`ask-user-card${isAnswered ? ' is-answered' : ''}`}>
      <div className="ask-user-title-bar">
        <span className="ask-user-title">{current.header || labels.other}</span>
        {isMulti ? (
          <span className="ask-user-pager">
            <button
              type="button"
              className="ask-user-nav-btn"
              disabled={currentIndex === 0}
              onClick={goPrev}
              aria-label={labels.prev}
              title={labels.prev}
            >
              ‹
            </button>
            <span className="ask-user-counter">
              {currentIndex + 1} / {totalQuestions}
              {selections[currentIndex] !== null ? ' ✓' : ''}
            </span>
            <button
              type="button"
              className="ask-user-nav-btn"
              disabled={currentIndex === totalQuestions - 1}
              onClick={goNext}
              aria-label={labels.next}
              title={labels.next}
            >
              ›
            </button>
          </span>
        ) : null}
      </div>

      <div className="ask-user-question">{current.question}</div>

      <div className="ask-user-options">
        {current.options.map((option) => {
          const isChecked = answeredForRadio === option.label
          const isDimmed = isAnswered && !isMulti && answeredOption !== option.label
          return (
            <label
              key={option.label}
              className={`ask-user-option${isChecked ? ' is-selected' : ''}${isDimmed ? ' is-dimmed' : ''}`}
            >
              <span className={`ask-user-radio${isChecked ? ' is-checked' : ''}`} />
              <span className="ask-user-option-body">
                <span className="ask-user-option-label">{option.label}</span>
                {option.description ? (
                  <span className="ask-user-option-desc">{option.description}</span>
                ) : null}
              </span>
              <input
                type="radio"
                name={`ask-user-${data.itemId}-${currentIndex}`}
                className="ask-user-radio-input"
                checked={isChecked}
                disabled={isAnswered || isSubmitting}
                onChange={() => setSelected(option.label)}
              />
            </label>
          )
        })}

        {/* Other option */}
        <label
          className={`ask-user-option${selected === OTHER_LABEL ? ' is-selected' : ''}${isAnswered && !isMulti && answeredOption !== OTHER_LABEL ? ' is-dimmed' : ''}`}
        >
          <span className={`ask-user-radio${selected === OTHER_LABEL ? ' is-checked' : ''}`} />
          <span className="ask-user-option-body">
            <span className="ask-user-option-label">{labels.other}</span>
          </span>
          <input
            type="radio"
            name={`ask-user-${data.itemId}-${currentIndex}`}
            className="ask-user-radio-input"
            checked={selected === OTHER_LABEL}
            disabled={isAnswered || isSubmitting}
            onChange={() => {
              setSelected(OTHER_LABEL)
              requestAnimationFrame(() => otherInputRef.current?.focus())
            }}
          />
        </label>

        {selected === OTHER_LABEL && !isAnswered ? (
          <input
            ref={otherInputRef}
            type="text"
            className="ask-user-other-input"
            value={otherText}
            disabled={isSubmitting}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="..."
          />
        ) : null}
      </div>

      <div className={`ask-user-footer${isAnswered ? ' is-answered' : ''}`}>
        <button
          type="button"
          className="ask-user-submit"
          disabled={isAnswered || !allAnswered || isSubmitting}
          onClick={handleSubmit}
        >
          {isAnswered ? labels.submitted : labels.submit}
        </button>
        <span className="ask-user-esc-hint">
          {isAnswered ? labels.lockedHint : labels.escHint}
        </span>
      </div>
    </section>
  )
}

export type ChangesSummaryFile = {
  path: string
  addedLines: number
  removedLines: number
}

const splitChangesSummaryPath = (path: string) => {
  const trimmedPath = path.replace(/[\\/]+$/, '')

  if (!trimmedPath) {
    return {
      fileName: path,
      directory: '',
    }
  }

  const separatorIndex = Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\'))

  if (separatorIndex < 0) {
    return {
      fileName: trimmedPath,
      directory: '',
    }
  }

  return {
    fileName: trimmedPath.slice(separatorIndex + 1) || trimmedPath,
    directory: trimmedPath.slice(0, separatorIndex),
  }
}

export const ChangesSummaryCard = ({
  language,
  files,
  workspacePath,
  onOpenFile,
}: {
  language: AppLanguage
  files: ChangesSummaryFile[]
  workspacePath: string
  onOpenFile?: (relativePath: string) => void
}) => {
  const labels = getStructuredLabels(language)
  const totalAdded = files.reduce((sum, f) => sum + f.addedLines, 0)
  const totalRemoved = files.reduce((sum, f) => sum + f.removedLines, 0)

  return (
    <section className="changes-summary-card">
      <div className="changes-summary-header">
        <span className="changes-summary-total">
          {labels.totalChanges(files.length, totalAdded, totalRemoved)}
        </span>
      </div>
      <div className="changes-summary-list">
        {files.map((file) => {
          const { fileName, directory } = splitChangesSummaryPath(file.path)
          const openPath = onOpenFile ? resolveWorkspaceRelativeFilePath(workspacePath, file.path) : null
          const fileContent = (
            <>
              <div className="changes-summary-file-copy" title={file.path}>
                <span className="changes-summary-name">{fileName}</span>
                {directory ? <span className="changes-summary-path">{directory}</span> : null}
              </div>
              <div className="changes-summary-stats">
                {file.addedLines > 0 && (
                  <span className="structured-diff-stat is-added">{`+${file.addedLines}`}</span>
                )}
                {file.removedLines > 0 && (
                  <span className="structured-diff-stat is-removed">{`-${file.removedLines}`}</span>
                )}
              </div>
            </>
          )

          return openPath ? (
            <button
              key={file.path}
              type="button"
              className="changes-summary-file changes-summary-file-button"
              title={file.path}
              aria-label={labels.openFile(file.path)}
              data-open-file-path={openPath}
              onClick={() => onOpenFile?.(openPath)}
            >
              {fileContent}
            </button>
          ) : (
            <div key={file.path} className="changes-summary-file">
              {fileContent}
            </div>
          )
        })}
      </div>
    </section>
  )
}
