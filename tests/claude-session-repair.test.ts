import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import fs from 'fs'
import path from 'path'
import os from 'os'

import {
  repairClaudeSessionForResume,
  stripEmptyThinkingBlocks,
  stripSyntheticNoResponseEntries,
  stripTurnEffortsWhenTailDangles,
} from '../server/claude-session-repair.ts'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-repair-test-'))
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const sessionId = 'dddddddd-0000-0000-0000-000000000001'

const line = (entry: Record<string, unknown>) => JSON.stringify({ sessionId, ...entry })

// 取自 2026-09-27 另一个无关项目的会话 59804bd1 的真实形状：停止后 CLI 写入的合成回复。
const syntheticNoResponse = (uuid: string, parentUuid: string) =>
  line({
    type: 'assistant',
    uuid,
    parentUuid,
    isSidechain: false,
    message: {
      id: '439d9cad-b8e4-4f4b-9454-d01b4d87ca27',
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      type: 'message',
      content: [{ type: 'text', text: 'No response requested.' }],
    },
  })

const interruptedTranscript = () => [
  line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } }),
  line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
  line({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  line({ type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId }),
  syntheticNoResponse('s1', 'u3'),
  line({ type: 'user', uuid: 'u4', parentUuid: 's1', message: { role: 'user', content: [{ type: 'text', text: 'Please continue.' }] } }),
  line({ type: 'attachment', uuid: 'e1', parentUuid: 'u4', attachment: { type: 'environment' } }),
  line({ type: 'assistant', uuid: 'x1', parentUuid: 'e1', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 400 messages.4: system content must contain at least one block' }] }, isApiErrorMessage: true }),
].join('\n') + '\n'

describe('stripSyntheticNoResponseEntries', () => {
  it('drops the synthetic "No response requested." reply and re-parents its child', () => {
    const result = stripSyntheticNoResponseEntries(interruptedTranscript())
    assert.equal(result.removed, 1)
    const entries = result.content.trim().split('\n').map((raw) => JSON.parse(raw))
    assert.equal(entries.some((entry) => entry.uuid === 's1'), false)
    assert.equal(entries.find((entry) => entry.uuid === 'u4').parentUuid, 'u3')
    // 其余行逐字保留（包括无 uuid 的 queue-operation）。
    assert.equal(entries.length, 8)
    assert.ok(result.content.endsWith('\n'))
  })

  it('leaves real assistant replies and non-synthetic lookalikes untouched', () => {
    const real = [
      line({ type: 'assistant', uuid: 'a1', parentUuid: null, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'No response requested.' }] } }),
      line({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500' }] } }),
    ].join('\n') + '\n'
    const result = stripSyntheticNoResponseEntries(real)
    assert.equal(result.removed, 0)
    assert.equal(result.content, real)
  })

  it('follows chains when consecutive synthetic replies exist', () => {
    const content = [
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } }),
      syntheticNoResponse('s1', 'u1'),
      syntheticNoResponse('s2', 's1'),
      line({ type: 'user', uuid: 'u2', parentUuid: 's2', message: { role: 'user', content: 'go' } }),
    ].join('\n')
    const result = stripSyntheticNoResponseEntries(content)
    assert.equal(result.removed, 2)
    const u2 = result.content.split('\n').map((raw) => JSON.parse(raw)).find((entry) => entry.uuid === 'u2')
    assert.equal(u2.parentUuid, 'u1')
  })

  it('keeps unparseable lines verbatim', () => {
    const content = interruptedTranscript() + '{"truncated":'
    const result = stripSyntheticNoResponseEntries(content)
    assert.equal(result.removed, 1)
    assert.ok(result.content.endsWith('{"truncated":'))
  })
})

// 取自 2026-09-26 rogue-td 会话 bcebd1f1 的真实形状：历史回复带 effort/perTurnEffort=max，
// 停止后存档尾巴是一条用户消息（工具结果后的「[Request interrupted by user]」）。
const effortAssistant = (uuid: string, parentUuid: string | null, content: unknown[], effort = 'max') =>
  line({
    type: 'assistant',
    uuid,
    parentUuid,
    isSidechain: false,
    effort,
    perTurnEffort: effort,
    message: { role: 'assistant', model: 'claude-opus-5-5', content },
  })

const danglingTailTranscript = () => [
  line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } }),
  effortAssistant('a1', 'u1', [{ type: 'text', text: 'on it' }]),
  effortAssistant('a2', 'a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
  line({ type: 'user', uuid: 'u2', parentUuid: 'a2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  line({ type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
  JSON.stringify({ type: 'last-prompt', sessionId }),
].join('\n') + '\n'

const parseEntries = (content: string) =>
  content.trim().split('\n').map((raw) => JSON.parse(raw) as Record<string, unknown>)

describe('stripTurnEffortsWhenTailDangles', () => {
  it('drops per-turn effort stamps when the transcript ends on a user message', () => {
    const result = stripTurnEffortsWhenTailDangles(danglingTailTranscript())
    assert.equal(result.stripped, 2)
    const entries = parseEntries(result.content)
    for (const entry of entries.filter((item) => item.type === 'assistant')) {
      assert.equal('effort' in entry, false)
      assert.equal('perTurnEffort' in entry, false)
      assert.ok(entry.message)
    }
    assert.equal(entries.length, 6)
    assert.ok(result.content.endsWith('\n'))
  })

  it('also treats an unanswered tool_use tail as dangling', () => {
    const content = danglingTailTranscript().split('\n').slice(0, 3).join('\n')
    assert.equal(stripTurnEffortsWhenTailDangles(content).stripped, 2)
  })

  it('keeps effort stamps when the transcript ends on a finished assistant reply', () => {
    const healthy = danglingTailTranscript().split('\n').slice(0, 2).join('\n') + '\n'
    const result = stripTurnEffortsWhenTailDangles(healthy)
    assert.equal(result.stripped, 0)
    assert.equal(result.content, healthy)
  })

  it('treats an API error reply as a finished tail and ignores sidechain entries', () => {
    const content = danglingTailTranscript() + [
      line({ type: 'assistant', uuid: 'x1', parentUuid: 'u3', isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 400' }] } }),
      line({ type: 'user', uuid: 'sc1', parentUuid: null, isSidechain: true, message: { role: 'user', content: 'sub' } }),
    ].join('\n') + '\n'
    assert.equal(stripTurnEffortsWhenTailDangles(content).stripped, 0)
  })

  it('does not depend on compact JSON spacing', () => {
    const spaced = parseEntries(danglingTailTranscript())
      .map((entry) => JSON.stringify(entry, null, 1).replaceAll('\n', ''))
      .join('\n') + '\n'
    assert.equal(stripTurnEffortsWhenTailDangles(spaced).stripped, 2)
  })
})

describe('repairClaudeSessionForResume', () => {
  it('repairs a dangling-tail transcript even without a synthetic reply', async () => {
    const filePath = path.join(tmpDir, 'dangling.jsonl')
    fs.writeFileSync(filePath, danglingTailTranscript(), 'utf8')
    assert.equal(await repairClaudeSessionForResume('dangling', () => filePath), 2)
    assert.equal(fs.readFileSync(filePath, 'utf8').includes('perTurnEffort'), false)
    assert.equal(await repairClaudeSessionForResume('dangling', () => filePath), 0)
  })

  it('strips effort stamps left dangling after removing the synthetic reply', async () => {
    const filePath = path.join(tmpDir, 'synthetic-dangling.jsonl')
    const content = danglingTailTranscript() + syntheticNoResponse('s1', 'u3') + '\n'
    fs.writeFileSync(filePath, content, 'utf8')
    assert.equal(await repairClaudeSessionForResume('synthetic-dangling', () => filePath), 3)
    const after = fs.readFileSync(filePath, 'utf8')
    assert.equal(after.includes('No response requested.'), false)
    assert.equal(after.includes('perTurnEffort'), false)
  })

  it('rewrites the on-disk transcript so the next --resume stops failing', async () => {
    const filePath = path.join(tmpDir, `${sessionId}.jsonl`)
    fs.writeFileSync(filePath, interruptedTranscript(), 'utf8')
    const removed = await repairClaudeSessionForResume(sessionId, () => filePath)
    assert.equal(removed, 1)
    assert.equal(fs.readFileSync(filePath, 'utf8').includes('No response requested.'), false)
    // 幂等：第二次没有可修的东西。
    assert.equal(await repairClaudeSessionForResume(sessionId, () => filePath), 0)
  })

  it('does not rewrite healthy transcripts', async () => {
    const filePath = path.join(tmpDir, 'healthy.jsonl')
    const healthy = line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } }) + '\n'
    fs.writeFileSync(filePath, healthy, 'utf8')
    const before = fs.statSync(filePath).mtimeMs
    assert.equal(await repairClaudeSessionForResume('healthy', () => filePath), 0)
    assert.equal(fs.statSync(filePath).mtimeMs, before)
  })

  it('fails open when the session file is missing', async () => {
    assert.equal(await repairClaudeSessionForResume('missing', () => null), 0)
    assert.equal(await repairClaudeSessionForResume('missing', () => path.join(tmpDir, 'nope.jsonl')), 0)
  })
})

describe('stripEmptyThinkingBlocks', () => {
  const withEmpty = [
    line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'ok' }] } }),
    line({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] } }),
    line({ type: 'assistant', uuid: 'a3', parentUuid: 'a2', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'real', signature: 'sig' }] } }),
  ].join('\n') + '\n'

  it('removes empty thinking blocks, keeps real ones, pads emptied messages', () => {
    const result = stripEmptyThinkingBlocks(withEmpty)
    assert.equal(result.removed, 2)
    const entries = result.content.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.deepEqual(entries[1].message.content, [{ type: 'text', text: 'ok' }])
    assert.deepEqual(entries[2].message.content, [{ type: 'text', text: '(thinking content unavailable)' }])
    assert.equal(entries[3].message.content[0].thinking, 'real')
    assert.equal(entries[3].parentUuid, 'a2')
  })

  it('is a no-op without empty blocks', () => {
    const clean = line({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'x' }] } })
    assert.deepEqual(stripEmptyThinkingBlocks(clean), { content: clean, removed: 0 })
  })

  it('repairClaudeSessionForResume fixes it on disk', async () => {
    const file = path.join(tmpDir, 'empty-thinking.jsonl')
    fs.writeFileSync(file, withEmpty)
    const n = await repairClaudeSessionForResume('x', () => file)
    assert.equal(n, 2)
    assert.ok(!fs.readFileSync(file, 'utf8').includes('"thinking":""'))
  })
})
