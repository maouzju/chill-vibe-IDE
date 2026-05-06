import { memo, startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ClipboardEvent,
  CompositionEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
} from 'react'
import { createPortal } from 'react-dom'

import {
  getImageAttachmentUrl,
  providerSupportsImageAttachments,
} from '../../shared/chat-attachments'
import {
  getLocaleText,
  getSlashCommandSourceLabel,
} from '../../shared/i18n'
import {
  BRAINSTORM_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
  MODEL_OPTIONS,
  normalizeStoredModel,
  type ModelOption,
} from '../../shared/models'
import { getReasoningOptions, normalizeReasoningEffort } from '../../shared/reasoning'
import {
  getLocalSlashCommands,
  getSlashCompletionQuery,
  isLocalSlashCommandInput,
} from '../../shared/slash-commands'
import type {
  AppLanguage,
  AutoUrgeProfile,
  ChatCard as ChatCardModel,
  ImageAttachment,
  ModelPromptRule,
  Provider,
  SlashCommand,
} from '../../shared/schema'
import {
  buildRenderableMessages,
  getAskUserAnswerKey,
  getRestoredStickyUserAnchor,
  getTopVisibleRenderableEntryId,
  getStickyRenderableUserMessageId,
  getToolGroupKey,
  type RenderableMessage,
} from './chat-card-parsing'
import { getCompactMessageWindow, type CompactMessageWindow } from './chat-card-compaction'
import {
  getAutoScrollStateAfterCardUpdate,
  getAutoScrollStateAfterObservedScroll,
  compactHistoryAutoRevealTopThresholdPx,
  getCompactedHistoryAutoRevealMode,
  getDistanceToBottom,
  getAutoScrollStateDuringProgrammaticScroll,
  getRestoredMessageListScrollPlan,
  getScrollTopToRevealChild,
  getScrollTopToRevealChildWithTopClearance,
  getProgrammaticBottomScrollTarget,
  programmaticScrollInterruptTolerancePx,
  shouldAutoRevealCompactedHistoryImmediately,
  shouldPinToBottomAfterContentGrowth,
  type ProgrammaticScrollIntent,
} from './chat-scroll'
import { syncComposerTextareaHeight } from './chat-composer-textarea'
import { createDraftSyncScheduler, draftSyncIdleMs } from './chat-draft-sync'
import { evaluateAutoUrge, getNextAutoUrgeToggleState } from './chat-auto-urge'
import { fetchSlashCommands, uploadImageAttachment } from '../api'
import { GitToolCard, type GitInfoSummary } from './GitToolCard'
import { MusicCard } from './MusicCard'
import { WhiteNoiseCard } from './WhiteNoiseCard'
import { WeatherCard } from './WeatherCard'
import { StickyNoteCard } from './StickyNoteCard'
import { FileTreeCard } from './FileTreeCard'
import { TextEditorCard } from './TextEditorCard'
import { BrainstormCard } from './BrainstormCard'
import { resolveBrainstormRequestTarget } from './brainstorm-card-utils'
import { getLatestUserAnswerAfterAskUserMessage } from './ask-user-answer-state'
import { formatAskUserFollowUpPrompt } from './ask-user-follow-up'
import { HoverTooltip } from './HoverTooltip'
import {
  areSlashCommandListsEqual,
  getSlashCommandsLoadKey,
  resolveSlashMenuDismissedAfterQueryChange,
  resolveSlashCommandsLoadKeyAfterCancel,
  resolveRemoteSlashCommands,
  shouldStartSlashCommandsLoad,
} from './chat-card-slash-commands'
import {
  shouldShowManualStreamRecoveryControl,
  type CardRecoveryStatus,
} from '../stream-recovery-feedback'
import type { QueuedSendSummary, SendMessageOptions } from './deferred-send-queue'
import { MessageBubble, StreamingIndicator } from './MessageBubble'
import {
  StructuredToolGroupCard,
} from './StructuredBlocks'
import {
  ClaudeIcon,
  CloudIcon,
  CloseIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  GptIcon,
  HeadphonesIcon,
  IconButton,
  MusicIcon,
  NeteaseCloudMusicIcon,
  RefreshIcon,
  SendIcon,
  SlidersIcon,
  SparklesIcon,
  StickyNoteIcon,
  StopIcon,
} from './Icons'

let lastFocusedCardId: string | null = null
const supportedImageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const emptyCompactMessageWindow: CompactMessageWindow = {
  hiddenMessageCount: 0,
  compactMessageId: null,
  hiddenReason: null,
  compactTrigger: null,
  visibleMessages: [],
}
const compactHistoryRevealBatchSize = 32

type PendingAttachment =
  | {
      kind: 'local'
      id: string
      file: File
      previewUrl: string
    }
  | {
      kind: 'uploaded'
      id: string
      attachment: ImageAttachment
      previewUrl: string
    }

type EmptyStateToolEntry = {
  model: string
  title: string
  description: string
  icon: ReactNode
}

const getCompactionBannerCopy = (
  language: AppLanguage,
  hiddenMessageCount: number,
  hiddenReason: CompactMessageWindow['hiddenReason'],
  compactTrigger: CompactMessageWindow['compactTrigger'],
) => {
  const isPerformanceWindow = hiddenReason === 'performance'
  const isAutoCompact = hiddenReason === 'compact' && compactTrigger === 'auto'

  if (language === 'en') {
    return {
      message: `${hiddenMessageCount} earlier ${
        hiddenMessageCount === 1 ? 'message is' : 'messages are'
      } ${
        isPerformanceWindow
          ? 'temporarily hidden to keep long chats responsive.'
          : isAutoCompact
            ? 'hidden after automatic context compaction. You are viewing the compacted segment now.'
            : 'hidden after /compact to keep the active chat lighter.'
      } Use the button below to show earlier history.`,
      action: 'Show all earlier messages',
    }
  }

  if (isAutoCompact) {
    return {
      message: `\u5df2\u5728\u81ea\u52a8\u4e0a\u4e0b\u6587\u538b\u7f29\u540e\u6298\u53e0\u66f4\u65e9\u7684 ${hiddenMessageCount} \u6761\u6d88\u606f\u3002\u4f60\u5f53\u524d\u770b\u5230\u7684\u662f\u538b\u7f29\u540e\u7684\u7247\u6bb5\uff0c\u5982\u9700\u67e5\u770b\u66f4\u65e9\u5386\u53f2\uff0c\u8bf7\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u3002`,
      action: '\u663e\u793a\u5168\u90e8\u66f4\u65e9\u6d88\u606f',
    }
  }

  return {
    message: isPerformanceWindow
      ? `\u5df2\u4e34\u65f6\u6298\u53e0\u66f4\u65e9\u7684 ${hiddenMessageCount} \u6761\u6d88\u606f\uff0c\u51cf\u5c11\u8d85\u957f\u4f1a\u8bdd\u7684\u6e32\u67d3\u8d1f\u62c5\u3002\u5982\u9700\u67e5\u770b\u66f4\u65e9\u5386\u53f2\uff0c\u8bf7\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u3002`
      : `\u5df2\u5728 /compact \u540e\u6298\u53e0\u66f4\u65e9\u7684 ${hiddenMessageCount} \u6761\u6d88\u606f\uff0c\u51cf\u5c11\u5f53\u524d\u804a\u5929\u5361\u7247\u7684\u6e32\u67d3\u8d1f\u62c5\u3002\u5982\u9700\u67e5\u770b\u66f4\u65e9\u5386\u53f2\uff0c\u8bf7\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u3002`,
    action: '\u663e\u793a\u5168\u90e8\u66f4\u65e9\u6d88\u606f',
  }

}
type ChatCardProps = {
  card: ChatCardModel
  providerReady: boolean
  workspacePath: string
  language: AppLanguage
  systemPrompt: string
  modelPromptRules?: ModelPromptRule[]
  crossProviderSkillReuseEnabled: boolean
  musicAlbumCoverEnabled: boolean
  weatherCity: string
  gitAgentModel: string
  brainstormRequestModel: string
  availableQuickToolModels: string[]
  autoUrgeEnabled: boolean
  autoUrgeProfiles?: AutoUrgeProfile[]
  autoUrgeMessage: string
  autoUrgeSuccessKeyword: string
  queuedSendSummary?: QueuedSendSummary
  onSetAutoUrgeEnabled: (enabled: boolean) => void
  onRemove: () => void
  onSend: (
    prompt: string,
    attachments: ImageAttachment[],
    options?: SendMessageOptions,
  ) => Promise<void>
  onStop: () => Promise<void>
  onCancelQueuedSends?: () => void
  onSendNextQueuedNow?: () => void
  onManualRecoverStream?: () => void
  onDraftChange: (draft: string) => void
  onChangeModel: (provider: Provider, model: string) => void
  onChangeReasoningEffort: (reasoningEffort: string) => void
  onTogglePlanMode: () => void
  onToggleThinking: () => void
  onToggleCollapsed: () => void
  onMarkRead: () => void
  onStickyNoteChange: (content: string) => void
  onPatchCard: (
    patch: Partial<
      Pick<
        ChatCardModel,
        | 'status'
        | 'sessionId'
        | 'brainstorm'
        | 'autoUrgeActive'
        | 'autoUrgeProfileId'
        | 'draftAttachments'
      >
    >,
  ) => void
  onChangeTitle: (title: string) => void
  onForkConversation?: (messageId: string) => void
  onOpenFile?: (relativePath: string) => void
  isRestored: boolean
  onRestoredAnimationEnd: () => void
  chromeMode?: 'card' | 'pane'
  isActive?: boolean
  composerFocusRequest?: number
  recoveryStatus?: CardRecoveryStatus
}

const getSelectValue = (provider: Provider, model: string) =>
  `${provider}:${normalizeStoredModel(provider, model)}`

const getCustomModelOption = (provider: Provider, model: string): ModelOption | null => {
  const normalized = normalizeStoredModel(provider, model)

  if (!normalized) {
    return null
  }

  if (MODEL_OPTIONS.some((option) => option.provider === provider && option.model === normalized)) {
    return null
  }

  return {
    provider,
    model: normalized,
    label: normalized,
  }
}

const getModelOptionIcon = (option: ModelOption): ReactNode => {
  if (option.model === GIT_TOOL_MODEL) {
    return <GitBranchIcon className="model-option-icon" aria-hidden="true" />
  }
  if (option.model === MUSIC_TOOL_MODEL) {
    return <MusicIcon className="model-option-icon" aria-hidden="true" />
  }
  if (option.model === WHITENOISE_TOOL_MODEL) {
    return <HeadphonesIcon className="model-option-icon" aria-hidden="true" />
  }
  if (option.model === WEATHER_TOOL_MODEL) {
    return <CloudIcon className="model-option-icon" aria-hidden="true" />
  }
  if (option.model === STICKYNOTE_TOOL_MODEL) {
    return <StickyNoteIcon className="model-option-icon" aria-hidden="true" />
  }
  if (option.model === FILETREE_TOOL_MODEL) {
    return <FolderIcon className="model-option-icon" aria-hidden="true" />
  }
  if (option.model === BRAINSTORM_TOOL_MODEL) {
    return <SparklesIcon className="model-option-icon" aria-hidden="true" />
  }
  if (option.model === TEXTEDITOR_TOOL_MODEL) {
    return <FileTextIcon className="model-option-icon" aria-hidden="true" />
  }
  if (option.provider === 'claude') {
    return <ClaudeIcon className="model-option-icon" aria-hidden="true" />
  }
  return <GptIcon className="model-option-icon" aria-hidden="true" />
}

const hiddenModelPickerToolModels = new Set([
  GIT_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
])
const hiddenBrainstormRequestModels = new Set([
  GIT_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  BRAINSTORM_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
])
const getEmptyStateToolEntry = (
  model: string,
  text: ReturnType<typeof getLocaleText>,
): EmptyStateToolEntry | null => {
  if (model === GIT_TOOL_MODEL) {
    return {
      model,
      title: 'Git',
      description: text.emptyStateGitDescription,
      icon: <GitBranchIcon aria-hidden="true" />,
    }
  }

  if (model === STICKYNOTE_TOOL_MODEL) {
    return {
      model,
      title: text.stickyNoteTitle,
      description: text.emptyStateStickyDescription,
      icon: <StickyNoteIcon aria-hidden="true" />,
    }
  }

  if (model === FILETREE_TOOL_MODEL) {
    return {
      model,
      title: text.emptyStateFilesTitle,
      description: text.emptyStateFilesDescription,
      icon: <FolderIcon aria-hidden="true" />,
    }
  }


  if (model === BRAINSTORM_TOOL_MODEL) {
    return {
      model,
      title: text.brainstormTitle,
      description: text.emptyStateBrainstormDescription,
      icon: <SparklesIcon aria-hidden="true" />,
    }
  }

  if (model === WEATHER_TOOL_MODEL) {
    return {
      model,
      title: text.weatherCardLabel,
      description: text.emptyStateWeatherDescription,
      icon: <CloudIcon aria-hidden="true" />,
    }
  }

  if (model === MUSIC_TOOL_MODEL) {
    return {
      model,
      title: text.experimentalMusicLabel,
      description: text.emptyStateMusicDescription,
      icon: <NeteaseCloudMusicIcon aria-hidden="true" />,
    }
  }

  if (model === WHITENOISE_TOOL_MODEL) {
    return {
      model,
      title: text.experimentalWhiteNoiseLabel,
      description: text.emptyStateWhiteNoiseDescription,
      icon: <HeadphonesIcon aria-hidden="true" />,
    }
  }

  return null
}

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }

      reject(new Error('Unable to read the pasted image.'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read the pasted image.'))
    reader.readAsDataURL(file)
  })

const uploadPendingImage = async (attachment: PendingAttachment): Promise<ImageAttachment> => {
  if (attachment.kind === 'uploaded') {
    return attachment.attachment
  }

  const dataUrl = await readFileAsDataUrl(attachment.file)
  const base64Index = dataUrl.indexOf(',')

  if (base64Index < 0) {
    throw new Error('Unable to read the pasted image.')
  }

  return uploadImageAttachment({
    fileName: attachment.file.name,
    mimeType: attachment.file.type as ImageAttachment['mimeType'],
    dataBase64: dataUrl.slice(base64Index + 1),
  })
}

const hydrateDraftAttachments = (attachments: ImageAttachment[]): PendingAttachment[] =>
  attachments.map((attachment) => ({
    kind: 'uploaded',
    id: attachment.id,
    attachment,
    previewUrl: getImageAttachmentUrl(attachment.id),
  }))

const cardHeaderControlSelector =
  'button, label, select, input, textarea, a, [role="button"], [role="link"], [contenteditable="true"], [data-card-header-control="true"]'

const isCardHeaderControlTarget = (target: EventTarget | null) =>
  target instanceof Element && target.closest(cardHeaderControlSelector) !== null

const areChatCardPropsEqual = (previous: ChatCardProps, next: ChatCardProps) =>
  previous.card === next.card &&
  previous.providerReady === next.providerReady &&
  previous.workspacePath === next.workspacePath &&
  previous.language === next.language &&
  previous.systemPrompt === next.systemPrompt &&
  previous.crossProviderSkillReuseEnabled === next.crossProviderSkillReuseEnabled &&
  previous.musicAlbumCoverEnabled === next.musicAlbumCoverEnabled &&
  previous.weatherCity === next.weatherCity &&
  previous.gitAgentModel === next.gitAgentModel &&
  previous.brainstormRequestModel === next.brainstormRequestModel &&
  previous.availableQuickToolModels === next.availableQuickToolModels &&
  previous.autoUrgeEnabled === next.autoUrgeEnabled &&
  previous.autoUrgeProfiles === next.autoUrgeProfiles &&
  previous.autoUrgeMessage === next.autoUrgeMessage &&
  previous.autoUrgeSuccessKeyword === next.autoUrgeSuccessKeyword &&
  previous.queuedSendSummary === next.queuedSendSummary &&
  previous.isRestored === next.isRestored &&
  previous.chromeMode === next.chromeMode &&
  previous.isActive === next.isActive &&
  previous.composerFocusRequest === next.composerFocusRequest &&
  previous.recoveryStatus === next.recoveryStatus &&
  previous.onManualRecoverStream === next.onManualRecoverStream

type ChatTranscriptProps = {
  isActive: boolean
  language: AppLanguage
  workspacePath: string
  cardStatus: ChatCardModel['status']
  recoveryStatus?: CardRecoveryStatus
  onManualRecoverStream?: () => void
  messages: ChatCardModel['messages']
  messageListRef: RefObject<HTMLDivElement | null>
  renderableMessages: RenderableMessage[]
  restoreBottomSpacerPx: number
  compactionBannerCopy: ReturnType<typeof getCompactionBannerCopy> | null
  collapsedGroups: Set<string>
  showsQuickToolGrid: boolean
  quickToolEntries: EmptyStateToolEntry[]
  emptyStateToolsLabel: string
  askUserAnswers: Record<string, string>
  onScroll: () => void
  onRevealAllCompactedHistory: () => void
  onRevealMoreCompactedHistory: () => void
  onActivateQuickTool: (entry: EmptyStateToolEntry) => void
  onToggleToolGroup: (key: string) => void
  onSelectAskUserOption: (answerKey: string, label: string) => void
  onJumpToStickyMessageSource: (targetScrollTop: number) => void
  onOpenFile?: (relativePath: string) => void
  onForkConversation?: (messageId: string) => void
}

const ChatTranscript = memo(
  ({
    isActive,
    language,
    workspacePath,
    cardStatus,
    recoveryStatus,
    onManualRecoverStream,
    messages,
    messageListRef,
    renderableMessages,
    restoreBottomSpacerPx,
    compactionBannerCopy,
    collapsedGroups,
    showsQuickToolGrid,
    quickToolEntries,
    emptyStateToolsLabel,
    askUserAnswers,
    onScroll,
    onRevealAllCompactedHistory,
    onRevealMoreCompactedHistory,
    onActivateQuickTool,
    onToggleToolGroup,
    onSelectAskUserOption,
    onJumpToStickyMessageSource,
    onOpenFile,
    onForkConversation,
  }: ChatTranscriptProps) => {
    const renderableEntryRefs = useRef(new Map<string, HTMLElement>())
    const stickySyncFrameRef = useRef<number | null>(null)
    const scrollWatchFrameRef = useRef<number | null>(null)
    const observedScrollTopRef = useRef<number | null>(null)
    const stickyPreviewRef = useRef<HTMLDivElement | null>(null)
    const [stickyMessageId, setStickyMessageId] = useState<string | null>(null)

    const registerRenderableEntry = useCallback((entryId: string, node: HTMLElement | null) => {
      if (node) {
        renderableEntryRefs.current.set(entryId, node)
        return
      }

      renderableEntryRefs.current.delete(entryId)
    }, [])

    const syncStickyMessageId = useCallback(() => {
      const messageList = messageListRef.current
      if (!messageList) {
        setStickyMessageId(null)
        return
      }

      const messageListTop = messageList.getBoundingClientRect().top + 1
      const activeContentEntryId = getTopVisibleRenderableEntryId(renderableMessages, (entryId) => {
        const entryNode = renderableEntryRefs.current.get(entryId)
        if (!entryNode) {
          return false
        }

        return entryNode.getBoundingClientRect().bottom > messageListTop
      })

      const nextStickyMessageId = getStickyRenderableUserMessageId(renderableMessages, activeContentEntryId)
      setStickyMessageId((current) => (current === nextStickyMessageId ? current : nextStickyMessageId))
    }, [messageListRef, renderableMessages])

    const scheduleStickyMessageIdSync = useCallback(() => {
      if (!isActive) {
        setStickyMessageId(null)
        return
      }

      if (typeof window === 'undefined') {
        syncStickyMessageId()
        return
      }

      if (stickySyncFrameRef.current !== null) {
        window.cancelAnimationFrame(stickySyncFrameRef.current)
      }

      stickySyncFrameRef.current = window.requestAnimationFrame(() => {
        stickySyncFrameRef.current = null
        syncStickyMessageId()
      })
    }, [isActive, syncStickyMessageId])

    const handleScroll = useCallback(() => {
      onScroll()
      const messageList = messageListRef.current
      if (
        isActive &&
        compactionBannerCopy &&
        messageList &&
        shouldAutoRevealCompactedHistoryImmediately(
          getCompactedHistoryAutoRevealMode(messageList, compactHistoryAutoRevealTopThresholdPx),
        )
      ) {
        onRevealMoreCompactedHistory()
      }
      scheduleStickyMessageIdSync()
    }, [
      compactionBannerCopy,
      isActive,
      messageListRef,
      onRevealMoreCompactedHistory,
      onScroll,
      scheduleStickyMessageIdSync,
    ])

    useLayoutEffect(() => {
      if (!isActive || !compactionBannerCopy) {
        return
      }

      const messageList = messageListRef.current
      if (!messageList) {
        return
      }

      if (
        shouldAutoRevealCompactedHistoryImmediately(
          getCompactedHistoryAutoRevealMode(
            {
              scrollTop: messageList.scrollTop,
              scrollHeight: messageList.scrollHeight,
              clientHeight: messageList.clientHeight,
            },
            compactHistoryAutoRevealTopThresholdPx,
          ),
        )
      ) {
        onRevealMoreCompactedHistory()
      }
    }, [compactionBannerCopy, isActive, messageListRef, onRevealMoreCompactedHistory])

    useLayoutEffect(() => {
      if (!isActive) {
        return
      }

      if (stickySyncFrameRef.current !== null) {
        window.cancelAnimationFrame(stickySyncFrameRef.current)
      }

      stickySyncFrameRef.current = window.requestAnimationFrame(() => {
        stickySyncFrameRef.current = null
        syncStickyMessageId()
      })

      return () => {
        if (stickySyncFrameRef.current !== null) {
          window.cancelAnimationFrame(stickySyncFrameRef.current)
          stickySyncFrameRef.current = null
        }
      }
    }, [isActive, syncStickyMessageId])

    useLayoutEffect(() => {
      if (!isActive) {
        observedScrollTopRef.current = null
        return
      }

      if (typeof window === 'undefined') {
        return
      }

      const node = messageListRef.current
      if (!node) {
        return
      }

      observedScrollTopRef.current = node.scrollTop

      if (scrollWatchFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollWatchFrameRef.current)
      }

      let remainingFrames = 18
      const watchScrollTop = () => {
        const currentNode = messageListRef.current
        if (!currentNode) {
          return
        }

        const currentScrollTop = currentNode.scrollTop
        if (
          observedScrollTopRef.current !== null &&
          Math.abs(currentScrollTop - observedScrollTopRef.current) > 0.5
        ) {
          observedScrollTopRef.current = currentScrollTop
          handleScroll()
        }

        remainingFrames -= 1
        if (remainingFrames > 0) {
          scrollWatchFrameRef.current = window.requestAnimationFrame(watchScrollTop)
        } else {
          scrollWatchFrameRef.current = null
        }
      }

      scrollWatchFrameRef.current = window.requestAnimationFrame(watchScrollTop)

      return () => {
        if (scrollWatchFrameRef.current !== null) {
          window.cancelAnimationFrame(scrollWatchFrameRef.current)
          scrollWatchFrameRef.current = null
        }
      }
    }, [handleScroll, isActive, messageListRef, renderableMessages])

    useEffect(() => {
      if (!isActive) {
        return
      }

      if (typeof ResizeObserver === 'undefined') {
        return
      }

      const resizeObserver = new ResizeObserver(() => {
        scheduleStickyMessageIdSync()
      })

      const messageListNode = messageListRef.current
      if (messageListNode) {
        resizeObserver.observe(messageListNode)
      }

      for (const node of renderableEntryRefs.current.values()) {
        resizeObserver.observe(node)
      }

      return () => {
        resizeObserver.disconnect()
      }
    }, [isActive, messageListRef, renderableMessages, scheduleStickyMessageIdSync])

    const stickyMessage = useMemo(() => {
      if (!stickyMessageId) {
        return null
      }

      for (const entry of renderableMessages) {
        if (entry.type === 'message' && entry.message.id === stickyMessageId) {
          return entry.message
        }
      }

      return null
    }, [renderableMessages, stickyMessageId])

    const stickyJumpLabel =
      language === 'en' ? 'Jump to the original prompt position' : '\u8df3\u5230\u539f\u6d88\u606f\u4f4d\u7f6e'

    const handleJumpToStickyMessage = useCallback(() => {
      if (!stickyMessageId) {
        return
      }

      const messageList = messageListRef.current
      const stickySourceEntry = renderableEntryRefs.current.get(stickyMessageId)
      if (!messageList || !stickySourceEntry) {
        return
      }

      const messageListRect = messageList.getBoundingClientRect()
      const stickySourceRect = stickySourceEntry.getBoundingClientRect()
      const stickyPreviewHeight = stickyPreviewRef.current?.offsetHeight ?? 0
      const nextScrollTop = getScrollTopToRevealChildWithTopClearance(
        {
          scrollTop: messageList.scrollTop,
          clientHeight: messageList.clientHeight,
        },
        {
          offsetTop: stickySourceRect.top - messageListRect.top + messageList.scrollTop,
          offsetHeight: stickySourceRect.height,
        },
        stickyPreviewHeight + 12,
      )

      onJumpToStickyMessageSource(nextScrollTop)
    }, [messageListRef, onJumpToStickyMessageSource, stickyMessageId])

    const handleStickyPreviewKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }

      event.preventDefault()
      handleJumpToStickyMessage()
    }, [handleJumpToStickyMessage])

    return (
      <>
        <div className="message-transcript-shell">
          {isActive && stickyMessage ? (
            <div className="message-sticky-overlay">
              <div
                ref={stickyPreviewRef}
                className="message-sticky-jump-target"
                role="button"
                tabIndex={0}
                aria-label={stickyJumpLabel}
                title={stickyJumpLabel}
                onClick={handleJumpToStickyMessage}
                onKeyDown={handleStickyPreviewKeyDown}
              >
                <div aria-hidden="true">
                  <MessageBubble
                    language={language}
                    message={stickyMessage}
                    workspacePath={workspacePath}
                    answeredOption={askUserAnswers[getAskUserAnswerKey(stickyMessage)] ?? null}
                    onSelectAskUserOption={onSelectAskUserOption}
                    isStickyToTop
                  />
                </div>
              </div>
            </div>
          ) : null}
          <div
            ref={messageListRef}
            className={`message-list${cardStatus === 'streaming' ? ' is-streaming' : ''}${showsQuickToolGrid ? ' is-empty-state' : ''}`}
            onScroll={isActive ? handleScroll : undefined}
          >
            {compactionBannerCopy ? (
              <article className="message message-system">
                <div className="message-content">
                  <p>{compactionBannerCopy.message}</p>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={onRevealAllCompactedHistory}
                  >
                    {compactionBannerCopy.action}
                  </button>
                </div>
              </article>
            ) : null}

            {showsQuickToolGrid ? (
              <div className="chat-empty-tool-grid" role="list" aria-label={emptyStateToolsLabel}>
                {quickToolEntries.map((entry) => (
                  <button
                    key={entry.model}
                    type="button"
                    className="chat-empty-tool-button"
                    onClick={() => onActivateQuickTool(entry)}
                  >
                    <span className="chat-empty-tool-icon">{entry.icon}</span>
                    <span className="chat-empty-tool-copy">
                      <span className="chat-empty-tool-title">{entry.title}</span>
                      <span className="chat-empty-tool-description">{entry.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            {renderableMessages.map((entry, idx) => {
              if (entry.type === 'tool-group') {
                const groupKey = getToolGroupKey(entry.items)
                const isLastGroupAndStreaming =
                  cardStatus === 'streaming' && idx === renderableMessages.length - 1
                const effectiveCollapsed = collapsedGroups.has(groupKey) && !isLastGroupAndStreaming
                return (
                  <StructuredToolGroupCard
                    key={groupKey}
                    entryId={groupKey}
                    entryRef={(node) => registerRenderableEntry(groupKey, node)}
                    language={language}
                    workspacePath={workspacePath}
                    items={entry.items}
                    collapsed={effectiveCollapsed}
                    onToggle={() => onToggleToolGroup(groupKey)}
                    onOpenFile={onOpenFile}
                  />
                )
              }

              return (
                <MessageBubble
                  key={entry.message.id}
                  entryRef={(node) => registerRenderableEntry(entry.message.id, node)}
                  language={language}
                  message={entry.message}
                  workspacePath={workspacePath}
                  answeredOption={
                    askUserAnswers[getAskUserAnswerKey(entry.message)] ??
                    (entry.message.meta?.kind === 'ask-user'
                      ? getLatestUserAnswerAfterAskUserMessage(messages, entry.message)
                      : null)
                  }
                  onSelectAskUserOption={onSelectAskUserOption}
                  onOpenFile={onOpenFile}
                  onForkFromHere={
                    onForkConversation && entry.message.role === 'user'
                      ? () => onForkConversation(entry.message.id)
                      : undefined
                  }
                />
              )
            })}
            {restoreBottomSpacerPx > 0 ? (
              <div
                aria-hidden="true"
                className="message-list-restore-spacer"
                style={{ height: `${restoreBottomSpacerPx}px`, flex: '0 0 auto' }}
              />
            ) : null}
          </div>
        </div>

        {cardStatus === 'streaming' || recoveryStatus?.kind === 'failed' ? (
          <StreamingIndicator
            messages={messages}
            language={language}
            recoveryStatus={recoveryStatus}
            onManualRecoverStream={onManualRecoverStream}
          />
        ) : null}
      </>
    )
  },
)
ChatTranscript.displayName = 'ChatTranscript'

const ChatCardView = ({
  card,
  providerReady,
  workspacePath,
  language,
  systemPrompt,
  modelPromptRules = [],
  crossProviderSkillReuseEnabled,
  musicAlbumCoverEnabled,
  weatherCity,
  gitAgentModel,
  brainstormRequestModel,
  availableQuickToolModels = [],
  autoUrgeEnabled,
  autoUrgeProfiles = [],
  autoUrgeMessage,
  autoUrgeSuccessKeyword,
  queuedSendSummary,
  onSetAutoUrgeEnabled,
  onRemove,
  onSend,
  onStop,
  onCancelQueuedSends,
  onSendNextQueuedNow,
  onDraftChange,
  onChangeModel,
  onChangeReasoningEffort,
  onTogglePlanMode,
  onToggleThinking,
  onToggleCollapsed,
  onMarkRead,
  onStickyNoteChange,
  onPatchCard,
  onChangeTitle,
  onForkConversation,
  onOpenFile,
  onManualRecoverStream,
  isRestored,
  onRestoredAnimationEnd,
  chromeMode = 'card',
  isActive = true,
  composerFocusRequest = 0,
  recoveryStatus,
}: ChatCardProps) => {
  const text = useMemo(() => getLocaleText(language), [language])/*
  const thinkingDepthLabel = language === 'en' ? 'Thinking depth' : '鎬濊€冩繁搴?
*/
  const thinkingDepthLabel = language === 'en' ? 'Thinking depth' : '\u601d\u8003\u6df1\u5ea6'
  const localSlashCommands = useMemo(() => getLocalSlashCommands(language), [language])
  const localSlashCommandsRef = useRef(localSlashCommands)
  const draftValueRef = useRef(card.draft ?? '')
  const draftHasTextRef = useRef(draftValueRef.current.trim().length > 0)
  const slashDraftRef = useRef(
    draftValueRef.current.trimStart().startsWith('/') ? draftValueRef.current : '',
  )
  const [draftHasText, setDraftHasText] = useState(() => draftHasTextRef.current)
  const [slashDraft, setSlashDraft] = useState(() => slashDraftRef.current)
  const [remoteSlashCommands, setRemoteSlashCommands] = useState<SlashCommand[]>(localSlashCommands)
  const [slashCommandsStatus, setSlashCommandsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const slashCommandsStatusRef = useRef(slashCommandsStatus)
  const slashCommandsLoadKeyRef = useRef<string | null>(null)
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0)
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>(() =>
    hydrateDraftAttachments(card.draftAttachments ?? []),
  )
  const [composerError, setComposerError] = useState<string | null>(null)
  const [askUserAnswers, setAskUserAnswers] = useState<Record<string, string>>({})
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingTitleValue, setEditingTitleValue] = useState('')
  const prevCardStatusRef = useRef(card.status)
  const pendingImmediateAutoUrgeRef = useRef(false)
  const [autoUrgeActive, setAutoUrgeActive] = useState(() => card.autoUrgeActive === true)
  const [selectedAutoUrgeProfileId, setSelectedAutoUrgeProfileId] = useState(
    () => card.autoUrgeProfileId,
  )
  const activeAutoUrgeProfile = useMemo(
    () =>
      autoUrgeProfiles.find((profile) => profile.id === selectedAutoUrgeProfileId) ??
      autoUrgeProfiles[0] ??
      null,
    [autoUrgeProfiles, selectedAutoUrgeProfileId],
  )
  const effectiveAutoUrgeProfileId = activeAutoUrgeProfile?.id ?? ''
  const effectiveAutoUrgeMessage = activeAutoUrgeProfile?.message ?? autoUrgeMessage
  const effectiveAutoUrgeSuccessKeyword =
    activeAutoUrgeProfile?.successKeyword ?? autoUrgeSuccessKeyword
  const composerAutoUrgeChecked = autoUrgeEnabled && autoUrgeActive
  const autoUrgeStateRef = useRef({
    messages: card.messages,
    active: autoUrgeActive,
    enabled: autoUrgeEnabled,
    message: effectiveAutoUrgeMessage,
    successKeyword: effectiveAutoUrgeSuccessKeyword,
  })
  const titleInputRef = useRef<HTMLInputElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
  const settingsDropdownRef = useRef<HTMLDivElement>(null)
  const activeSlashItemRef = useRef<HTMLButtonElement>(null)
  const slashMenuElRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerResizeFrameRef = useRef<number | null>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const shouldStartPinnedToBottom = isRestored || card.status === 'streaming' || card.messages.length === 0
  const shouldAutoScrollRef = useRef(shouldStartPinnedToBottom)
  const previousAutoScrollCardIdRef = useRef(card.id)
  const lastScrollTopRef = useRef(0)
  const autoScrollFrameRef = useRef<number | null>(null)
  const programmaticScrollGuardRef = useRef(false)
  const programmaticScrollGuardFrameRef = useRef<number | null>(null)
  const programmaticScrollIntentRef = useRef<ProgrammaticScrollIntent | null>(null)
  const lastMessageListMetricsRef = useRef<{
    scrollHeight: number
    clientHeight: number
  } | null>(null)
  const restoredScrollBootstrapCardIdRef = useRef<string | null>(null)
  const restoredAnchorLockedCardIdRef = useRef<string | null>(null)
  const pendingRestoredAnchorScrollTopRef = useRef<number | null>(null)
  const [restoredScrollSpacerPx, setRestoredScrollSpacerPx] = useState(0)

  useEffect(() => {
    shouldAutoScrollRef.current = getAutoScrollStateAfterCardUpdate({
      previousCardId: previousAutoScrollCardIdRef.current,
      currentCardId: card.id,
      previousShouldAutoScroll: shouldAutoScrollRef.current,
      shouldStartPinnedToBottom,
      isRestoredAnchorLocked: restoredAnchorLockedCardIdRef.current === card.id,
    })
    previousAutoScrollCardIdRef.current = card.id
  }, [card.id, shouldStartPinnedToBottom])
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([])
  const composingRef = useRef(false)
  const compositionEndUnlockHandleRef = useRef<number | null>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const hasWorkspacePath = workspacePath.trim().length > 0
  const openFileHandlerRef = useRef(onOpenFile)
  openFileHandlerRef.current = onOpenFile
  const providerCanSendImages = providerSupportsImageAttachments(card.provider)
  const isGitToolCard = card.model === GIT_TOOL_MODEL
  const isMusicToolCard = card.model === MUSIC_TOOL_MODEL
  const isWhiteNoiseCard = card.model === WHITENOISE_TOOL_MODEL
  const isWeatherCard = card.model === WEATHER_TOOL_MODEL
  const isStickyNoteCard = card.model === STICKYNOTE_TOOL_MODEL
  const isFileTreeCard = card.model === FILETREE_TOOL_MODEL
  const isBrainstormCard = card.model === BRAINSTORM_TOOL_MODEL
  const isTextEditorCard = card.model === TEXTEDITOR_TOOL_MODEL
  const isTopbarToolCard = isMusicToolCard || isWhiteNoiseCard || isWeatherCard
  const isToolCard =
    isGitToolCard ||
    isMusicToolCard ||
    isWhiteNoiseCard ||
    isWeatherCard ||
    isStickyNoteCard ||
    isFileTreeCard ||
    isBrainstormCard ||
    isTextEditorCard
  const usesPaneChrome = chromeMode === 'pane'
  const suspendPaneRuntimeEffects = usesPaneChrome && !isActive
  const deferInactivePaneChatBody = suspendPaneRuntimeEffects && !isToolCard
  const slashCommandsEnabled = !usesPaneChrome || isActive
  const [musicTitleOverride, setMusicTitleOverride] = useState<string | null>(null)
  const [gitAgentPanelOpen, setGitAgentPanelOpen] = useState(false)
  const [gitInfo, setGitInfo] = useState<GitInfoSummary | null>(null)
  const [modelMenuStyle, setModelMenuStyle] = useState<{
    top: number
    left: number
    minWidth: number
    maxWidth: number
    maxHeight: number
  } | null>(null)
  const [settingsMenuStyle, setSettingsMenuStyle] = useState<{ top: number; left: number; maxWidth: number } | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [revealedCompactedHistoryCount, setRevealedCompactedHistoryCount] = useState(0)
  const pendingCompactedHistoryRevealRef = useRef<{
    scrollHeight: number
    scrollTop: number
  } | null>(null)
  const userExpandedRef = useRef<Set<string>>(new Set())
  const handleOpenWorkspaceFile = useCallback((relativePath: string) => {
    openFileHandlerRef.current?.(relativePath)
  }, [])
  const openFileCallback = onOpenFile ? handleOpenWorkspaceFile : undefined

  useEffect(() => {
    localSlashCommandsRef.current = localSlashCommands
  }, [localSlashCommands])

  useEffect(() => {
    slashCommandsStatusRef.current = slashCommandsStatus
  }, [slashCommandsStatus])

  const showsCardTitle =
    !usesPaneChrome &&
    !isGitToolCard &&
    !isWhiteNoiseCard &&
    !isWeatherCard &&
    !(isMusicToolCard && !musicTitleOverride)
  const showsToolFooterModelSelect = isTextEditorCard
  const showsComposerModelSelect = !isToolCard
  const showsHeaderModelSelect =
    isToolCard &&
    !isTopbarToolCard &&
    !showsToolFooterModelSelect &&
    !isGitToolCard &&
    !isStickyNoteCard &&
    !isFileTreeCard
  const showsCardHeader = showsHeaderModelSelect || showsCardTitle || (isGitToolCard && gitInfo)
  const isCollapsed = usesPaneChrome ? false : card.collapsed
  const displayTitle =
    (isMusicToolCard && musicTitleOverride ? musicTitleOverride : card.title) ||
    (isStickyNoteCard
      ? text.stickyNoteTitle
      : isBrainstormCard
        ? text.brainstormTitle
        : text.newChat)

  // Draft persistence is decoupled from the live textarea. Fast typing updates
  // the DOM and refs immediately; React state only tracks lightweight derived
  // flags so the composer does not rerender on every keystroke.
  const onDraftChangeRef = useRef(onDraftChange)
  useEffect(() => {
    onDraftChangeRef.current = onDraftChange
  }, [onDraftChange])
  const draftSyncSchedulerRef = useRef<ReturnType<typeof createDraftSyncScheduler> | null>(null)
  if (draftSyncSchedulerRef.current === null) {
    draftSyncSchedulerRef.current = createDraftSyncScheduler({
      idleMs: draftSyncIdleMs,
      onSync: (nextValue) => {
        onDraftChangeRef.current(nextValue)
      },
    })
  }
  const holdDraftSync = (nextValue: string) => {
    draftSyncSchedulerRef.current?.markPending(nextValue)
  }
  const scheduleDraftSync = (nextValue: string) => {
    draftSyncSchedulerRef.current?.schedule(nextValue)
  }
  const flushPendingDraftSync = () => {
    if (composingRef.current) {
      return false
    }

    return draftSyncSchedulerRef.current?.flush() ?? false
  }
  const discardPendingDraftSync = () => {
    draftSyncSchedulerRef.current?.cancel()
  }
  const scheduleComposerResize = useCallback(() => {
    if (typeof window === 'undefined') {
      syncComposerTextareaHeight(textareaRef.current)
      return
    }

    if (composerResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(composerResizeFrameRef.current)
    }

    composerResizeFrameRef.current = window.requestAnimationFrame(() => {
      composerResizeFrameRef.current = null
      syncComposerTextareaHeight(textareaRef.current)
    })
  }, [])
  const syncDraftDerivedState = useCallback((nextValue: string) => {
    const hasText = nextValue.trim().length > 0
    if (draftHasTextRef.current !== hasText) {
      draftHasTextRef.current = hasText
      setDraftHasText(hasText)
    }

    const nextSlashDraft = nextValue.trimStart().startsWith('/') ? nextValue : ''
    if (slashDraftRef.current !== nextSlashDraft) {
      slashDraftRef.current = nextSlashDraft
      setSlashDraft(nextSlashDraft)
    }
  }, [])
  const syncLocalDraft = (nextValue: string, persist = true) => {
    draftValueRef.current = nextValue
    syncDraftDerivedState(nextValue)
    if (persist) {
      scheduleDraftSync(nextValue)
    } else {
      holdDraftSync(nextValue)
    }
    setSelectedSlashIndex(0)
    scheduleComposerResize()
  }
  useEffect(() => {
    const flushOnBackground = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingDraftSync()
      }
    }

    const flushOnPageHide = () => {
      flushPendingDraftSync()
    }

    document.addEventListener('visibilitychange', flushOnBackground)
    window.addEventListener('pagehide', flushOnPageHide)

    return () => {
      document.removeEventListener('visibilitychange', flushOnBackground)
      window.removeEventListener('pagehide', flushOnPageHide)
      flushPendingDraftSync()
      discardPendingDraftSync()
      if (compositionEndUnlockHandleRef.current !== null) {
        window.clearTimeout(compositionEndUnlockHandleRef.current)
        compositionEndUnlockHandleRef.current = null
      }
    }
  }, [])

  const syncDraftFromCard = useCallback(
    (nextDraft: string) => {
      if (composingRef.current) return
      if (draftValueRef.current === nextDraft) {
        return
      }

      draftValueRef.current = nextDraft
      if (textareaRef.current && textareaRef.current.value !== nextDraft) {
        textareaRef.current.value = nextDraft
      }
      syncDraftDerivedState(nextDraft)
      scheduleComposerResize()
    },
    [scheduleComposerResize, syncDraftDerivedState],
  )
  const onPatchCardRef = useRef(onPatchCard)
  const onSendRef = useRef(onSend)
  useEffect(() => {
    onPatchCardRef.current = onPatchCard
    onSendRef.current = onSend
  }, [onPatchCard, onSend])
  const patchCard = useCallback(
    (
      patch: Partial<
        Pick<
          ChatCardModel,
          'status' | 'sessionId' | 'brainstorm' | 'autoUrgeActive' | 'autoUrgeProfileId'
        >
      >,
    ) => {
      onPatchCardRef.current(patch)
    },
    [],
  )
  const sendAutoUrge = useCallback((message: string) => {
    void onSendRef.current(message, [])
  }, [])
  const runAutoUrge = useCallback(
    (
      trigger:
        | {
            type: 'stream-finished'
            previousStatus: ChatCardModel['status']
            status: ChatCardModel['status']
          }
        | {
            type: 'manual-activation'
            status: ChatCardModel['status']
          },
    ) => {
      const result = evaluateAutoUrge(trigger, autoUrgeStateRef.current)

      if (result.kind === 'disable') {
        setAutoUrgeActive(false)
        patchCard({ autoUrgeActive: false })
        return
      }

      if (result.kind === 'send') {
        sendAutoUrge(result.message)
      }
    },
    [patchCard, sendAutoUrge],
  )

  useEffect(() => {
    // The local draft stays responsive while persisted state can still restore or clear it.
    syncDraftFromCard(card.draft ?? '')
  }, [card.draft, card.id, syncDraftFromCard])

  const hydratedAttachmentsCardIdRef = useRef(card.id)
  useEffect(() => {
    if (hydratedAttachmentsCardIdRef.current === card.id) return
    // Card switched (e.g. fork created a new tab) 鈥?pull the persisted draft attachments in.
    for (const existing of pendingAttachmentsRef.current) {
      if (existing.kind === 'local') {
        URL.revokeObjectURL(existing.previewUrl)
      }
    }
    setPendingAttachments(hydrateDraftAttachments(card.draftAttachments ?? []))
    hydratedAttachmentsCardIdRef.current = card.id
  }, [card.id, card.draftAttachments])

  useEffect(() => {
    scheduleComposerResize()

    return () => {
      if (composerResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(composerResizeFrameRef.current)
        composerResizeFrameRef.current = null
      }
    }
  }, [card.id, scheduleComposerResize])

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments
  }, [pendingAttachments])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) {
        setAutoUrgeActive(card.autoUrgeActive === true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [card.autoUrgeActive, card.id])

  useEffect(() => {
    pendingImmediateAutoUrgeRef.current = false
  }, [card.id])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) {
        setSelectedAutoUrgeProfileId(card.autoUrgeProfileId)
      }
    })
    return () => {
      cancelled = true
    }
  }, [card.autoUrgeProfileId, card.id])

  useEffect(() => {
    if (!autoUrgeEnabled || !activeAutoUrgeProfile) {
      return
    }

    if (selectedAutoUrgeProfileId === activeAutoUrgeProfile.id) {
      return
    }

    queueMicrotask(() => {
      setSelectedAutoUrgeProfileId(activeAutoUrgeProfile.id)
    })
    patchCard({ autoUrgeProfileId: activeAutoUrgeProfile.id })
  }, [activeAutoUrgeProfile, autoUrgeEnabled, patchCard, selectedAutoUrgeProfileId])

  useEffect(() => {
    autoUrgeStateRef.current = {
      messages: card.messages,
      active: autoUrgeActive,
      enabled: autoUrgeEnabled,
      message: effectiveAutoUrgeMessage,
      successKeyword: effectiveAutoUrgeSuccessKeyword,
    }
  }, [
    card.messages,
    autoUrgeActive,
    autoUrgeEnabled,
    effectiveAutoUrgeMessage,
    effectiveAutoUrgeSuccessKeyword,
  ])

  useEffect(() => {
    if (!usesPaneChrome || isToolCard || composerFocusRequest === 0) {
      return
    }

    lastFocusedCardId = card.id

    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [card.id, composerFocusRequest, isToolCard, usesPaneChrome])

  useEffect(
    () => () => {
      for (const attachment of pendingAttachmentsRef.current) {
        if (attachment.kind === 'local') {
          URL.revokeObjectURL(attachment.previewUrl)
        }
      }
    },
    [],
  )

  useEffect(() => {
    if (!modelMenuOpen) return
    const handleClickOutside = (event: Event) => {
      const target = event.target as Node
      if (modelMenuRef.current?.contains(target) || modelDropdownRef.current?.contains(target)) return
      setModelMenuStyle(null)
      setModelMenuOpen(false)
    }
    const handleEscape = (event: Event) => {
      if ((event as globalThis.KeyboardEvent).key === 'Escape') {
        setModelMenuStyle(null)
        setModelMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [modelMenuOpen])

  const updateModelMenuPosition = useCallback(() => {
    const anchor = modelMenuRef.current
    const dropdown = modelDropdownRef.current

    if (!anchor || !dropdown) {
      return
    }

    const anchorRect = anchor.getBoundingClientRect()
    const dropdownRect = dropdown.getBoundingClientRect()
    const containerRect =
      anchor.closest('.pane-content')?.getBoundingClientRect() ??
      anchor.closest('.card-shell')?.getBoundingClientRect()
    const edgeInset = 8
    const gap = anchor.classList.contains('is-composer-anchor') ? 6 : 4
    const preferAbove = anchor.classList.contains('is-composer-anchor')
    const minLeft = Math.max(edgeInset, containerRect?.left ?? edgeInset)
    const maxRight = Math.min(
      window.innerWidth - edgeInset,
      containerRect?.right ?? window.innerWidth - edgeInset,
    )
    const maxWidth = Math.max(anchorRect.width, maxRight - minLeft)
    const nextWidth = Math.min(dropdownRect.width, maxWidth)
    const nextLeft = Math.min(
      Math.max(anchorRect.left, minLeft),
      Math.max(minLeft, maxRight - nextWidth),
    )
    const minTop = Math.max(edgeInset, containerRect?.top ?? edgeInset)
    const maxBottom = Math.min(
      window.innerHeight - edgeInset,
      containerRect?.bottom ?? window.innerHeight - edgeInset,
    )
    const availableAbove = Math.max(0, anchorRect.top - gap - minTop)
    const availableBelow = Math.max(0, maxBottom - (anchorRect.bottom + gap))
    const fitsAbove = dropdownRect.height <= availableAbove
    const fitsBelow = dropdownRect.height <= availableBelow
    const placeAbove =
      preferAbove
        ? fitsAbove || (!fitsBelow && availableAbove >= availableBelow)
        : fitsBelow ? false : fitsAbove ? true : availableAbove > availableBelow
    const maxHeight = Math.max(0, placeAbove ? availableAbove : availableBelow)
    const nextHeight = Math.min(dropdownRect.height, maxHeight)
    const rawTop = placeAbove
      ? anchorRect.top - gap - nextHeight
      : anchorRect.bottom + gap
    const nextTop = Math.min(
      Math.max(rawTop, minTop),
      Math.max(minTop, maxBottom - nextHeight),
    )
    const nextStyle = {
      top: nextTop,
      left: nextLeft,
      minWidth: anchorRect.width,
      maxWidth,
      maxHeight,
    }

    setModelMenuStyle((current) =>
      current &&
      Math.abs(current.top - nextStyle.top) < 0.5 &&
      Math.abs(current.left - nextStyle.left) < 0.5 &&
      Math.abs(current.minWidth - nextStyle.minWidth) < 0.5 &&
      Math.abs(current.maxWidth - nextStyle.maxWidth) < 0.5 &&
      Math.abs(current.maxHeight - nextStyle.maxHeight) < 0.5
        ? current
        : nextStyle,
    )
  }, [])

  useLayoutEffect(() => {
    if (!modelMenuOpen) return

    updateModelMenuPosition()
    const frame = window.requestAnimationFrame(() => updateModelMenuPosition())
    const handleLayout = () => updateModelMenuPosition()

    window.addEventListener('resize', handleLayout)
    window.addEventListener('scroll', handleLayout, true)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', handleLayout)
      window.removeEventListener('scroll', handleLayout, true)
    }
  }, [modelMenuOpen, updateModelMenuPosition])

  useEffect(() => {
    if (!settingsMenuOpen) return
    const handleClickOutside = (event: Event) => {
      const target = event.target as Node
      if (settingsMenuRef.current?.contains(target) || settingsDropdownRef.current?.contains(target)) return
      setSettingsMenuStyle(null)
      setSettingsMenuOpen(false)
    }
    const handleEscape = (event: Event) => {
      if ((event as globalThis.KeyboardEvent).key === 'Escape') {
        setSettingsMenuStyle(null)
        setSettingsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [settingsMenuOpen])

  const updateSettingsMenuPosition = useCallback(() => {
    const anchor = settingsMenuRef.current
    const dropdown = settingsDropdownRef.current

    if (!anchor || !dropdown) {
      return
    }

    const anchorRect = anchor.getBoundingClientRect()
    const dropdownRect = dropdown.getBoundingClientRect()
    const cardRect = anchor.closest('.card-shell')?.getBoundingClientRect()
    const edgeInset = 8
    const gap = 6
    const minLeft = Math.max(edgeInset, cardRect?.left ?? edgeInset)
    const maxRight = Math.min(window.innerWidth - edgeInset, cardRect?.right ?? window.innerWidth - edgeInset)
    const maxWidth = Math.max(0, maxRight - minLeft)
    const nextWidth = Math.min(dropdownRect.width, maxWidth)
    const rawLeft = anchorRect.right - nextWidth
    const nextLeft = Math.min(Math.max(rawLeft, minLeft), Math.max(minLeft, maxRight - nextWidth))
    const minTop = Math.max(edgeInset, cardRect?.top ?? edgeInset)
    const maxBottom = Math.min(window.innerHeight - edgeInset, cardRect?.bottom ?? window.innerHeight - edgeInset)
    const rawTop = anchorRect.top - gap - dropdownRect.height
    const nextTop = Math.min(Math.max(rawTop, minTop), Math.max(minTop, maxBottom - dropdownRect.height))
    const nextStyle = {
      top: nextTop,
      left: nextLeft,
      maxWidth,
    }

    setSettingsMenuStyle((current) =>
      current &&
      Math.abs(current.top - nextStyle.top) < 0.5 &&
      Math.abs(current.left - nextStyle.left) < 0.5 &&
      Math.abs(current.maxWidth - nextStyle.maxWidth) < 0.5
        ? current
        : nextStyle,
    )
  }, [])

  useLayoutEffect(() => {
    if (!settingsMenuOpen) return

    updateSettingsMenuPosition()
    const frame = window.requestAnimationFrame(() => updateSettingsMenuPosition())
    const handleLayout = () => updateSettingsMenuPosition()

    window.addEventListener('resize', handleLayout)
    window.addEventListener('scroll', handleLayout, true)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', handleLayout)
      window.removeEventListener('scroll', handleLayout, true)
    }
  }, [autoUrgeEnabled, card.provider, language, settingsMenuOpen, updateSettingsMenuPosition])

  const syncAutoScrollPreference = useCallback(() => {
    if (suspendPaneRuntimeEffects) {
      return
    }

    const node = messageListRef.current
    if (!node) {
      return
    }

    if (programmaticScrollGuardRef.current) {
      const next = getAutoScrollStateDuringProgrammaticScroll(
        programmaticScrollIntentRef.current,
        node.scrollTop,
        shouldAutoScrollRef.current,
      )

      shouldAutoScrollRef.current = next.shouldAutoScroll
      lastScrollTopRef.current = next.lastScrollTop
      lastMessageListMetricsRef.current = {
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      }

      if (next.interrupted) {
        programmaticScrollGuardRef.current = false
        programmaticScrollIntentRef.current = null
        if (programmaticScrollGuardFrameRef.current !== null) {
          window.cancelAnimationFrame(programmaticScrollGuardFrameRef.current)
          programmaticScrollGuardFrameRef.current = null
        }
      }

      return
    }

    const currentMetrics = {
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }
    const next = getAutoScrollStateAfterObservedScroll({
      previousScrollTop: lastScrollTopRef.current,
      currentMetrics,
      previousMetrics: lastMessageListMetricsRef.current,
      previousShouldAutoScroll: shouldAutoScrollRef.current,
      isVisible:
        (typeof document === 'undefined' || document.visibilityState === 'visible') &&
        node.isConnected &&
        node.getClientRects().length > 0 &&
        node.clientHeight > programmaticScrollInterruptTolerancePx,
    })
    if (next.ignored) {
      return
    }
    restoredAnchorLockedCardIdRef.current = null
    pendingRestoredAnchorScrollTopRef.current = null
    if (restoredScrollSpacerPx > 0) {
      setRestoredScrollSpacerPx(0)
    }
    lastScrollTopRef.current = next.lastScrollTop
    shouldAutoScrollRef.current = next.shouldAutoScroll
    lastMessageListMetricsRef.current = {
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }
  }, [restoredScrollSpacerPx, suspendPaneRuntimeEffects])

  const scrollMessageListTo = useCallback((targetScrollTop: number, behavior: ScrollBehavior = 'instant') => {
    const el = messageListRef.current
    if (!el) {
      return
    }

    const maxScrollTop = getProgrammaticBottomScrollTarget({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    })
    const nextScrollTop = Math.min(Math.max(targetScrollTop, 0), maxScrollTop)

    programmaticScrollGuardRef.current = true
    programmaticScrollIntentRef.current = {
      startScrollTop: el.scrollTop,
      targetScrollTop: nextScrollTop,
    }
    if (programmaticScrollGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollGuardFrameRef.current)
    }
    programmaticScrollGuardFrameRef.current = window.requestAnimationFrame(() => {
      programmaticScrollGuardFrameRef.current = null
      programmaticScrollGuardRef.current = false
      programmaticScrollIntentRef.current = null
    })

    lastScrollTopRef.current = nextScrollTop
    lastMessageListMetricsRef.current = {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }
    el.scrollTo({
      top: nextScrollTop,
      behavior,
    })
  }, [])

  const scrollMessageListToBottom = useCallback((behavior: ScrollBehavior = 'instant') => {
    restoredAnchorLockedCardIdRef.current = null
    pendingRestoredAnchorScrollTopRef.current = null
    if (restoredScrollSpacerPx > 0) {
      setRestoredScrollSpacerPx(0)
    }
    shouldAutoScrollRef.current = true

    const el = messageListRef.current
    if (!el) {
      return
    }

    scrollMessageListTo(
      getProgrammaticBottomScrollTarget({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }),
      behavior,
    )
  }, [restoredScrollSpacerPx, scrollMessageListTo])

  const keepMessageListPinnedToBottom = useCallback(function keepPinnedToBottom(
    behavior: ScrollBehavior,
    remainingFrames = 6,
  ) {
    scrollMessageListToBottom(behavior)

    if (remainingFrames <= 0) {
      return
    }

    autoScrollFrameRef.current = window.requestAnimationFrame(() => {
      autoScrollFrameRef.current = null

      const el = messageListRef.current
      if (!el || !shouldAutoScrollRef.current) {
        return
      }

      if (Math.abs(el.scrollTop - lastScrollTopRef.current) > programmaticScrollInterruptTolerancePx) {
        shouldAutoScrollRef.current = false
        lastScrollTopRef.current = el.scrollTop
        return
      }

      if (
        getDistanceToBottom({
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        }) <= 1
      ) {
        return
      }

      keepPinnedToBottom('instant', remainingFrames - 1)
    })
  }, [scrollMessageListToBottom])

  const jumpToStickyMessageSource = useCallback((targetScrollTop: number) => {
    restoredAnchorLockedCardIdRef.current = null
    pendingRestoredAnchorScrollTopRef.current = null
    if (restoredScrollSpacerPx > 0) {
      setRestoredScrollSpacerPx(0)
    }
    shouldAutoScrollRef.current = false
    scrollMessageListTo(targetScrollTop, 'smooth')
  }, [restoredScrollSpacerPx, scrollMessageListTo])

  const renderableMessagesRef = useRef<RenderableMessage[]>([])
  const bootstrapRestoredMessageListScroll = useCallback(() => {
    const messageList = messageListRef.current
    const restoredAnchor = getRestoredStickyUserAnchor(renderableMessagesRef.current)

    if (
      card.status !== 'streaming' &&
      messageList &&
      restoredAnchor
    ) {
      const renderableEntries = Array.from(
        messageList.querySelectorAll<HTMLElement>('[data-renderable-id]'),
      )
      const stickyEntry = renderableEntries.find(
        (entry) => entry.dataset.renderableId === restoredAnchor.stickyMessageId,
      )
      const anchorEntry = renderableEntries.find(
        (entry) => entry.dataset.renderableId === restoredAnchor.anchorEntryId,
      )

      if (stickyEntry && anchorEntry) {
        const messageListRect = messageList.getBoundingClientRect()
        const currentScrollTop = messageList.scrollTop
        const anchorScrollTop =
          anchorEntry.getBoundingClientRect().top - messageListRect.top + currentScrollTop
        const scrollPlan = getRestoredMessageListScrollPlan({
          scrollHeight: messageList.scrollHeight,
          clientHeight: messageList.clientHeight,
          anchorScrollTop,
        })

        if (scrollPlan.mode === 'anchor') {
          restoredAnchorLockedCardIdRef.current = card.id
          shouldAutoScrollRef.current = false
          pendingRestoredAnchorScrollTopRef.current = scrollPlan.scrollTop
          if (scrollPlan.bottomSpacerPx !== restoredScrollSpacerPx) {
            setRestoredScrollSpacerPx(scrollPlan.bottomSpacerPx)
          } else {
            pendingRestoredAnchorScrollTopRef.current = null
            scrollMessageListTo(scrollPlan.scrollTop, 'instant')
          }
          return
        }
      }
    }

    restoredAnchorLockedCardIdRef.current = null
    pendingRestoredAnchorScrollTopRef.current = null
    if (restoredScrollSpacerPx > 0) {
      setRestoredScrollSpacerPx(0)
    }
    shouldAutoScrollRef.current = true
    keepMessageListPinnedToBottom('instant', 0)
  }, [
    card.id,
    card.status,
    keepMessageListPinnedToBottom,
    restoredScrollSpacerPx,
    scrollMessageListTo,
  ])

  useLayoutEffect(() => {
    if (suspendPaneRuntimeEffects) {
      return
    }

    if (!isRestored || restoredScrollBootstrapCardIdRef.current === card.id) {
      return
    }

    restoredScrollBootstrapCardIdRef.current = card.id
    bootstrapRestoredMessageListScroll()
  }, [bootstrapRestoredMessageListScroll, card.id, isRestored, suspendPaneRuntimeEffects])

  useLayoutEffect(() => {
    if (suspendPaneRuntimeEffects) {
      return
    }

    const pendingRestoredAnchorScrollTop = pendingRestoredAnchorScrollTopRef.current
    if (pendingRestoredAnchorScrollTop === null) {
      return
    }

    const messageList = messageListRef.current
    if (!messageList) {
      return
    }

    const maxScrollTop = getProgrammaticBottomScrollTarget({
      scrollHeight: messageList.scrollHeight,
      clientHeight: messageList.clientHeight,
    })

    if (maxScrollTop + programmaticScrollInterruptTolerancePx < pendingRestoredAnchorScrollTop) {
      return
    }

    pendingRestoredAnchorScrollTopRef.current = null
    scrollMessageListTo(pendingRestoredAnchorScrollTop, 'instant')
  }, [card.id, restoredScrollSpacerPx, scrollMessageListTo, suspendPaneRuntimeEffects])

  useLayoutEffect(() => {
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current)
      autoScrollFrameRef.current = null
    }

    if (suspendPaneRuntimeEffects) {
      return
    }

    if (!isRestored && card.status !== 'streaming' && card.messages.length > 0 && lastScrollTopRef.current <= 1) {
      return
    }

    const el = messageListRef.current
    const currentMetrics = el
      ? {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        }
      : null
    const ignoredHiddenScrollReset =
      el &&
      currentMetrics &&
      getAutoScrollStateAfterObservedScroll({
        previousScrollTop: lastScrollTopRef.current,
        currentMetrics,
        previousMetrics: lastMessageListMetricsRef.current,
        previousShouldAutoScroll: shouldAutoScrollRef.current,
        isVisible:
          (typeof document === 'undefined' || document.visibilityState === 'visible') &&
          el.isConnected &&
          el.getClientRects().length > 0 &&
          el.clientHeight > programmaticScrollInterruptTolerancePx,
      }).ignored

    if (ignoredHiddenScrollReset) {
      return
    }

    const isCurrentlyPinnedToBottom =
      el &&
      getDistanceToBottom({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }) <= 1
    const externalScrollOverride =
      el && Math.abs(el.scrollTop - lastScrollTopRef.current) > programmaticScrollInterruptTolerancePx

    if (externalScrollOverride) {
      shouldAutoScrollRef.current = false
      lastScrollTopRef.current = el.scrollTop
      lastMessageListMetricsRef.current = {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }
      return
    }

    if (!shouldAutoScrollRef.current && lastScrollTopRef.current <= 1) {
      return
    }

    if (shouldAutoScrollRef.current || isCurrentlyPinnedToBottom) {
      // Instant scroll avoids smooth-scroll intermediate positions from being
      // misread as a user escape during streaming completion and tool-group
      // collapse reflows.
      keepMessageListPinnedToBottom('instant', card.status === 'streaming' ? 6 : 0)
    }
  }, [card.id, card.messages, card.status, collapsedGroups, keepMessageListPinnedToBottom, isRestored, suspendPaneRuntimeEffects])

  useEffect(() => () => {
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current)
      autoScrollFrameRef.current = null
    }
    if (programmaticScrollGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollGuardFrameRef.current)
      programmaticScrollGuardFrameRef.current = null
    }
    programmaticScrollGuardRef.current = false
    programmaticScrollIntentRef.current = null
  }, [])

  // Re-pin to the bottom when async content growth (late image/code-highlight/
  // mermaid layout, visibility-change flushes) expands the list after the
  // React-driven auto-scroll loop has already exited. Without this observer
  // the user returns to a tab that is "almost but not quite" at the bottom
  // and has to nudge it by hand.
  const scrollMessageListToBottomRef = useRef(scrollMessageListToBottom)
  useEffect(() => {
    scrollMessageListToBottomRef.current = scrollMessageListToBottom
  }, [scrollMessageListToBottom])

  useEffect(() => {
    if (suspendPaneRuntimeEffects) {
      return
    }

    const node = messageListRef.current
    if (!node || typeof ResizeObserver === 'undefined') {
      return
    }

    lastMessageListMetricsRef.current = {
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }

    let previousScrollHeight = node.scrollHeight
    let previousBottomScrollTop = getProgrammaticBottomScrollTarget({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    })

    const observer = new ResizeObserver(() => {
      const el = messageListRef.current
      if (!el) {
        return
      }

      if (el.scrollHeight === previousScrollHeight) {
        return
      }
      lastMessageListMetricsRef.current = {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }

      const metrics = {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }

      if (
        shouldPinToBottomAfterContentGrowth({
          previousBottomScrollTop,
          currentMetrics: metrics,
          wasPinned: shouldAutoScrollRef.current,
        })
      ) {
        scrollMessageListToBottomRef.current('instant')
      }

      previousScrollHeight = el.scrollHeight
      previousBottomScrollTop = getProgrammaticBottomScrollTarget(metrics)
    })

    observer.observe(node)

    return () => {
      observer.disconnect()
    }
  }, [card.id, suspendPaneRuntimeEffects])

  useEffect(() => {
    if (isToolCard || !hasWorkspacePath || !slashCommandsEnabled) {
      slashCommandsLoadKeyRef.current = null
      return
    }

    const request = {
      provider: card.provider,
      workspacePath: workspacePath.trim(),
      language,
      crossProviderSkillReuseEnabled,
    }
    const loadKey = getSlashCommandsLoadKey(request)
    if (!shouldStartSlashCommandsLoad(slashCommandsLoadKeyRef.current, loadKey)) {
      return
    }

    slashCommandsLoadKeyRef.current = loadKey
    let cancelled = false
    // This flag mirrors the async fetch lifecycle for slash command discovery.
    queueMicrotask(() => {
      if (!cancelled && slashCommandsStatusRef.current !== 'loading') {
        startTransition(() => {
          setSlashCommandsStatus('loading')
        })
      }
    })

    void fetchSlashCommands(request)
      .then((commands) => {
        if (cancelled || slashCommandsLoadKeyRef.current !== loadKey) {
          return
        }

        setRemoteSlashCommands((current) => {
          const nextCommands = resolveRemoteSlashCommands(commands, localSlashCommandsRef.current)
          return areSlashCommandListsEqual(current, nextCommands) ? current : nextCommands
        })
        setSlashCommandsStatus((current) => current === 'ready' ? current : 'ready')
      })
      .catch(() => {
        if (cancelled || slashCommandsLoadKeyRef.current !== loadKey) {
          return
        }

        setRemoteSlashCommands((current) =>
          areSlashCommandListsEqual(current, localSlashCommandsRef.current)
            ? current
            : localSlashCommandsRef.current,
        )
        setSlashCommandsStatus((current) => current === 'error' ? current : 'error')
      })

    return () => {
      cancelled = true
      slashCommandsLoadKeyRef.current = resolveSlashCommandsLoadKeyAfterCancel(
        slashCommandsLoadKeyRef.current,
        loadKey,
      )
    }
  }, [
    card.provider,
    crossProviderSkillReuseEnabled,
    hasWorkspacePath,
    isToolCard,
    language,
    slashCommandsEnabled,
    workspacePath,
  ])

  const slashCommands = hasWorkspacePath && slashCommandsEnabled ? remoteSlashCommands : localSlashCommands
  const effectiveSlashCommandsStatus =
    hasWorkspacePath && slashCommandsEnabled ? slashCommandsStatus : 'ready'

  const deferredSlashDraft = useDeferredValue(slashDraft)
  const slashQuery = useMemo(() => getSlashCompletionQuery(deferredSlashDraft), [deferredSlashDraft])
  useEffect(() => {
    setSlashMenuDismissed(resolveSlashMenuDismissedAfterQueryChange)
  }, [slashQuery])

  useEffect(() => {
    if (isToolCard || !hasWorkspacePath || !slashCommandsEnabled || slashQuery === null) {
      return
    }

    return undefined
  }, [
    card.provider,
    crossProviderSkillReuseEnabled,
    hasWorkspacePath,
    isToolCard,
    language,
    slashCommandsEnabled,
    slashQuery,
    workspacePath,
  ])

  const filteredSlashCommands = useMemo(() => {
    if (slashQuery === null) {
      return []
    }

    if (!slashQuery) {
      return slashCommands
    }

    return slashCommands.filter((command) => command.name.startsWith(slashQuery))
  }, [slashCommands, slashQuery])
  const activeSlashIndex =
    filteredSlashCommands.length === 0
      ? 0
      : Math.min(selectedSlashIndex, filteredSlashCommands.length - 1)

  const hasPendingAttachments = pendingAttachments.length > 0
  const composerNotice = useMemo(() => {
    if (composerError) {
      return {
        tone: 'error' as const,
        message: composerError,
      }
    }

    if (hasPendingAttachments && !providerCanSendImages) {
      return {
        tone: 'info' as const,
        message: text.imageAttachmentsRequireCodex,
      }
    }

    return null
  }, [composerError, hasPendingAttachments, providerCanSendImages, text])
  const localSlashDraft = !hasPendingAttachments && isLocalSlashCommandInput(slashDraft)
  const sendDisabled =
    (!draftHasText && !hasPendingAttachments) ||
    (hasPendingAttachments && !providerCanSendImages) ||
    (!localSlashDraft && !workspacePath.trim())

  const removePendingAttachment = (attachmentId: string) => {
    setPendingAttachments((current) => {
      const match = current.find((attachment) => attachment.id === attachmentId)

      if (match) {
        URL.revokeObjectURL(match.previewUrl)
      }

      return current.filter((attachment) => attachment.id !== attachmentId)
    })
  }

  const handleMessageListCopy = useCallback(async (event: globalThis.ClipboardEvent) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    const range = selection.getRangeAt(0)
    const fragment = range.cloneContents()
    const images = fragment.querySelectorAll('img')
    if (images.length === 0) return

    event.preventDefault()

    const plainText = selection.toString()

    await Promise.all(
      Array.from(images).map(async (img) => {
        try {
          const response = await fetch(img.src)
          const blob = await response.blob()
          const reader = new FileReader()
          const dataUrl = await new Promise<string>((resolve) => {
            reader.onloadend = () => resolve(reader.result as string)
            reader.readAsDataURL(blob)
          })
          img.src = dataUrl
        } catch {
          // keep original src if fetch fails
        }
      }),
    )

    const wrapper = document.createElement('div')
    wrapper.appendChild(fragment)
    const htmlContent = wrapper.innerHTML

    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([htmlContent], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        }),
      ])
    } catch {
      await navigator.clipboard.writeText(plainText)
    }
  }, [])

  useEffect(() => {
    const el = messageListRef.current
    if (!el) return

    const listener = (event: globalThis.ClipboardEvent) => {
      void handleMessageListCopy(event)
    }

    el.addEventListener('copy', listener)
    return () => el.removeEventListener('copy', listener)
  }, [handleMessageListCopy])

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && supportedImageMimeTypes.has(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)

    if (imageFiles.length === 0) {
      return
    }

    event.preventDefault()
    setComposerError(null)
    setPendingAttachments((current) => [
      ...current,
      ...imageFiles.map<PendingAttachment>((file) => ({
        kind: 'local',
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ])
  }

  const handleSubmit = async (options?: SendMessageOptions) => {
    if (sendDisabled) return
    const prompt = draftValueRef.current.trim()
    let attachments: ImageAttachment[] = []

    try {
      attachments = await Promise.all(pendingAttachments.map((attachment) => uploadPendingImage(attachment)))
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : text.unexpectedError)
      return
    }

    scrollMessageListToBottom('instant')
    await onSend(prompt, attachments, options)

    for (const attachment of pendingAttachments) {
      if (attachment.kind === 'local') {
        URL.revokeObjectURL(attachment.previewUrl)
      }
    }

    draftValueRef.current = ''
    if (textareaRef.current) {
      textareaRef.current.value = ''
    }
    syncDraftDerivedState('')
    scheduleComposerResize()
    setPendingAttachments([])
    setComposerError(null)
    discardPendingDraftSync()
    onDraftChange('')
    if ((card.draftAttachments ?? []).length > 0) {
      onPatchCard({ draftAttachments: [] })
    }
  }

  const handleSendButtonContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (sendDisabled) return
    void handleSubmit({ mode: 'defer' })
  }

  const applySlashCommand = (command: SlashCommand) => {
    const nextDraft = `/${command.name} `
    draftValueRef.current = nextDraft
    if (textareaRef.current) {
      textareaRef.current.value = nextDraft
    }
    syncDraftDerivedState(nextDraft)
    scheduleComposerResize()
    discardPendingDraftSync()
    onDraftChange(nextDraft)
    setSelectedSlashIndex(0)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const handleCompositionStart = () => {
    holdDraftSync(draftValueRef.current)
    if (compositionEndUnlockHandleRef.current !== null) {
      window.clearTimeout(compositionEndUnlockHandleRef.current)
      compositionEndUnlockHandleRef.current = null
    }
    composingRef.current = true
  }

  const handleCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    const committedValue = event.currentTarget.value
    if (compositionEndUnlockHandleRef.current !== null) {
      window.clearTimeout(compositionEndUnlockHandleRef.current)
    }
    compositionEndUnlockHandleRef.current = window.setTimeout(() => {
      compositionEndUnlockHandleRef.current = null
      const nextValue = textareaRef.current?.value ?? committedValue
      composingRef.current = false
      if (draftValueRef.current !== nextValue) {
        syncLocalDraft(nextValue)
        return
      }
      scheduleDraftSync(nextValue)
    }, 0)
  }

  const brainstormRequestTarget = resolveBrainstormRequestTarget(card.brainstorm, brainstormRequestModel)
  const effectiveProvider = isToolCard ? 'codex' : (card.provider ?? 'codex')
  const selectValue = isBrainstormCard
    ? getSelectValue(brainstormRequestTarget.provider, brainstormRequestTarget.model)
    : getSelectValue(effectiveProvider, card.model ?? '')
  const selectOptions = useMemo(() => {
    if (isBrainstormCard) {
      const custom = getCustomModelOption(
        brainstormRequestTarget.provider,
        brainstormRequestTarget.model,
      )
      const base = custom ? [custom, ...MODEL_OPTIONS] : MODEL_OPTIONS
      return base.filter(
        (option) =>
          !option.usesConfiguredDefault && !hiddenBrainstormRequestModels.has(option.model),
      )
    }

    const custom = getCustomModelOption(effectiveProvider, card.model ?? '')
    const base = custom ? [custom, ...MODEL_OPTIONS] : MODEL_OPTIONS
    return base.filter((option) => !hiddenModelPickerToolModels.has(option.model))
  }, [
    brainstormRequestTarget.model,
    brainstormRequestTarget.provider,
    card.model,
    effectiveProvider,
    isBrainstormCard,
  ])
  const currentModelOption =
    selectOptions.find((option) => `${option.provider}:${option.model}` === selectValue) ?? selectOptions[0]
  const reasoningValue = normalizeReasoningEffort(effectiveProvider, card.reasoningEffort)
  const menuMinWidth = modelMenuStyle?.minWidth ?? 0
  const menuMaxWidth = modelMenuStyle?.maxWidth ?? 0
  const menuMaxHeight = modelMenuStyle?.maxHeight ?? 0
  const reasoningOptions = useMemo(
    () => getReasoningOptions(effectiveProvider, language),
    [effectiveProvider, language],
  )
  const compactMessageWindow = useMemo(
    () =>
      deferInactivePaneChatBody
        ? emptyCompactMessageWindow
        : getCompactMessageWindow(card.messages, card.provider, card.status, {
            revealedHiddenMessageCount: revealedCompactedHistoryCount,
          }),
    [card.messages, card.provider, card.status, deferInactivePaneChatBody, revealedCompactedHistoryCount],
  )
  const renderableMessages = useMemo(
    () => (deferInactivePaneChatBody ? [] : buildRenderableMessages(compactMessageWindow.visibleMessages)),
    [compactMessageWindow.visibleMessages, deferInactivePaneChatBody],
  )
  useEffect(() => {
    renderableMessagesRef.current = renderableMessages
  }, [renderableMessages])
  const latestAssistantContent = useMemo(
    () => [...card.messages].reverse().find((message) => message.role === 'assistant')?.content ?? '',
    [card.messages],
  )
  const showManualStreamRecovery =
    typeof onManualRecoverStream === 'function' &&
    shouldShowManualStreamRecoveryControl({
      cardStatus: card.status,
      recoveryStatus,
      latestAssistantContent,
    })
  const compactBoundaryRef = useRef<string | null>(compactMessageWindow.compactMessageId)
  useEffect(() => {
    if (deferInactivePaneChatBody) {
      return
    }

    if (compactMessageWindow.compactMessageId !== compactBoundaryRef.current) {
      compactBoundaryRef.current = compactMessageWindow.compactMessageId
      pendingCompactedHistoryRevealRef.current = null
      setRevealedCompactedHistoryCount(0)
    }
  }, [compactMessageWindow.compactMessageId, deferInactivePaneChatBody])

  useLayoutEffect(() => {
    const pendingReveal = pendingCompactedHistoryRevealRef.current
    const node = messageListRef.current
    if (!pendingReveal || !node) {
      return
    }

    pendingCompactedHistoryRevealRef.current = null
    const nextScrollTop = Math.max(
      pendingReveal.scrollTop + (node.scrollHeight - pendingReveal.scrollHeight),
      0,
    )
    shouldAutoScrollRef.current = false
    lastScrollTopRef.current = nextScrollTop
    node.scrollTop = nextScrollTop
  }, [compactMessageWindow.visibleMessages])

  const compactionBannerCopy = useMemo(
    () =>
      !deferInactivePaneChatBody && compactMessageWindow.hiddenMessageCount > 0
        ? getCompactionBannerCopy(
            language,
            compactMessageWindow.hiddenMessageCount,
            compactMessageWindow.hiddenReason,
            compactMessageWindow.compactTrigger,
          )
        : null,
    [
      compactMessageWindow.hiddenMessageCount,
      compactMessageWindow.hiddenReason,
      compactMessageWindow.compactTrigger,
      deferInactivePaneChatBody,
      language,
    ],
  )
  const quickToolEntries = useMemo(
    () =>
      deferInactivePaneChatBody
        ? []
        : availableQuickToolModels
          .map((model) => getEmptyStateToolEntry(model, text))
          .filter((entry): entry is EmptyStateToolEntry => entry !== null),
    [availableQuickToolModels, deferInactivePaneChatBody, text],
  )
  const showsQuickToolGrid =
    !deferInactivePaneChatBody &&
    !isToolCard &&
    card.status !== 'streaming' &&
    renderableMessages.length === 0 &&
    !draftHasText &&
    pendingAttachments.length === 0 &&
    quickToolEntries.length > 0

  const toggleToolGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
        userExpandedRef.current.add(key)
      } else {
        next.add(key)
        userExpandedRef.current.delete(key)
      }
      return next
    })
  }, [])

  const revealCompactedHistory = useCallback(
    (requestedMessageCount: number) => {
      if (
        deferInactivePaneChatBody ||
        compactMessageWindow.hiddenMessageCount <= 0 ||
        requestedMessageCount <= 0
      ) {
        return
      }

      const node = messageListRef.current
      if (node) {
        pendingCompactedHistoryRevealRef.current = {
          scrollHeight: node.scrollHeight,
          scrollTop: node.scrollTop,
        }
      }

      shouldAutoScrollRef.current = false
      setRevealedCompactedHistoryCount((current) =>
        current + Math.min(requestedMessageCount, compactMessageWindow.hiddenMessageCount),
      )
    },
    [compactMessageWindow.hiddenMessageCount, deferInactivePaneChatBody],
  )

  const revealNextCompactedHistoryBatch = useCallback(() => {
    revealCompactedHistory(compactHistoryRevealBatchSize)
  }, [revealCompactedHistory])

  const revealAllCompactedHistory = useCallback(() => {
    revealCompactedHistory(compactMessageWindow.hiddenMessageCount)
  }, [compactMessageWindow.hiddenMessageCount, revealCompactedHistory])

  const activateQuickTool = useCallback(
    (entry: EmptyStateToolEntry) => {
      onChangeTitle(entry.title)
      onChangeModel('codex', entry.model)
    },
    [onChangeModel, onChangeTitle],
  )

  const handleSelectAskUserOption = useCallback(
    (answerKey: string, label: string) => {
      setAskUserAnswers((prev) => (prev[answerKey] === label ? prev : { ...prev, [answerKey]: label }))
      void onSend(formatAskUserFollowUpPrompt(label, language), [])
    },
    [language, onSend],
  )

  // Layer 1: auto-collapse tool-groups once the assistant has clearly moved on
  // to another renderable block, including reasoning / ask-user / plain text.
  const autoCollapsedKeys = useMemo(() => {
    if (deferInactivePaneChatBody) {
      return new Set<string>()
    }

    const keys = new Set<string>()
    for (let i = 0; i < renderableMessages.length; i++) {
      const entry = renderableMessages[i]!
      if (entry.type !== 'tool-group') continue
      const next = renderableMessages[i + 1]
      if (
        next &&
        (next.type === 'tool-group' ||
          (next.type === 'message' && next.message.role === 'assistant'))
      ) {
        keys.add(getToolGroupKey(entry.items))
      }
    }
    return keys
  }, [deferInactivePaneChatBody, renderableMessages])

  useEffect(() => {
    if (deferInactivePaneChatBody) {
      return
    }

    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const key of autoCollapsedKeys) {
        if (!userExpandedRef.current.has(key) && !next.has(key)) {
          next.add(key)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [autoCollapsedKeys, deferInactivePaneChatBody])

  // Layer 2: collapse all tool-groups when streaming ends
  const prevStatusRef = useRef(card.status)
  useEffect(() => {
    if (deferInactivePaneChatBody) {
      prevStatusRef.current = card.status
      return
    }

    const wasStreaming = prevStatusRef.current === 'streaming'
    prevStatusRef.current = card.status
    if (wasStreaming && card.status === 'idle') {
      setCollapsedGroups(() => {
        const allKeys = new Set<string>()
        for (const entry of renderableMessages) {
          if (entry.type === 'tool-group') {
            const key = getToolGroupKey(entry.items)
            if (!userExpandedRef.current.has(key)) {
              allKeys.add(key)
            }
          }
        }
        return allKeys
      })
    }
  }, [card.status, deferInactivePaneChatBody, renderableMessages])
  const slashMenuOpen = !hasPendingAttachments && slashQuery !== null && !slashMenuDismissed
  useLayoutEffect(() => {
    if (!slashMenuOpen) {
      activeSlashItemRef.current = null
      return
    }

    const menu = slashMenuElRef.current
    const activeItem = activeSlashItemRef.current
    if (!menu || !activeItem) {
      return
    }

    const nextScrollTop = getScrollTopToRevealChild(
      {
        scrollTop: menu.scrollTop,
        clientHeight: menu.clientHeight,
      },
      {
        offsetTop: activeItem.offsetTop,
        offsetHeight: activeItem.offsetHeight,
      },
    )

    if (Math.abs(nextScrollTop - menu.scrollTop) > 0.5) {
      menu.scrollTop = nextScrollTop
    }
  }, [activeSlashIndex, filteredSlashCommands.length, slashMenuOpen])
  useEffect(() => {
    if (!slashMenuOpen) return
    const handleClickOutside = (event: Event) => {
      if (slashMenuElRef.current && !slashMenuElRef.current.contains(event.target as Node)) {
        setSlashMenuDismissed(true)
      }
    }
    const handleEscape = (event: Event) => {
      if ((event as globalThis.KeyboardEvent).key === 'Escape') {
        setSlashMenuDismissed(true)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [slashMenuOpen])

  // Auto-Urge: when card transitions from streaming 鈫?idle, check if the last
  // assistant message contains the success keyword. If not, auto-send the urge message.
  useEffect(() => {
    const previousStatus = prevCardStatusRef.current
    prevCardStatusRef.current = card.status

    if (previousStatus !== 'streaming' || card.status !== 'idle') return

    const timer = window.setTimeout(() => {
      runAutoUrge({
        type: 'stream-finished',
        previousStatus,
        status: card.status,
      })
    }, 800)
    return () => window.clearTimeout(timer)
  }, [card.status, card.id, runAutoUrge])

  useEffect(() => {
    if (!pendingImmediateAutoUrgeRef.current || card.status !== 'idle') {
      return
    }

    pendingImmediateAutoUrgeRef.current = false
    runAutoUrge({
      type: 'manual-activation',
      status: card.status,
    })
  }, [autoUrgeActive, card.status, card.id, runAutoUrge])

  const hasFloatingUi = slashMenuOpen || gitAgentPanelOpen
  const slashMenuSideRef = useRef<'left' | 'right'>('right')
  const slashMenuRef = (el: HTMLDivElement | null) => {
    slashMenuElRef.current = el
    if (!el || !composerRef.current) return
    const rect = composerRef.current.getBoundingClientRect()
    const spaceRight = window.innerWidth - rect.right
    const side = spaceRight >= rect.left ? 'right' : 'left'
    slashMenuSideRef.current = side
    el.classList.toggle('is-side-right', side === 'right')
    el.classList.toggle('is-side-left', side === 'left')
  }
  const highlightedSlashCommand =
    filteredSlashCommands.length > 0 ? filteredSlashCommands[activeSlashIndex] : null

  const statusClass =
    card.status === 'streaming' ? ' is-streaming' : card.status === 'error' ? ' is-error' : ''
  const sendButtonLabel = card.status === 'streaming' ? text.deferSendMessage : text.sendMessage
  const sendButtonTooltip =
    card.status === 'streaming'
      ? `${text.deferSendMessage} · ${language === 'en' ? 'Click or right-click to queue this message for after the current answer.' : '点击或右键都会加入队列，等当前回答结束后自动发送。'}`
      : `${text.sendMessage} · ${language === 'en' ? 'During a running answer, click or right-click queues it for later.' : '运行中点击或右键会延后发送。'}`
  const queuedSendText = queuedSendSummary
    ? text.queuedSendSummary(
        queuedSendSummary.count,
        queuedSendSummary.nextPreview,
        queuedSendSummary.nextAttachmentCount,
      )
    : ''

  const handleRemoveClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    onRemove()
  }

  const startTitleEditing = () => {
    if (!showsCardTitle) {
      return
    }

    setEditingTitleValue(isMusicToolCard && musicTitleOverride ? musicTitleOverride : card.title)
    setEditingTitle(true)
    requestAnimationFrame(() => titleInputRef.current?.select())
  }

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenuOpen) {
      if (event.key === 'ArrowDown' && filteredSlashCommands.length > 0) {
        event.preventDefault()
        setSelectedSlashIndex((current) => (current + 1) % filteredSlashCommands.length)
        return
      }

      if (event.key === 'ArrowUp' && filteredSlashCommands.length > 0) {
        event.preventDefault()
        setSelectedSlashIndex((current) =>
          current === 0 ? filteredSlashCommands.length - 1 : current - 1,
        )
        return
      }

      if ((event.key === 'Tab' || event.key === 'Enter') && highlightedSlashCommand) {
        event.preventDefault()
        applySlashCommand(highlightedSlashCommand)
        return
      }
    }

    if (event.key !== 'Enter') return
    const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & { which?: number }
    if (
      composingRef.current ||
      nativeEvent.isComposing ||
      nativeEvent.keyCode === 229 ||
      nativeEvent.which === 229
    ) {
      event.preventDefault()
      return
    }

    if (event.ctrlKey) {
      event.preventDefault()
      const textarea = event.currentTarget
      const { selectionStart, selectionEnd, value } = textarea
      const next = `${value.slice(0, selectionStart)}\n${value.slice(selectionEnd)}`
      textarea.value = next
      syncLocalDraft(next)
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = selectionStart + 1
      })
      return
    }

    if (event.shiftKey) return
    if (sendDisabled) return

    event.preventDefault()
    void handleSubmit()
  }

  const renderModelSelect = (location: 'header' | 'composer') => (
    <div
      className={`model-select-shell${location === 'composer' ? ' composer-model-select is-composer-anchor' : ''}`}
      ref={modelMenuRef}
    >
      <button
        type="button"
        className={`model-select${modelMenuOpen ? ' is-open' : ''}`}
        aria-label={text.statusModel}
        aria-haspopup="listbox"
        aria-expanded={modelMenuOpen}
        title={text.statusModel}
        draggable={false}
        disabled={card.status === 'streaming'}
        onClick={(event) => {
          event.stopPropagation()
          setModelMenuStyle(null)
          setModelMenuOpen((prev) => !prev)
        }}
      >
        {currentModelOption ? (
          <>
            {getModelOptionIcon(currentModelOption)}
            <span className="model-select-label">
              {currentModelOption.usesConfiguredDefault
                ? currentModelOption.provider === 'claude'
                  ? text.claudeDefaultModelLabel
                  : text.codexDefaultModelLabel
                : currentModelOption.label}
            </span>
          </>
        ) : null}
      </button>
      {modelMenuOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={modelDropdownRef}
              className="model-dropdown-menu"
              role="listbox"
              style={
                modelMenuStyle
                    ? {
                        position: 'fixed',
                        top: `${modelMenuStyle.top}px`,
                        left: `${modelMenuStyle.left}px`,
                        minWidth: `${menuMinWidth}px`,
                        maxWidth: `${menuMaxWidth}px`,
                        maxHeight: `${menuMaxHeight}px`,
                      }
                  : {
                      position: 'fixed',
                      top: '0px',
                      left: '0px',
                      minWidth: `${menuMinWidth}px`,
                      visibility: 'hidden',
                    }
              }
            >
              {selectOptions.map((option) => {
                const value = `${option.provider}:${option.model}`
                const label = option.usesConfiguredDefault
                  ? option.provider === 'claude'
                    ? text.claudeDefaultModelLabel
                    : text.codexDefaultModelLabel
                  : option.label
                return (
                  <button
                    key={value}
                    type="button"
                    role="option"
                    className={`model-dropdown-option${value === selectValue ? ' is-selected' : ''}`}
                    aria-selected={value === selectValue}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (isBrainstormCard) {
                        onPatchCard({
                          brainstorm: {
                            ...card.brainstorm,
                            provider: option.provider,
                            model: normalizeStoredModel(option.provider, option.model),
                          },
                        })
                      } else {
                        onChangeModel(option.provider, option.model)
                      }
                      setModelMenuStyle(null)
                      setModelMenuOpen(false)
                    }}
                  >
                    {getModelOptionIcon(option)}
                    <span>{label}</span>
                  </button>
                )
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  )

  return (
    <article
      className={`card-shell${isCollapsed ? ' is-collapsed' : ''}${isRestored ? ' is-restored-flash' : ''}${hasFloatingUi ? ' has-floating-ui' : ''}${usesPaneChrome ? ' is-pane-embedded' : ''}${statusClass}`}
      style={isCollapsed ? undefined : { height: '100%' }}
      onAnimationEnd={(e) => {
        if (e.animationName === 'card-restored-flash' && isRestored) {
          onRestoredAnimationEnd()
        }
      }}
      onClickCapture={(event) => {
        if (card.unread) onMarkRead()
        if (!isToolCard && !isCardHeaderControlTarget(event.target) && lastFocusedCardId !== card.id) {
          lastFocusedCardId = card.id
          requestAnimationFrame(() => textareaRef.current?.focus())
        }
      }}
    >
      {!usesPaneChrome && card.unread && <span className="card-unread-dot" />}
      {showsCardHeader ? (
        <header
          className="card-header"
          onClick={(event) => {
            if (!usesPaneChrome && !isCardHeaderControlTarget(event.target)) {
              onToggleCollapsed()
            }
          }}
        >
          <div className="card-title-row">
            <div className="card-actions">
              {showsHeaderModelSelect ? renderModelSelect('header') : null}

              {showsCardTitle ? (
                editingTitle ? (
                  <input
                    ref={titleInputRef}
                    className="card-title-input"
                    value={editingTitleValue}
                    onChange={(e) => setEditingTitleValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onChangeTitle(editingTitleValue.trim())
                        setEditingTitle(false)
                      }
                      if (e.key === 'Escape') setEditingTitle(false)
                    }}
                    onBlur={() => {
                      onChangeTitle(editingTitleValue.trim())
                      setEditingTitle(false)
                    }}
                  />
                ) : (
                  <h2
                    className={`card-title${!card.title && !isMusicToolCard ? ' is-placeholder' : ''}`}
                    data-card-header-control="true"
                    onClick={(event) => {
                      event.stopPropagation()
                      startTitleEditing()
                    }}
                  >
                    {displayTitle}
                  </h2>
                )
              ) : null}

              {isGitToolCard && gitInfo ? (
                <div className="git-header-info">
                  <span className="git-header-repo">{gitInfo.repoName}</span>
                  <span className="git-header-sep" aria-hidden="true">/</span>
                  <span className="git-header-branch">{gitInfo.branch}</span>
                </div>
              ) : null}

            </div>
          </div>
        </header>
      ) : null}

      {!usesPaneChrome ? (
        <IconButton
          label={text.deleteCard}
          className="card-close-button"
          data-card-header-control="true"
          onClick={handleRemoveClick}
        >
          <CloseIcon />
        </IconButton>
      ) : null}

      {isGitToolCard && (
        <div style={isCollapsed ? { display: 'none' } : { display: 'contents' }}>
          <GitToolCard
            workspacePath={workspacePath}
            language={language}
            gitAgentModel={gitAgentModel}
            systemPrompt={systemPrompt}
            modelPromptRules={modelPromptRules}
            crossProviderSkillReuseEnabled={crossProviderSkillReuseEnabled}
            isActive={!suspendPaneRuntimeEffects}
            requestedHeight={card.size ?? 440}
            onAgentPanelToggle={setGitAgentPanelOpen}
            onGitInfoChange={setGitInfo}
          />
        </div>
      )}

      {isMusicToolCard && (
        <div style={isCollapsed ? { display: 'none' } : { display: 'contents' }}>
          <MusicCard workspacePath={workspacePath} language={language} showAlbumCover={musicAlbumCoverEnabled} onTitleChange={setMusicTitleOverride} />
        </div>
      )}

      {isWhiteNoiseCard && (
        <div style={isCollapsed ? { display: 'none' } : { display: 'contents' }}>
          <WhiteNoiseCard language={language} />
        </div>
      )}

      {isWeatherCard && (
        <div style={isCollapsed ? { display: 'none' } : { display: 'contents' }}>
          <WeatherCard language={language} city={weatherCity} />
        </div>
      )}

      {isStickyNoteCard && (
        <div style={isCollapsed ? { display: 'none' } : { display: 'contents' }}>
          <StickyNoteCard content={card.stickyNote} language={language} onChange={(content) => {
            onStickyNoteChange(content)
            const firstLine = content.split('\n')[0].trim()
            onChangeTitle(firstLine)
          }} />
        </div>
      )}


      {isFileTreeCard && !isCollapsed && (
        <FileTreeCard
          cardId={card.id}
          workspacePath={workspacePath}
          language={language}
          onOpenFile={handleOpenWorkspaceFile}
        />
      )}

      {isBrainstormCard && !isCollapsed && (
        <BrainstormCard
          card={card}
          language={language}
          systemPrompt={systemPrompt}
          modelPromptRules={modelPromptRules}
          crossProviderSkillReuseEnabled={crossProviderSkillReuseEnabled}
          providerReady={providerReady}
          workspacePath={workspacePath}
          requestModel={brainstormRequestModel}
          onDraftChange={onDraftChange}
          onChangeTitle={onChangeTitle}
          onPatchCard={onPatchCard}
        />
      )}

      {isTextEditorCard && !isCollapsed && (
        <TextEditorCard
          workspacePath={workspacePath}
          filePath={card.stickyNote}
          language={language}
        />
      )}

      {!isCollapsed && showsToolFooterModelSelect ? (
        <footer className="card-footer tool-model-footer">
          <div className="tool-model-footer-row">
            {renderModelSelect('composer')}
          </div>
        </footer>
      ) : null}

      {!isCollapsed && (
        <>
          {!isToolCard && !deferInactivePaneChatBody && (
            <>
              <ChatTranscript
                isActive={!suspendPaneRuntimeEffects}
                language={language}
                workspacePath={workspacePath}
                cardStatus={card.status}
                recoveryStatus={recoveryStatus}
                onManualRecoverStream={showManualStreamRecovery ? onManualRecoverStream : undefined}
                messages={card.messages}
                messageListRef={messageListRef}
                renderableMessages={renderableMessages}
                restoreBottomSpacerPx={restoredScrollSpacerPx}
                compactionBannerCopy={compactionBannerCopy}
                collapsedGroups={collapsedGroups}
                showsQuickToolGrid={showsQuickToolGrid}
                quickToolEntries={quickToolEntries}
                emptyStateToolsLabel={text.emptyStateToolsLabel}
                askUserAnswers={askUserAnswers}
                onScroll={syncAutoScrollPreference}
                onRevealAllCompactedHistory={revealAllCompactedHistory}
                onRevealMoreCompactedHistory={revealNextCompactedHistoryBatch}
                onActivateQuickTool={activateQuickTool}
                onToggleToolGroup={toggleToolGroup}
                onSelectAskUserOption={handleSelectAskUserOption}
                onJumpToStickyMessageSource={jumpToStickyMessageSource}
                onOpenFile={openFileCallback}
                onForkConversation={onForkConversation}
              />

              <footer className="card-footer">
                <div className="composer" ref={composerRef}>
              {pendingAttachments.length > 0 ? (
                <div className="composer-attachment-list">
                  {pendingAttachments.map((attachment, index) => (
                    <div key={attachment.id} className="composer-attachment-item">
                      <img
                        className="composer-attachment-image"
                        src={attachment.previewUrl}
                        alt={text.pastedImageAlt(index + 1)}
                      />
                      <button
                        type="button"
                        className="composer-attachment-remove"
                        aria-label={text.removeAttachment}
                        title={text.removeAttachment}
                        onClick={() => removePendingAttachment(attachment.id)}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="composer-input-row">
                {showsComposerModelSelect ? renderModelSelect('composer') : null}
                <textarea
                  ref={textareaRef}
                  className="control textarea"
                  rows={1}
                  placeholder={
                    !workspacePath.trim()
                      ? text.placeholderSetWorkspace
                      : providerReady
                        ? ''
                        : text.placeholderCliUnavailable
                  }
                  defaultValue={draftValueRef.current}
                  onChange={(event) => {
                    syncLocalDraft(event.target.value, !composingRef.current)
                  }}
                  onPaste={handlePaste}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  onBlur={() => {
                    flushPendingDraftSync()
                  }}
                  onKeyDown={handleTextareaKeyDown}
                />
                <div className="composer-actions">
                  {autoUrgeEnabled && autoUrgeActive ? (
                    <span className="composer-auto-urge-status">{text.autoUrgeRunningStatus}</span>
                  ) : null}
                  <div className="composer-settings-shell" ref={settingsMenuRef}>
                    <IconButton
                      label={text.composerSettings}
                      className={`composer-settings-trigger${settingsMenuOpen ? ' is-open' : ''}${autoUrgeEnabled && autoUrgeActive ? ' has-auto-urge' : ''}`}
                      aria-expanded={settingsMenuOpen}
                      onClick={() => {
                        setSettingsMenuStyle(null)
                        setSettingsMenuOpen((prev) => !prev)
                      }}
                    >
                      <SlidersIcon />
                    </IconButton>
                  </div>
                  {settingsMenuOpen && typeof document !== 'undefined'
                    ? createPortal(
                        <div
                          ref={settingsDropdownRef}
                          className="composer-settings-menu"
                          style={
                            settingsMenuStyle
                              ? {
                                  position: 'fixed',
                                  top: `${settingsMenuStyle.top}px`,
                                  left: `${settingsMenuStyle.left}px`,
                                  maxWidth: `${settingsMenuStyle.maxWidth}px`,
                                }
                              : {
                                  position: 'fixed',
                                  top: '0px',
                                  left: '0px',
                                  visibility: 'hidden',
                                }
                          }
                        >
                          <label className="composer-settings-row">
                            <span className="composer-settings-label">{text.thinking}</span>
                            <input
                              type="checkbox"
                              className="composer-settings-checkbox"
                              checked={card.thinkingEnabled !== false}
                              onChange={() => onToggleThinking()}
                            />
                          </label>
                          <div className="composer-settings-row">
                            <span className="composer-settings-label">{thinkingDepthLabel}</span>
                            <select
                              className="reasoning-select"
                              value={reasoningValue}
                              disabled={card.thinkingEnabled === false}
                              onChange={(event) => onChangeReasoningEffort(event.target.value)}
                            >
                              {reasoningOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          {card.provider === 'claude' ? (
                            <label className="composer-settings-row">
                              <span className="composer-settings-label">{text.planMode}</span>
                              <input
                                type="checkbox"
                                className="composer-settings-checkbox"
                                checked={card.planMode}
                                onChange={() => onTogglePlanMode()}
                              />
                            </label>
                          ) : null}
                          <>
                            <label className="composer-settings-row">
                              <span className="composer-settings-label">{text.autoUrgeLabel}</span>
                              <input
                                type="checkbox"
                                className="composer-settings-checkbox"
                                checked={composerAutoUrgeChecked}
                                onChange={() => {
                                  const nextToggle = getNextAutoUrgeToggleState({
                                    featureEnabled: autoUrgeEnabled,
                                    chatActive: autoUrgeActive,
                                    status: card.status,
                                  })
                                  pendingImmediateAutoUrgeRef.current = nextToggle.shouldSendImmediately
                                  if (nextToggle.featureEnabled !== autoUrgeEnabled) {
                                    onSetAutoUrgeEnabled(nextToggle.featureEnabled)
                                  }
                                  setAutoUrgeActive(nextToggle.chatActive)
                                  onPatchCard({ autoUrgeActive: nextToggle.chatActive })
                                }}
                              />
                            </label>
                            {!autoUrgeEnabled ? (
                              <div className="composer-settings-note">{text.autoUrgeReenableHint}</div>
                            ) : null}
                            <label className="composer-settings-row">
                              <span className="composer-settings-label">{text.autoUrgeTypesLabel}</span>
                              <select
                                className="reasoning-select composer-auto-urge-profile-select"
                                value={effectiveAutoUrgeProfileId}
                                onChange={(event) => {
                                  const nextProfileId = event.target.value
                                  setSelectedAutoUrgeProfileId(nextProfileId)
                                  onPatchCard({ autoUrgeProfileId: nextProfileId })
                                }}
                                disabled={autoUrgeProfiles.length <= 1}
                              >
                                {autoUrgeProfiles.map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {profile.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </>
                        </div>,
                        document.body,
                      )
                    : null}
                  {showManualStreamRecovery ? (
                    <IconButton
                      label={text.streamRecoveryManualResume}
                      className="manual-stream-recovery-composer-button"
                      onClick={onManualRecoverStream}
                    >
                      <RefreshIcon />
                    </IconButton>
                  ) : null}
                  {card.status === 'streaming' ? (
                    <IconButton label={text.stopRun} onClick={onStop}>
                      <StopIcon />
                    </IconButton>
                  ) : null}
                  <HoverTooltip content={sendButtonTooltip}>
                    <IconButton
                      label={sendButtonLabel}
                      tone="primary"
                      onClick={() => void handleSubmit()}
                      onContextMenu={handleSendButtonContextMenu}
                      disabled={sendDisabled}
                      title={sendButtonTooltip}
                    >
                      <SendIcon />
                    </IconButton>
                  </HoverTooltip>
                </div>
              </div>

              {queuedSendSummary ? (
                <div className="composer-queued-send" role="status" title={queuedSendText}>
                  <span className="composer-queued-send-text">{queuedSendText}</span>
                  <button
                    type="button"
                    className="composer-queued-send-action"
                    onClick={onSendNextQueuedNow}
                    disabled={!onSendNextQueuedNow}
                  >
                    {text.queuedSendNow}
                  </button>
                  <button
                    type="button"
                    className="composer-queued-send-action"
                    onClick={onCancelQueuedSends}
                    disabled={!onCancelQueuedSends}
                  >
                    {text.queuedSendCancel}
                  </button>
                </div>
              ) : null}

              {composerNotice ? (
                <div
                  className={`composer-attachment-note is-${composerNotice.tone}`}
                  role={composerNotice.tone === 'error' ? 'alert' : 'status'}
                >
                  {composerNotice.message}
                </div>
              ) : null}

              {slashMenuOpen ? (
                <div ref={slashMenuRef} className="slash-command-menu" role="listbox" aria-label={text.slashCommands}>
                  {filteredSlashCommands.length > 0 ? (
                    filteredSlashCommands.map((command, index) => (
                      <button
                        key={`${command.source}:${command.name}`}
                        ref={index === activeSlashIndex ? activeSlashItemRef : undefined}
                        type="button"
                        className={`slash-command-item${index === activeSlashIndex ? ' is-selected' : ''}`}
                        title={command.description ?? `/${command.name}`}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          applySlashCommand(command)
                        }}
                      >
                        <span className="slash-command-header">
                          <span className="slash-command-name">/{command.name}</span>
                          <span className="slash-command-badges">
                            <span className={`slash-command-badge is-${command.source}`}>
                              {getSlashCommandSourceLabel(language, command.source)}
                            </span>
                            {command.source === 'skill' && command.skillProvider ? (
                              <span className={`slash-command-badge is-provider-${command.skillProvider}`}>
                                {command.skillProvider === 'codex' ? 'Codex' : 'Claude'}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <span className="slash-command-description">
                          {command.description ?? `/${command.name}`}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="slash-command-empty">
                      {effectiveSlashCommandsStatus === 'loading'
                        ? text.loadingSlashCommands
                        : text.noMatchingSlashCommands}
                    </div>
                  )}
                </div>
              ) : null}
                </div>
              </footer>
            </>
          )}

        </>
      )}
    </article>
  )
}

export const ChatCard = memo(ChatCardView, areChatCardPropsEqual)
ChatCard.displayName = 'ChatCard'
