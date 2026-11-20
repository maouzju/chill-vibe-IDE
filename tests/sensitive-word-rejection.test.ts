import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { extractBlockedSensitiveWords, isSensitiveWordRejection } from '../shared/sensitive-word-rejection.ts'
import { classifyProviderStreamErrorRecovery } from '../server/provider-stream-recovery.ts'
import {
  countSensitiveWordsInClaudeSession,
  maskSensitiveWordsInTranscript,
  registerSensitiveWordScrub,
  repairClaudeSessionForResume,
} from '../server/claude-session-repair.ts'

// 测试里刻意不用真实敏感词：中转站会拦截带它的请求，连写测试的 agent 自己都会被打断。
const WORD = '违禁词甲'
const OTHER = 'BADWORD'
const rejection = (words: string) =>
  `API Error: 500 user sensitive words detected: ${words} (request id: 202610200249453477149438268d9d6qkdZvedU). This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (api.duckcoding.ai).`

describe('sensitive word rejection', () => {
  it('parses the blocked words out of the relay error', () => {
    assert.equal(isSensitiveWordRejection(rejection(WORD)), true)
    assert.deepEqual(extractBlockedSensitiveWords(rejection(WORD)), [WORD])
    assert.deepEqual(extractBlockedSensitiveWords(rejection(`${WORD}, ${OTHER}`)), [WORD, OTHER])
    assert.deepEqual(extractBlockedSensitiveWords(rejection(`${WORD}，${OTHER}`)), [WORD, OTHER])
    assert.equal(isSensitiveWordRejection('API Error: 500 Internal server error'), false)
    assert.deepEqual(extractBlockedSensitiveWords('API Error: 500 Internal server error'), [])
  })

  it('is not resumable by itself even though the CLI tags it server-side temporary', () => {
    assert.deepEqual(classifyProviderStreamErrorRecovery({ sessionId: 's1' }, rejection(WORD)), {})
  })
})

const sessionId = 'eeeeeeee-0000-0000-0000-000000000001'
const line = (entry: Record<string, unknown>) => JSON.stringify({ sessionId, ...entry })
const transcript = () => [
  line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'read the file' } }),
  line({
    type: 'user',
    uuid: 'u2',
    parentUuid: 'u1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `line with ${WORD} inside` }] },
  }),
  line({
    type: 'assistant',
    uuid: 'x1',
    parentUuid: 'u2',
    isApiErrorMessage: true,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: rejection(WORD) }] },
  }),
].join('\n')

describe('masking sensitive words in the Claude transcript', () => {
  it('masks every occurrence and only counts real history, not the synthetic error bubble', () => {
    const result = maskSensitiveWordsInTranscript(transcript(), [WORD])
    assert.equal(result.content.includes(WORD), false)
    assert.equal(result.maskedInHistory, 1)
    assert.equal(result.masked, 2)
    assert.ok(result.content.includes('line with **** inside'))
    // parentUuid 链不动
    const entries = result.content.split('\n').map((raw) => JSON.parse(raw))
    assert.deepEqual(entries.map((entry) => entry.parentUuid), [null, 'u1', 'u2'])
  })

  it('leaves the transcript untouched when the word is absent', () => {
    const original = transcript()
    const result = maskSensitiveWordsInTranscript(original, [OTHER])
    assert.equal(result.content, original)
    assert.equal(result.masked, 0)
  })

  // 2026-11-20 审查：旧实现对整行原始 JSON 做字符串替换，会改掉带签名的 thinking 正文（回传必 400），
  // 也会把 `\t` + 词这类转义拆成非法的 `\*`，整行解析失败后被 CLI 跳过、parentUuid 链断开。
  it('never touches a signed thinking block, even when the word sits inside it', () => {
    const thinkingBlock = { type: 'thinking', thinking: `planning around ${WORD} first`, signature: `sig-${WORD}-AbC==` }
    const original = [
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: `please read ${WORD}` } }),
      line({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: { role: 'assistant', content: [thinkingBlock, { type: 'text', text: `found ${WORD} in the file` }] },
      }),
      line({
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: `only ${WORD} here`, signature: 'sig-2' }] },
      }),
    ]
    const result = maskSensitiveWordsInTranscript(original.join('\n'), [WORD])
    const lines = result.content.split('\n')
    const entries = lines.map((raw) => JSON.parse(raw))

    assert.equal(entries[0].message.content, 'please read ****')
    assert.deepEqual(entries[1].message.content[0], thinkingBlock)
    assert.ok(lines[1].includes(JSON.stringify(thinkingBlock)), 'thinking 块的序列化必须逐字节保留')
    assert.equal(entries[1].message.content[1].text, 'found **** in the file')
    // 词只在 thinking 里的那一行整行原样保留。
    assert.equal(lines[2], original[2])
    // thinking 里的命中改不了，不能算进「打码后可续传」的计数。
    assert.equal(result.masked, 2)
    assert.equal(result.maskedInHistory, 2)

    const thinkingOnly = maskSensitiveWordsInTranscript(original[2], [WORD])
    assert.equal(thinkingOnly.content, original[2])
    assert.equal(thinkingOnly.masked, 0)
    assert.equal(thinkingOnly.maskedInHistory, 0)
  })

  it('keeps every line valid JSON when the word follows an escape sequence, and leaves unparseable lines alone', () => {
    // 原文里是「制表符 + word」，JSON 里写成 `\tword`；占位词 tword 只在转义层面"出现"。
    const escapeWord = 'tword'
    const tabbed = line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'col1\tword col2' } })
    const realHit = line({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { role: 'user', content: 'path logs\\tword.txt' } })
    const broken = `{"type":"user","uuid":"u3","message":{"content":"half written ${escapeWord}`
    const result = maskSensitiveWordsInTranscript([tabbed, realHit, broken].join('\n'), [escapeWord])
    const lines = result.content.split('\n')

    assert.equal(JSON.parse(lines[0]).message.content, 'col1\tword col2')
    assert.equal(JSON.parse(lines[1]).message.content, 'path logs\\****.txt')
    assert.equal(lines[2], broken)
    assert.equal(result.masked, 1)
  })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensitive-word-scrub-test-'))
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('counts first, then a registered scrub is applied on the next spawn and the next count is zero', async () => {
    const filePath = path.join(tmpDir, `${sessionId}.jsonl`)
    fs.writeFileSync(filePath, transcript(), 'utf8')
    const find = () => filePath

    assert.equal(countSensitiveWordsInClaudeSession(sessionId, [WORD], find), 1)
    registerSensitiveWordScrub(sessionId, [WORD])
    assert.ok((await repairClaudeSessionForResume(sessionId, find)) >= 1)
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(WORD), false)
    assert.equal(countSensitiveWordsInClaudeSession(sessionId, [WORD], find), 0)

    // 打码只做一次：下次 spawn 不再重复处理
    assert.equal(await repairClaudeSessionForResume(sessionId, find), 0)
  })
})
