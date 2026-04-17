import { memo, useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  getChatMessageAttachments,
  getImageAttachmentUrl,
} from '../../shared/chat-attachments'
import {
  formatLocalizedTime,
  getLocaleText,
  getMessageLabel,
} from '../../shared/i18n'
import type { AppLanguage, ChatMessage, ImageAttachment } from '../../shared/schema'
import {
  parseStructuredAskUserMessage,
  parseStructuredCommandMessage,
  parseStructuredEditsMessage,
  parseStructuredReasoningMessage,
  parseStructuredTodoMessage,
  parseStructuredToolMessage,
} from './chat-card-parsing'
import {
  getStreamingLabel,
  getStructuredLabels,
  renderMarkdown,
  summarizeReasoningPreview,
} from './chat-card-rendering'
import { CloseIcon, GitBranchIcon } from './Icons'
import {
  AskUserQuestionCard,
  ChangesSummaryCard,
  StructuredCommandCard,
  StructuredEditsCard,
  StructuredPreviewBlock,
  StructuredTodoCard,
  StructuredToolCard,
} from './StructuredBlocks'
import type { ChangesSummaryFile } from './StructuredBlocks'
import { areMessageBubblePropsEqual, type MessageBubbleProps } from './message-bubble-memo'

const parseChangesSummaryFiles = (raw: string | undefined): ChangesSummaryFile[] => {
  try {
    const parsed = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed as ChangesSummaryFile[] : []
  } catch {
    return []
  }
}

type PreviewAttachment = {
  attachment: ImageAttachment
  altText: string
}

const MessageAttachmentPreviewDialog = ({
  language,
  preview,
  onClose,
}: {
  language: AppLanguage
  preview: PreviewAttachment
  onClose: () => void
}) => {
  const labels = getStructuredLabels(language)
  const titleId = useId()

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const dialogLayer = (
    <div className="structured-preview-layer">
      <div
        className="structured-preview-backdrop"
        onClick={onClose}
      />
      <section
        className="structured-preview-dialog message-attachment-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="structured-preview-card message-attachment-preview-card">
          <div className="structured-preview-header">
            <div className="structured-preview-copy">
              <h3 id={titleId}>{preview.attachment.fileName || preview.altText}</h3>
            </div>

            <button
              type="button"
              className="btn btn-ghost structured-preview-close message-attachment-preview-close"
              onClick={onClose}
              aria-label={labels.closeDetails}
            >
              <CloseIcon />
            </button>
          </div>

          <div className="structured-preview-body message-attachment-preview-body">
            <img
              className="message-attachment-preview-image"
              src={getImageAttachmentUrl(preview.attachment.id)}
              alt={preview.altText}
            />
          </div>
        </div>
      </section>
    </div>
  )

  return typeof document !== 'undefined'
    ? createPortal(dialogLayer, document.body)
    : dialogLayer
}

const MessageAttachments = ({
  language,
  attachments,
}: {
  language: AppLanguage
  attachments: ImageAttachment[]
}) => {
  const text = getLocaleText(language)
  const labels = getStructuredLabels(language)
  const [preview, setPreview] = useState<PreviewAttachment | null>(null)

  return (
    <>
      <div className="message-attachment-list">
        {attachments.map((attachment, index) => {
          const altText = attachment.fileName || text.pastedImageAlt(index + 1)

          return (
            <button
              key={attachment.id}
              type="button"
              className="message-attachment-frame"
              aria-label={labels.openDetails(altText)}
              onClick={() => setPreview({ attachment, altText })}
            >
              <img
                className="message-attachment-image"
                src={getImageAttachmentUrl(attachment.id)}
                alt={altText}
                loading="lazy"
              />
            </button>
          )
        })}
      </div>
      {preview ? (
        <MessageAttachmentPreviewDialog
          language={language}
          preview={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  )
}

export const StreamingIndicator = ({ messages, language }: { messages: ChatMessage[]; language: AppLanguage }) => {
  const label = getStreamingLabel(messages, language)
  return (
    <div className="streaming-indicator">
      <span className="streaming-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="streaming-label">{label}</span>
    </div>
  )
}

const MessageContent = ({
  language,
  message,
  workspacePath,
  answeredOption,
  onSelectAskUserOption,
  onOpenFile,
  isStickyPreview = false,
}: {
  language: AppLanguage
  message: ChatMessage
  workspacePath: string
  answeredOption: string | null
  onSelectAskUserOption: (itemId: string, label: string) => void
  onOpenFile?: (relativePath: string) => void
  isStickyPreview?: boolean
}) => {
  if (message.meta?.kind === 'log') {
    return <pre className="message-log-text">{message.content}</pre>
  }

  if (message.meta?.kind === 'changes-summary') {
    const files = parseChangesSummaryFiles(message.meta.structuredData)
    if (files.length > 0) {
      return (
        <div className="message-content">
          <ChangesSummaryCard
            language={language}
            files={files}
            workspacePath={workspacePath}
            onOpenFile={onOpenFile}
          />
        </div>
      )
    }
  }

  const askUser = parseStructuredAskUserMessage(message)
  if (askUser) {
    return (
      <div className="message-content">
        <AskUserQuestionCard
          data={askUser}
          answeredOption={answeredOption}
          onSelectOption={(label) => onSelectAskUserOption(askUser.itemId, label)}
          language={language}
        />
      </div>
    )
  }

  const reasoning = parseStructuredReasoningMessage(message)
  if (reasoning) {
    const labels = getStructuredLabels(language)

    return (
      <div className="message-content">
        <section className="structured-reasoning-card structured-reasoning-minimal">
          <span className="structured-block-label structured-reasoning-label">{labels.thinking}</span>
          <StructuredPreviewBlock
            language={language}
            previewText={summarizeReasoningPreview(reasoning.text)}
            dialogTitle={labels.thinking}
            variant="prose"
            renderDialogContent={() => (
              <div className="structured-block-body structured-preview-prose">{renderMarkdown(reasoning.text, workspacePath)}</div>
            )}
          />
        </section>
      </div>
    )
  }

  const edits = parseStructuredEditsMessage(message)
  if (edits) {
    return (
      <div className="message-content">
        <StructuredEditsCard
          language={language}
          data={edits}
          workspacePath={workspacePath}
          onOpenFile={onOpenFile}
        />
      </div>
    )
  }

  const todo = parseStructuredTodoMessage(message)
  if (todo) {
    return (
      <div className="message-content">
        <StructuredTodoCard language={language} data={todo} />
      </div>
    )
  }

  const tool = parseStructuredToolMessage(message)
  if (tool) {
    return (
      <div className="message-content">
        <StructuredToolCard language={language} data={tool} />
      </div>
    )
  }

  const command = parseStructuredCommandMessage(message)
  if (command) {
    return (
      <div className="message-content">
        <StructuredCommandCard language={language} data={command} />
      </div>
    )
  }

  const attachments = getChatMessageAttachments(message)
  const previewText = message.content.trim()
  const hasTextContent = previewText.length > 0

  return (
    <div className={`message-content${isStickyPreview ? ' is-sticky-preview' : ''}`}>
      {attachments.length > 0 ? <MessageAttachments language={language} attachments={attachments} /> : null}
      {hasTextContent ? (
        isStickyPreview ? (
          <div className="message-sticky-preview-text">{previewText}</div>
        ) : (
          renderMarkdown(message.content, workspacePath)
        )
      ) : null}
    </div>
  )
}

const MessageBubbleView = ({
  language,
  message,
  workspacePath,
  answeredOption,
  onSelectAskUserOption,
  onOpenFile,
  isStickyToTop = false,
  onForkFromHere,
  entryRef,
}: MessageBubbleProps) => {
  const structuredKind = message.meta?.kind
  const text = getLocaleText(language)
  const showForkAction = Boolean(onForkFromHere) && message.role === 'user'

  const article = (
    <article
      className={`message message-${message.role}${structuredKind === 'log' ? ' message-is-log' : ''}${structuredKind && structuredKind !== 'log' ? ` message-is-structured message-is-${structuredKind}` : ''}${isStickyToTop ? ' is-sticky-anchor' : ''}`}
      data-message-id={message.id}
    >
      <div className="message-topline">
        <span className="message-role">{getMessageLabel(language, message)}</span>
        <time dateTime={message.createdAt}>{formatLocalizedTime(language, message.createdAt)}</time>
      </div>
      <MessageContent
        language={language}
        message={message}
        workspacePath={workspacePath}
        answeredOption={answeredOption}
        onSelectAskUserOption={onSelectAskUserOption}
        onOpenFile={onOpenFile}
        isStickyPreview={isStickyToTop && message.role === 'user'}
      />
    </article>
  )

  const action = showForkAction ? (
    <div className="message-actions message-actions-outside">
      <button
        type="button"
        className="message-fork-btn"
        title={text.forkConversation}
        aria-label={text.forkConversation}
        onClick={onForkFromHere}
      >
        <GitBranchIcon />
      </button>
    </div>
  ) : null

  const content = (
    <>
      {article}
      {action}
    </>
  )

  return (
    <div
      ref={entryRef}
      className={`message-entry message-entry-${message.role}`}
      data-renderable-id={message.id}
    >
      <div
        className={`message-entry-shell${isStickyToTop ? ' message-sticky-shell' : ''}`}
        data-sticky-message-id={isStickyToTop ? message.id : undefined}
      >
        {content}
      </div>
    </div>
  )
}

export const MessageBubble = memo(MessageBubbleView, areMessageBubblePropsEqual)
MessageBubble.displayName = 'MessageBubble'
