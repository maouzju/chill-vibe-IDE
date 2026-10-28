/**
 * Chill Vibe 替用户往 Claude 提示词里加的"壳子"文案，server（发出去）与用量统计（认出来）共用。
 * 改这里的字面量两边一起变；别在别处再抄一份（docs/specs/claude-usage-ledger FR-5）。
 */

/** `getClaudePrompt`（server/providers.ts）贴图时的前缀：下一行起是图片路径，空一行后才是正文。 */
export const CLAUDE_IMAGE_PROMPT_PREFIX_SINGLE = 'Analyze this image:'
export const CLAUDE_IMAGE_PROMPT_PREFIX_MULTI = 'Analyze these images:'

/** 续会话但用户没打字时补给 CLI 的占位（providers.ts 两处 `Please continue.`）。 */
export const CLAUDE_EMPTY_CONTINUE_PROMPT = 'Please continue.'
/** 中文界面下同义的空发送占位；统计时同样剔除。 */
export const CLAUDE_EMPTY_CONTINUE_PROMPT_ZH = '请继续。'

/** Claude CLI 自己写进 user 行的打断标记（`[Request interrupted by user]` 等），不是用户打的。 */
export const CLAUDE_REQUEST_INTERRUPTED_PREFIX = '[Request interrupted'
