import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatRequest } from '../shared/schema.ts'
import {
  createClaudeTurnParser,
  isBareClaudeToolCallMarkerText,
  stripTrailingClaudeTypedToolMarkerLines,
} from '../server/providers.ts'
import { stripPersistedClaudeProtocolResidueLines } from '../server/state-store.ts'
import { createClaudeAskUserDeltaStripper } from '../server/claude-structured-output.ts'

test('isBareClaudeToolCallMarkerText treats the known marker family as bare markers', () => {
  assert.equal(isBareClaudeToolCallMarkerText('call'), true)
  assert.equal(isBareClaudeToolCallMarkerText('call:'), true)
  assert.equal(isBareClaudeToolCallMarkerText('court'), true)
  assert.equal(isBareClaudeToolCallMarkerText('card'), true)
  assert.equal(isBareClaudeToolCallMarkerText('count'), true)
  assert.equal(isBareClaudeToolCallMarkerText('course'), true)
  assert.equal(isBareClaudeToolCallMarkerText('课'), true)
  assert.equal(isBareClaudeToolCallMarkerText('call:\ncourt'), true)
})

test('isBareClaudeToolCallMarkerText treats novel lone short words as residue too', () => {
  // Leaked marker words keep mutating; a text that is nothing but 1-2 bare
  // short words beside real tool activity is never meaningful prose.
  assert.equal(isBareClaudeToolCallMarkerText('cart'), true)
  assert.equal(isBareClaudeToolCallMarkerText('cold\n'), true)
  assert.equal(isBareClaudeToolCallMarkerText('卡'), true)
})

test('isBareClaudeToolCallMarkerText keeps real assistant prose', () => {
  assert.equal(isBareClaudeToolCallMarkerText('The card is ready.'), false)
  assert.equal(isBareClaudeToolCallMarkerText('整体高度一致，色调略微偏移。'), false)
  // 3+ bare word lines look like a deliberate list, not a leaked marker.
  assert.equal(isBareClaudeToolCallMarkerText('one\ntwo\nthree'), false)
  assert.equal(isBareClaudeToolCallMarkerText('done and dusted'), false)
})

test('stripTrailingClaudeTypedToolMarkerLines strips the extended marker family', () => {
  assert.equal(stripTrailingClaudeTypedToolMarkerLines('正文说明。\ncard'), '正文说明。')
  assert.equal(stripTrailingClaudeTypedToolMarkerLines('正文说明。\ncourse\ncount'), '正文说明。')
  assert.equal(stripTrailingClaudeTypedToolMarkerLines('正文说明。\ncall:\n课'), '正文说明。')
})

test('stripTrailingClaudeTypedToolMarkerLines leaves unknown trailing words alone', () => {
  // Blanket trailing removal has no sandwich context, so novel words are only
  // handled by the whole-text bare-marker check and the renderer fallback.
  assert.equal(
    stripTrailingClaudeTypedToolMarkerLines('正文说明。\nfinished'),
    '正文说明。\nfinished',
  )
})

test('stripPersistedClaudeProtocolResidueLines strips trailing card residue at save time', () => {
  assert.equal(stripPersistedClaudeProtocolResidueLines('正文说明。\n\ncard\n'), '正文说明。')
  assert.equal(stripPersistedClaudeProtocolResidueLines('正文说明。\n\ncourse\n'), '正文说明。')
  assert.equal(stripPersistedClaudeProtocolResidueLines('正文说明。\n\ncount\n'), '正文说明。')
})

test('stripPersistedClaudeProtocolResidueLines keeps normal prose endings', () => {
  assert.equal(
    stripPersistedClaudeProtocolResidueLines('修复完成，测试全绿。'),
    '修复完成，测试全绿。',
  )
})

test('delta stripper drops a stray card marker line attached to a typed tool-call block', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const released =
    stripper.push(
      '前置说明。\ncard\n<invoke name="Edit">\n<parameter name="file_path">a.ts</parameter>\n</invoke>',
    ) + stripper.flush()

  assert.equal(released.trim(), '前置说明。')
})

test('delta stripper drops a novel stray marker word attached to a typed tool-call block', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const released =
    stripper.push(
      '前置说明。\ncart\n<invoke name="Edit">\n<parameter name="file_path">a.ts</parameter>\n</invoke>',
    ) + stripper.flush()

  assert.equal(released.trim(), '前置说明。')
})

// --- Gateway-mangled tool-call XML: the bad proxy node can eat the leading `<`
// (and expose the antml namespace), leaving `antml:invoke name="...">` with a
// normal or mangled (`</invoke">`) close. Observed live on jp.duckcoding.com.

test('delta stripper strips a mangled antml:invoke block with a normal close', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const released =
    stripper.push('card\n\nantml:invoke name="Read">\n\n</invoke>card') + stripper.flush()

  assert.ok(!/invoke/i.test(released), 'no invoke fragment may survive')
  assert.ok(!/antml/i.test(released), 'no antml fragment may survive')
  assert.ok(stripper.consumedToolCallBlockCount() > 0, 'counts as a consumed tool-call block')
})

test('delta stripper drops a mangled antml:invoke block whose close tag is also mangled', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const released =
    stripper.push('antml:invoke name="Edit">\n\n\n\n</invoke">') + stripper.flush()

  assert.equal(released.trim(), '')
})

test('delta stripper keeps prose that merely mentions antml:invoke', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const released =
    stripper.push('antml:invoke 这个词是坏节点泄漏出来的协议标记，不是正常输出。') + stripper.flush()

  assert.equal(released, 'antml:invoke 这个词是坏节点泄漏出来的协议标记，不是正常输出。')
})

// --- Claude turn fold: trailing residue on prose that shares an assistant
// event with a native tool_use block (the dominant leak shape observed in the
// wild: "让我近距离看招牌区:\n\ncard" immediately followed by a command card).

const baseTurnRequest: ChatRequest = {
  provider: 'claude',
  workspacePath: '.',
  model: '',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
  prompt: 'hi',
  attachments: [],
}

const createTurnRecorder = () => {
  const record = { deltas: [] as string[], errors: [] as string[], done: false }
  return {
    record,
    sink: {
      onSession: () => {},
      onDelta: (content: string) => record.deltas.push(content),
      onLog: () => {},
      onAssistantMessage: () => {},
      onActivity: () => {},
      onDone: () => {
        record.done = true
      },
      onError: (message: string) => {
        record.errors.push(message)
      },
    },
  }
}

const assistantEventLine = (blocks: unknown[]) =>
  JSON.stringify({ type: 'assistant', message: { content: blocks } })

const makeTurnParser = (sink: ReturnType<typeof createTurnRecorder>['sink']) =>
  createClaudeTurnParser({
    request: baseTurnRequest,
    sink,
    language: 'zh-CN',
    killChild: () => {},
    onSettled: () => {},
  })

test('turn fold strips trailing card residue from prose sharing an event with a tool_use', () => {
  const { record, sink } = createTurnRecorder()
  const parser = makeTurnParser(sink)

  parser.handleLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }))
  parser.handleLine(
    assistantEventLine([
      { type: 'text', text: '让我近距离看招牌区:\n\ncard' },
      {
        type: 'tool_use',
        id: 'toolu_shot',
        name: 'Bash',
        input: { command: 'node shot.mjs iso_signs.png 5000' },
      },
    ]),
  )

  const streamed = record.deltas.join('')
  assert.ok(streamed.includes('让我近距离看招牌区'), 'prose must stay visible')
  assert.ok(!/(^|\n)\s*card\s*(\n|$)/.test(streamed), 'trailing card residue must not stream out')
})

test('turn fold keeps a prose reply that merely ends with the word card when no tool runs', () => {
  const { record, sink } = createTurnRecorder()
  const parser = makeTurnParser(sink)

  parser.handleLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }))
  parser.handleLine(
    assistantEventLine([{ type: 'text', text: '这个组件的名字叫\ncard' }]),
  )

  const streamed = record.deltas.join('')
  assert.ok(streamed.includes('card'), 'a text-only reply must keep its trailing word')
})
