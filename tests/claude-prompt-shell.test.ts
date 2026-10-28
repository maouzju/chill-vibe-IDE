import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getSeededPromptCopy } from '../shared/chat-request-seeding-copy.ts'
import {
  CLAUDE_EMPTY_CONTINUE_PROMPT,
  CLAUDE_IMAGE_PROMPT_PREFIX_MULTI,
  CLAUDE_IMAGE_PROMPT_PREFIX_SINGLE,
} from '../shared/claude-prompt-markers.ts'
import { stripChillVibePromptShell } from '../shared/claude-prompt-shell.ts'
import { defaultAutoUrgeMessage } from '../shared/schema.ts'

/** 按 src/chat-request-seeding.ts 的 buildSeededPromptBody 同一行结构拼壳子。 */
const seeded = (language: 'zh-CN' | 'en', latestTurn: string) => {
  const copy = getSeededPromptCopy(language)
  return [
    copy.intro,
    copy.context,
    '',
    copy.transcriptLabel,
    '用户：之前的话\n\n助手：之前的回答',
    '',
    copy.latestMessageLabel,
    latestTurn || copy.emptyLatestMessage,
    '',
    copy.replyInstruction,
    copy.doNotMentionFork,
  ].join('\n')
}

const strip = (text: string, urgeMessages: string[] = []) =>
  stripChillVibePromptShell(text, { urgeMessages })

describe('stripChillVibePromptShell', () => {
  it('keeps plain user text untouched', () => {
    assert.equal(strip('帮我修一下这个 bug'), '帮我修一下这个 bug')
  })

  it('drops the image prefix and keeps the body', () => {
    assert.equal(
      strip(`${CLAUDE_IMAGE_PROMPT_PREFIX_SINGLE}\nC:\\tmp\\a.png\n\n看看这张图哪里不对`),
      '看看这张图哪里不对',
    )
    assert.equal(
      strip(`${CLAUDE_IMAGE_PROMPT_PREFIX_MULTI}\nC:\\tmp\\a.png\nC:\\tmp\\b.png\n\n对比一下`),
      '对比一下',
    )
    // 只贴图没正文：不算用户亲手打的
    assert.equal(strip(`${CLAUDE_IMAGE_PROMPT_PREFIX_SINGLE}\nC:\\tmp\\a.png`), '')
  })

  it('keeps only the latest user message out of a replay shell (both languages)', () => {
    assert.equal(strip(seeded('zh-CN', '赶紧实现')), '赶紧实现')
    assert.equal(strip(seeded('en', 'ship it')), 'ship it')
    // 多行正文整段保留
    assert.equal(strip(seeded('zh-CN', '第一行\n第二行')), '第一行\n第二行')
  })

  it('strips the attachment note at the end of the replayed latest turn', () => {
    assert.equal(
      strip(seeded('zh-CN', '看图\n当前这条用户消息还包含 2 张附图：a.png, b.png。')),
      '看图',
    )
    assert.equal(
      strip(seeded('en', 'look\nThe latest user turn includes 1 attached image: a.png.')),
      'look',
    )
  })

  it('unwraps a replay shell that is itself wrapped in the image prefix', () => {
    const text = `${CLAUDE_IMAGE_PROMPT_PREFIX_SINGLE}\nC:\\tmp\\a.png\n\n${seeded('zh-CN', '照这张图改')}`
    assert.equal(strip(text), '照这张图改')
  })

  it('drops the empty-send fallbacks only when the whole text is that sentence', () => {
    assert.equal(strip(CLAUDE_EMPTY_CONTINUE_PROMPT), '')
    assert.equal(strip('请继续。'), '')
    assert.equal(strip('请继续。另外把测试也补上'), '请继续。另外把测试也补上')
    // 重放壳子里的空发送同样不算
    assert.equal(strip(seeded('zh-CN', '')), '')
    assert.equal(strip(seeded('en', '')), '')
    assert.equal(strip(getSeededPromptCopy('zh-CN').emptyLatestMessage), '')
  })

  it('drops interrupt markers and urge messages', () => {
    assert.equal(strip('[Request interrupted by user]'), '')
    assert.equal(strip('[Request interrupted by user for tool use]'), '')
    assert.equal(strip(defaultAutoUrgeMessage), '')
    assert.equal(strip('快点干活，不许停', ['快点干活，不许停']), '')
    // 不在名单里的同义句不剔
    assert.equal(strip('快点干活，不许停'), '快点干活，不许停')
  })

  it('ignores synthetic and meta rows by the caller contract', () => {
    // 以 < 开头的正文是 CLI / 工具注入的 XML，不是用户打的
    assert.equal(strip('<command-name>/compact</command-name>'), '')
  })
})
