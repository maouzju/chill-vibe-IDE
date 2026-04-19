import { getChatMessageAttachments } from '../shared/chat-attachments.ts'
import type {
  AppLanguage,
  CardStatus,
  ChatMessage,
  ImageAttachment,
  Provider,
} from '../shared/schema.ts'
import { getCompactMessageWindow, isHiddenCompactBoundaryMessage } from './components/chat-card-compaction'
import {
  parseStructuredAskUserMessage,
  parseStructuredCommandMessage,
  parseStructuredEditsMessage,
  parseStructuredReasoningMessage,
  parseStructuredTodoMessage,
  parseStructuredToolMessage,
  readStructuredData,
} from './components/chat-card-parsing'

const MAX_SEEDED_PROMPT_CHARS = 6_000
const MAX_REPLAY_ENTRY_CHARS = 1_100
const MIN_REPLAY_ENTRY_CHARS = 260

const indentBlock = (value: string, prefix = '  ') =>
  value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')

const formatAttachmentSummary = (attachment: ImageAttachment) =>
  `${attachment.fileName} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`

const pushLabeledValue = (sections: string[], label: string, value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    return
  }

  if (trimmed.includes('\n')) {
    sections.push(`${label}:\n${indentBlock(trimmed)}`)
    return
  }

  sections.push(`${label}: ${trimmed}`)
}

const pushLabeledList = (sections: string[], label: string, items: string[]) => {
  if (items.length === 0) {
    return
  }

  sections.push(`${label}:\n${items.map((item) => `  - ${item}`).join('\n')}`)
}

const getReplaySpeakerLabel = (language: AppLanguage, role: ChatMessage['role']) => {
  if (role === 'assistant') {
    return language === 'en' ? 'Assistant' : '助手'
  }

  return language === 'en' ? 'User' : '用户'
}

const getAttachmentLine = (
  language: AppLanguage,
  attachments: ImageAttachment[],
  prefix: 'transcript' | 'latest-turn',
) => {
  if (attachments.length === 0) {
    return ''
  }

  const names = attachments.map((attachment) => attachment.fileName).join(', ')
  const count = attachments.length

  if (language === 'en') {
    if (prefix === 'latest-turn') {
      return `The latest user turn includes ${count} attached image${count === 1 ? '' : 's'}: ${names}.`
    }

    return `Attached image${count === 1 ? '' : 's'}: ${names}`
  }

  if (prefix === 'latest-turn') {
    return `当前这条用户消息还包含 ${count} 张附图：${names}。`
  }

  return `附图：${names}`
}

const getSeededPromptCopy = (language: AppLanguage) =>
  language === 'en'
    ? {
        intro: 'Continue this conversation in a new session.',
        context: 'Treat the transcript below as prior context for the reply.',
        transcriptLabel: 'Prior transcript:',
        latestMessageLabel: 'Latest user message:',
        emptyLatestMessage: 'The latest user turn includes no text.',
        replyInstruction: 'Reply to the latest user message using the prior transcript as context.',
        doNotMentionFork:
          'Do not mention that the conversation was forked or replayed unless the user asks.',
        attachedImagesLabel: 'Attached images',
        omittedTranscript: (count: number) =>
          `[Earlier transcript omitted: ${count} message${count === 1 ? '' : 's'}.]`,
        truncatedBlock: (omittedChars: number) =>
          `[Fork transcript truncated: ${omittedChars} characters omitted.]`,
      }
    : {
        intro: '请在一个新的会话里继续这段对话。',
        context: '把下面的 transcript 当作这次回复的已有上下文。',
        transcriptLabel: '已有 transcript：',
        latestMessageLabel: '当前用户消息：',
        emptyLatestMessage: '当前用户消息没有文本内容。',
        replyInstruction: '请基于上面的 transcript 回答当前用户消息。',
        doNotMentionFork: '除非用户主动问起，否则不要提到这是分叉或重放出来的上下文。',
        attachedImagesLabel: '附图',
        omittedTranscript: (count: number) => `[更早的 transcript 已省略：${count} 条消息。]`,
        truncatedBlock: (omittedChars: number) => `[分叉上下文已截断：省略 ${omittedChars} 个字符。]`,
      }

const truncateWithNotice = (
  value: string,
  maxChars: number,
  noticeBuilder: (omittedChars: number) => string,
) => {
  if (value.length <= maxChars) {
    return value
  }

  const safeMax = Math.max(maxChars, MIN_REPLAY_ENTRY_CHARS)
  const initialNotice = noticeBuilder(value.length)
  const initialBudget = Math.max(48, safeMax - initialNotice.length - 2)
  const initialHead = Math.max(28, Math.ceil(initialBudget * 0.62))
  const initialTail = Math.max(18, initialBudget - initialHead)
  const omittedChars = Math.max(value.length - initialHead - initialTail, 0)
  const notice = noticeBuilder(omittedChars)
  const contentBudget = Math.max(48, safeMax - notice.length - 2)
  const head = Math.max(28, Math.ceil(contentBudget * 0.62))
  const tail = Math.max(18, contentBudget - head)

  return `${value.slice(0, head)}\n${notice}\n${value.slice(value.length - tail)}`
}

const formatStructuredSections = (message: ChatMessage) => {
  const command = parseStructuredCommandMessage(message)
  if (command) {
    const sections: string[] = []
    pushLabeledValue(sections, 'Command', command.command)
    pushLabeledValue(sections, 'Exit code', command.exitCode === null ? 'null' : String(command.exitCode))
    pushLabeledValue(sections, 'Output', command.output)
    return sections
  }

  const tool = parseStructuredToolMessage(message)
  if (tool) {
    const sections: string[] = []
    pushLabeledValue(sections, 'Tool', tool.toolName)
    pushLabeledValue(sections, 'Summary', tool.summary)
    pushLabeledList(
      sections,
      'Tool input',
      Object.entries(tool.toolInput ?? {}).map(([key, value]) => `${key}: ${value}`),
    )
    return sections
  }

  const reasoning = parseStructuredReasoningMessage(message)
  if (reasoning) {
    const sections: string[] = []
    pushLabeledValue(sections, 'Reasoning', reasoning.text)
    return sections
  }

  const todo = parseStructuredTodoMessage(message)
  if (todo) {
    const sections: string[] = []
    pushLabeledList(
      sections,
      'Todo',
      todo.items.map((item) =>
        [
          `[${item.status}]`,
          item.content,
          item.priority ? `(priority: ${item.priority})` : '',
          item.activeForm ? `(active: ${item.activeForm})` : '',
        ]
          .filter(Boolean)
          .join(' '),
      ),
    )
    return sections
  }

  const edits = parseStructuredEditsMessage(message)
  if (edits) {
    const sections: string[] = []
    pushLabeledList(
      sections,
      'Edits',
      edits.files.map((file) => {
        const header = `${file.path} [${file.kind}] +${file.addedLines} -${file.removedLines}`
        const patch = file.patch.trim()
        return patch ? `${header}\n${indentBlock(`Patch:\n${indentBlock(patch)}`, '  ')}` : header
      }),
    )
    return sections
  }

  const askUser = parseStructuredAskUserMessage(message)
  if (askUser) {
    const sections: string[] = []
    askUser.questions.forEach((q, idx) => {
      const label = askUser.questions.length > 1 ? `Ask user [${idx + 1}/${askUser.questions.length}]` : 'Ask user'
      pushLabeledValue(sections, label, q.question)
      if (q.header.trim()) {
        pushLabeledValue(sections, 'Header', q.header)
      }
      pushLabeledValue(sections, 'Multi-select', q.multiSelect ? 'true' : 'false')
      pushLabeledList(
        sections,
        'Options',
        q.options.map((option) =>
          option.description.trim()
            ? `${option.label} - ${option.description}`
            : option.label,
        ),
      )
    })
    return sections
  }

  const rawStructuredData = message.meta?.structuredData?.trim()
  if (rawStructuredData) {
    const raw = readStructuredData(message)
    if (raw) {
      return [`Structured ${message.meta?.kind ?? 'activity'} data:\n${indentBlock(JSON.stringify(raw, null, 2))}`]
    }

    return [`Structured ${message.meta?.kind ?? 'activity'} data:\n${indentBlock(rawStructuredData)}`]
  }

  return []
}

const isReplayableMessage = (message: ChatMessage) => {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return false
  }

  if (isHiddenCompactBoundaryMessage(message)) {
    return false
  }

  if (message.meta?.kind === 'log') {
    return false
  }

  return (
    message.content.trim().length > 0 ||
    getChatMessageAttachments(message).length > 0 ||
    formatStructuredSections(message).length > 0
  )
}

const getSeedingWindow = ({
  messages,
  provider,
  status,
}: {
  messages: ChatMessage[]
  provider?: Provider
  status?: CardStatus
}) => {
  if (!provider) {
    return messages
  }

  return getCompactMessageWindow(messages, provider, status ?? 'idle', {
    allowPerformanceWindowing: false,
  }).visibleMessages
}

const formatReplayMessage = (language: AppLanguage, message: ChatMessage) => {
  if (!isReplayableMessage(message)) {
    return ''
  }

  const copy = getSeededPromptCopy(language)
  const sections: string[] = []
  const messageAttachments = getChatMessageAttachments(message)
  if (messageAttachments.length > 0) {
    pushLabeledList(
      sections,
      copy.attachedImagesLabel,
      messageAttachments.map((attachment) => formatAttachmentSummary(attachment)),
    )
  } else {
    const attachmentLine = getAttachmentLine(language, messageAttachments, 'transcript')
    if (attachmentLine) {
      sections.push(attachmentLine)
    }
  }

  sections.push(...formatStructuredSections(message))

  const content = message.content.trim()
  if (content) {
    sections.push(sections.length === 0 ? content : `Content:\n${indentBlock(content)}`)
  }

  return `${getReplaySpeakerLabel(language, message.role)}:\n${sections.join('\n')}`
}

const buildBoundedTranscript = (
  language: AppLanguage,
  entries: string[],
  transcriptBudget: number,
) => {
  if (entries.length === 0 || transcriptBudget <= 0) {
    return ''
  }

  const copy = getSeededPromptCopy(language)
  const selected: string[] = []
  let usedChars = 0
  let omittedCount = 0

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const compactEntry = truncateWithNotice(
      entries[index]!,
      MAX_REPLAY_ENTRY_CHARS,
      copy.truncatedBlock,
    )
    const separatorLength = selected.length > 0 ? 2 : 0
    const remainingBudget = transcriptBudget - usedChars - separatorLength

    if (remainingBudget <= 0) {
      omittedCount += 1
      continue
    }

    if (compactEntry.length <= remainingBudget) {
      selected.unshift(compactEntry)
      usedChars += compactEntry.length + separatorLength
      continue
    }

    if (selected.length === 0) {
      selected.unshift(
        truncateWithNotice(
          compactEntry,
          Math.max(remainingBudget, MIN_REPLAY_ENTRY_CHARS),
          copy.truncatedBlock,
        ),
      )
      omittedCount += index
      break
    }

    omittedCount += 1
  }

  if (selected.length === 0) {
    return ''
  }

  let transcript = selected.join('\n\n')
  while (omittedCount > 0) {
    const notice = copy.omittedTranscript(omittedCount)
    const candidate = `${notice}\n\n${transcript}`
    if (candidate.length <= transcriptBudget) {
      return candidate
    }

    if (selected.length > 1) {
      selected.shift()
      omittedCount += 1
      transcript = selected.join('\n\n')
      continue
    }

    selected[0] = truncateWithNotice(
      selected[0]!,
      Math.max(transcriptBudget - notice.length - 2, MIN_REPLAY_ENTRY_CHARS),
      copy.truncatedBlock,
    )
    transcript = selected.join('\n\n')
    return `${notice}\n\n${transcript}`
  }

  return transcript
}

const buildSeededPromptBody = (
  language: AppLanguage,
  transcript: string,
  latestTurn: string,
) => {
  const copy = getSeededPromptCopy(language)
  return [
    copy.intro,
    copy.context,
    '',
    copy.transcriptLabel,
    transcript,
    '',
    copy.latestMessageLabel,
    latestTurn || copy.emptyLatestMessage,
    '',
    copy.replyInstruction,
    copy.doNotMentionFork,
  ].join('\n')
}

export const collectSeededChatAttachments = ({
  messages,
  attachments,
  provider,
  status,
}: {
  messages: ChatMessage[]
  attachments: ImageAttachment[]
  provider?: Provider
  status?: CardStatus
}) => {
  const seen = new Set<string>()
  const merged: ImageAttachment[] = []

  const push = (attachment: ImageAttachment) => {
    if (seen.has(attachment.id)) {
      return
    }

    seen.add(attachment.id)
    merged.push(attachment)
  }

  for (const message of getSeedingWindow({ messages, provider, status })) {
    for (const attachment of getChatMessageAttachments(message)) {
      push(attachment)
    }
  }

  for (const attachment of attachments) {
    push(attachment)
  }

  return merged
}

export const hasSeededChatTranscript = ({
  sessionId,
  messages,
}: {
  sessionId?: string
  messages: ChatMessage[]
}) => !sessionId && messages.some(isReplayableMessage)

export const buildSeededChatPrompt = ({
  language,
  prompt,
  attachments,
  messages,
  provider,
  status,
}: {
  language: AppLanguage
  prompt: string
  attachments: ImageAttachment[]
  messages: ChatMessage[]
  provider?: Provider
  status?: CardStatus
}) => {
  const replayWindow = getSeedingWindow({ messages, provider, status })
  const transcriptEntries = replayWindow
    .map((message) => formatReplayMessage(language, message))
    .filter((entry) => entry.length > 0)

  if (transcriptEntries.length === 0) {
    return prompt
  }

  const latestTurnParts: string[] = []
  const latestPrompt = prompt.trim()
  if (latestPrompt) {
    latestTurnParts.push(latestPrompt)
  }

  const latestAttachmentLine = getAttachmentLine(language, attachments, 'latest-turn')
  if (latestAttachmentLine) {
    latestTurnParts.push(latestAttachmentLine)
  }

  const latestTurn = latestTurnParts.join('\n')
  const emptyTranscriptPrompt = buildSeededPromptBody(language, '', latestTurn)
  const transcriptBudget = Math.max(MAX_SEEDED_PROMPT_CHARS - emptyTranscriptPrompt.length, 0)
  const transcript = buildBoundedTranscript(language, transcriptEntries, transcriptBudget)

  return buildSeededPromptBody(language, transcript, latestTurn)
}
