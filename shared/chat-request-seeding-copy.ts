import type { AppLanguage } from './schema.js'

/**
 * 换会话 transcript 重放壳子的文案。原来住在 src/chat-request-seeding.ts（只有渲染进程用），
 * 用量统计要在服务端认出这层壳子（docs/specs/claude-usage-ledger FR-5），所以提到 shared。
 * `buildSeededPromptBody` 的行结构：
 *   intro / context / '' / transcriptLabel / transcript / '' / latestMessageLabel /
 *   latestTurn || emptyLatestMessage / '' / replyInstruction / doNotMentionFork
 */
export const getSeededPromptCopy = (language: AppLanguage) =>
  language === 'en'
    ? {
        intro: 'Continue this conversation in a new session.',
        context: 'Treat the transcript below as prior context for the reply.',
        transcriptLabel: 'Prior transcript:',
        latestMessageLabel: 'Latest user message:',
        emptyLatestMessage:
          'Please continue. (The user sent an empty message, which means: keep working on the task above.)',
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
        emptyLatestMessage: '请继续。（用户发送了空消息，含义是：继续完成上面的任务。）',
        replyInstruction: '请基于上面的 transcript 回答当前用户消息。',
        doNotMentionFork: '除非用户主动问起，否则不要提到这是分叉或重放出来的上下文。',
        attachedImagesLabel: '附图',
        omittedTranscript: (count: number) => `[更早的 transcript 已省略：${count} 条消息。]`,
        truncatedBlock: (omittedChars: number) => `[分叉上下文已截断：省略 ${omittedChars} 个字符。]`,
      }

/** 重放壳子里「当前用户消息」段末尾的附图说明行；统计提示词字符数时要剥掉。 */
export const getLatestTurnAttachmentLine = (language: AppLanguage, count: number, names: string) =>
  language === 'en'
    ? `The latest user turn includes ${count} attached image${count === 1 ? '' : 's'}: ${names}.`
    : `当前这条用户消息还包含 ${count} 张附图：${names}。`

/** 与 `getLatestTurnAttachmentLine` 同形的识别正则（两种语言）。 */
export const latestTurnAttachmentLinePattern =
  /^(?:当前这条用户消息还包含 \d+ 张附图|The latest user turn includes \d+ attached images?)/

export const seededPromptLanguages: readonly AppLanguage[] = ['zh-CN', 'en']
