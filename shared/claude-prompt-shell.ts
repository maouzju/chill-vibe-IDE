import {
  getSeededPromptCopy,
  latestTurnAttachmentLinePattern,
  seededPromptLanguages,
} from './chat-request-seeding-copy.js'
import {
  CLAUDE_EMPTY_CONTINUE_PROMPT,
  CLAUDE_EMPTY_CONTINUE_PROMPT_ZH,
  CLAUDE_IMAGE_PROMPT_PREFIX_MULTI,
  CLAUDE_IMAGE_PROMPT_PREFIX_SINGLE,
  CLAUDE_REQUEST_INTERRUPTED_PREFIX,
} from './claude-prompt-markers.js'
import { defaultAutoUrgeMessage } from './schema.js'

/**
 * 把一条 Claude 会话里 `type: 'user'` 的正文剥到"用户亲手打的那部分"；返回 '' 表示整条都是
 * Chill Vibe / CLI 替用户发的，不计入提示词次数与字符数（docs/specs/claude-usage-ledger FR-5）。
 *
 * 识别用的全是仓库里现成的常量 / 文案对象，不另抄字符串：壳子的文案一改，这里自动跟着变。
 * 参考 token-dashboard/server.py 的 own_text()：本机 1137 万字提示词里约 1000 万是这些壳子。
 */
export const stripChillVibePromptShell = (
  raw: string,
  { urgeMessages = [] }: { urgeMessages?: readonly string[] } = {},
): string => {
  let text = raw.trim()
  if (!text || text.startsWith('<')) {
    return ''
  }

  text = stripImagePrefix(text)
  text = stripSeededShell(text)

  if (!text) {
    return ''
  }
  if (text === CLAUDE_EMPTY_CONTINUE_PROMPT || text === CLAUDE_EMPTY_CONTINUE_PROMPT_ZH) {
    return ''
  }
  for (const language of seededPromptLanguages) {
    if (text === getSeededPromptCopy(language).emptyLatestMessage) {
      return ''
    }
  }
  if (text.startsWith(CLAUDE_REQUEST_INTERRUPTED_PREFIX)) {
    return ''
  }
  for (const urge of [defaultAutoUrgeMessage, ...urgeMessages]) {
    const trimmed = urge.trim()
    if (trimmed && text.startsWith(trimmed)) {
      return ''
    }
  }
  return text
}

/**
 * `Analyze this image(s):\n<路径>…\n\n<正文>` → 正文。图片路径行与正文之间空一行；
 * 没有空行就是只贴了图没打字。
 */
const stripImagePrefix = (text: string) => {
  const prefix = text.startsWith(`${CLAUDE_IMAGE_PROMPT_PREFIX_SINGLE}\n`)
    ? CLAUDE_IMAGE_PROMPT_PREFIX_SINGLE
    : text.startsWith(`${CLAUDE_IMAGE_PROMPT_PREFIX_MULTI}\n`)
      ? CLAUDE_IMAGE_PROMPT_PREFIX_MULTI
      : null
  if (!prefix) {
    return text
  }
  const separator = text.indexOf('\n\n')
  return separator < 0 ? '' : text.slice(separator + 2).trim()
}

/**
 * 重放壳子只取「当前用户消息」那一段：从 `latestMessageLabel` 的下一行起，到紧跟其后的
 * 空行为止（`buildSeededPromptBody` 在这段后面固定放一个空行再接 replyInstruction）。
 * 末尾的附图说明行剥掉。
 */
const stripSeededShell = (text: string) => {
  for (const language of seededPromptLanguages) {
    const copy = getSeededPromptCopy(language)
    if (!text.startsWith(copy.intro)) {
      continue
    }
    const labelMarker = `\n${copy.latestMessageLabel}\n`
    const labelAt = text.indexOf(labelMarker)
    if (labelAt < 0) {
      return ''
    }
    const bodyStart = labelAt + labelMarker.length
    const instructionAt = text.indexOf(`\n\n${copy.replyInstruction}`, bodyStart)
    const body = (instructionAt < 0 ? text.slice(bodyStart) : text.slice(bodyStart, instructionAt)).trim()
    if (body === copy.emptyLatestMessage) {
      return ''
    }
    const lines = body.split('\n')
    while (lines.length > 0 && latestTurnAttachmentLinePattern.test(lines[lines.length - 1]!.trim())) {
      lines.pop()
    }
    return lines.join('\n').trim()
  }
  return text
}
