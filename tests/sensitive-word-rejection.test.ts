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
