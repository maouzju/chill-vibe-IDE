import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage, StreamEditedFile } from '../shared/schema.ts'
import {
  buildRenderableMessages,
  collectChangesSummaryFilesForStream,
  getAskUserAnswerKey,
  getRestoredStickyUserAnchor,
  getRenderableEntryStructureKey,
  getStickyRenderableUserMessageId,
  getLastRenderableUserMessageId,
  getTopVisibleRenderableEntryId,
  parseStructuredAskUserMessage,
  parseStructuredReasoningMessage,
  parseStructuredTodoMessage,
} from '../src/components/chat-card-parsing.ts'

test('renderable entry structure key ignores streaming content-only updates', () => {
  const initial = buildRenderableMessages([
    makeMessage({ id: 'user-1', role: 'user', content: 'Start.' }),
    makeMessage({ id: 'assistant-1', content: 'partial' }),
  ])
  const updated = buildRenderableMessages([
    makeMessage({ id: 'user-1', role: 'user', content: 'Start.' }),
    makeMessage({ id: 'assistant-1', content: 'partial plus more streamed text' }),
  ])
  const appended = buildRenderableMessages([
    makeMessage({ id: 'user-1', role: 'user', content: 'Start.' }),
    makeMessage({ id: 'assistant-1', content: 'done' }),
    makeMessage({ id: 'assistant-2', content: 'next item' }),
  ])

  assert.equal(getRenderableEntryStructureKey(initial), getRenderableEntryStructureKey(updated))
  assert.notEqual(getRenderableEntryStructureKey(initial), getRenderableEntryStructureKey(appended))
})

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `msg-${Math.random().toString(36).slice(2, 8)}`,
  role: 'assistant',
  content: '',
  createdAt: new Date().toISOString(),
  ...overrides,
})

const makeToolMessage = (toolName: string, summary: string): ChatMessage =>
  makeMessage({
    content: '',
    meta: {
      provider: 'claude',
      kind: 'tool',
      itemId: `item-${Math.random().toString(36).slice(2, 8)}`,
      structuredData: JSON.stringify({
        itemId: `item-${toolName}`,
        kind: 'tool',
        status: 'completed',
        toolName,
        summary,
      }),
    },
  })

const makeEditsMessage = (
  streamId: string,
  files: Array<{
    path: string
    addedLines: number
    removedLines: number
    patchOmittedReason?: StreamEditedFile['patchOmittedReason']
  }>,
): ChatMessage =>
  makeMessage({
    id: `claude:${streamId}:item:edits-${Math.random().toString(36).slice(2, 8)}`,
    content: '',
    meta: {
      provider: 'claude',
      kind: 'edits',
      itemId: `item-${Math.random().toString(36).slice(2, 8)}`,
      structuredData: JSON.stringify({
        itemId: `item-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'edits',
        status: 'completed',
        files: files.map((file) => ({
          path: file.path,
          kind: 'modified',
          addedLines: file.addedLines,
          removedLines: file.removedLines,
          patch: '@@',
          ...(file.patchOmittedReason ? { patchOmittedReason: file.patchOmittedReason } : {}),
        })),
      }),
    },
  })

test('buildRenderableMessages groups consecutive tool messages', () => {
  const messages = [
    makeToolMessage('Read', 'Read file.ts'),
    makeToolMessage('Grep', 'Search text: foo'),
  ]

  const result = buildRenderableMessages(messages)

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'tool-group')
  if (result[0]!.type === 'tool-group') {
    assert.equal(result[0]!.items.length, 2)
  }
})

test('buildRenderableMessages skips empty structured messages that fail to parse', () => {
  // A message with meta.kind='tool' but missing/invalid structuredData
  // and empty content — this should NOT appear as a visible message
  const brokenToolMessage = makeMessage({
    content: '',
    meta: {
      provider: 'claude',
      kind: 'tool',
      itemId: 'item-broken',
      // structuredData is missing entirely
    },
  })

  const brokenToolMessageNoSummary = makeMessage({
    content: '',
    meta: {
      provider: 'claude',
      kind: 'tool',
      itemId: 'item-broken-2',
      structuredData: JSON.stringify({
        itemId: 'item-broken-2',
        kind: 'tool',
        status: 'completed',
        toolName: 'Agent',
        // summary is missing
      }),
    },
  })

  const validTool = makeToolMessage('Read', 'Read file.ts')
  const textMessage = makeMessage({ content: 'Hello world' })

  const messages = [
    validTool,
    brokenToolMessage,
    brokenToolMessageNoSummary,
    textMessage,
  ]

  const result = buildRenderableMessages(messages)

  // The broken tool messages should be skipped entirely.
  // We expect: one tool-group (containing the valid tool), then one text message.
  const types = result.map((r) => r.type)
  assert.deepEqual(types, ['tool-group', 'message'])

  // The text message should be the "Hello world" one
  if (result[1]!.type === 'message') {
    assert.equal(result[1]!.message.content, 'Hello world')
  }
})

test('buildRenderableMessages skips broken tool messages between valid tool groups', () => {
  const tool1 = makeToolMessage('Read', 'Read a.ts')
  const broken = makeMessage({
    content: '',
    meta: {
      provider: 'claude',
      kind: 'tool',
      itemId: 'item-broken',
    },
  })
  const tool2 = makeToolMessage('Grep', 'Search: bar')

  const messages = [tool1, broken, tool2]

  const result = buildRenderableMessages(messages)

  // Broken message should be skipped; the two valid tools merge into one group.
  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'tool-group')
  if (result[0]!.type === 'tool-group') {
    assert.equal(result[0]!.items.length, 2)
  }
})


test('buildRenderableMessages skips standalone leaked Claude call marker messages', () => {
  const before = makeMessage({ id: 'before-call', content: 'Before the leaked marker.' })
  const leaked = makeMessage({
    id: 'leaked-call',
    content: 'call',
    meta: { provider: 'claude' },
  })
  const after = makeMessage({ id: 'after-call', content: 'After the leaked marker.' })

  const result = buildRenderableMessages([before, leaked, after])

  assert.equal(result.length, 2)
  assert.deepEqual(
    result.flatMap((entry) => (entry.type === 'message' ? [entry.message.id] : [])),
    ['before-call', 'after-call'],
  )
})


test('buildRenderableMessages removes leaked call marker lines even when provider is not Claude', () => {
  const leaked = makeMessage({
    id: 'leaked-codex-call-lines',
    content: 'First line.\n\ncall\nSecond line.\n\ncall',
    meta: { provider: 'codex' },
  })

  const result = buildRenderableMessages([leaked])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.content, 'First line.\n\nSecond line.')
  }
})


test('parseStructuredReasoningMessage removes leaked call marker lines from reasoning text', () => {
  const reasoning = makeMessage({
    id: 'reasoning-call-lines',
    content: '',
    meta: {
      kind: 'reasoning',
      provider: 'claude',
      structuredData: JSON.stringify({
        itemId: 'reasoning-1',
        text: 'First thought.\n\ncall\nSecond thought.\ncall',
      }),
    },
  })

  const parsed = parseStructuredReasoningMessage(reasoning)

  assert.ok(parsed)
  assert.equal(parsed.text, 'First thought.\n\nSecond thought.')
})



test('buildRenderableMessages hides Claude typed-tool retry chatter between tool activities', () => {
  const chatter = makeMessage({
    id: 'typed-tool-retry-chatter',
    content: 'call\nEdit 工具反复解析失败,改用 Write 整文件重写。',
    meta: { provider: 'claude' },
  })
  const messages = [
    makeToolMessage('Read', '读取 character-row-20284.json'),
    chatter,
    makeEditsMessage('stream-1', [
      {
        path: 'fixtures/catalog/characters/character-row-20284.json',
        addedLines: 25,
        removedLines: 0,
      },
    ]),
  ]

  const result = buildRenderableMessages(messages)

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'tool-group')
  if (result[0]!.type === 'tool-group') {
    assert.equal(result[0]!.items.length, 2)
    assert.deepEqual(
      result[0]!.items.map((item) => item.kind),
      ['tool', 'edits'],
    )
  }
})

test('buildRenderableMessages hides Claude typed-tool recovery fragments before recovered edit activity', () => {
  const messages = [
    makeToolMessage('Grep', '搜索文本: plan-excute'),
    makeMessage({
      id: 'typed-tool-fragment-summary',
      content:
        '共 4 处：3 个文件的 frontmatter description（第 3 行）+ canonical 正文第 31 行。全部去掉 ` / plan-excute`。\n\ncourse\n课',
      meta: { provider: 'claude' },
    }),
    makeMessage({
      id: 'typed-tool-fragment-apology',
      content: '抱歉，我的',
      meta: { provider: 'claude' },
    }),
    makeMessage({
      id: 'typed-tool-fragment-invoke',
      content: 'course\n\n\n\n我一直在用错误的裸 `<invoke>` 文本格式。必',
      meta: { provider: 'claude' },
    }),
    makeEditsMessage('stream-typed-tool-recovery', [
      {
        path: 'Docs/AI/skills/plan-execute/SKILL.md',
        addedLines: 1,
        removedLines: 1,
      },
    ]),
  ]

  const result = buildRenderableMessages(messages)

  assert.equal(result.length, 3)
  assert.equal(result[0]!.type, 'tool-group')
  assert.equal(result[1]!.type, 'message')
  assert.equal(result[2]!.type, 'tool-group')

  if (result[1]!.type === 'message') {
    assert.equal(result[1]!.message.id, 'typed-tool-fragment-summary')
    assert.equal(
      result[1]!.message.content,
      '共 4 处：3 个文件的 frontmatter description（第 3 行）+ canonical 正文第 31 行。全部去掉 ` / plan-excute`。',
    )
  }

  const renderedText = result
    .flatMap((entry) => (entry.type === 'message' ? [entry.message.content] : []))
    .join('\n')
  assert.doesNotMatch(renderedText, /course|课|错误的裸|invoke/i)
})

test('buildRenderableMessages removes leaked Claude call marker lines from assistant text', () => {
  const leaked = makeMessage({
    id: 'leaked-call-lines',
    content: 'call\nEdit failed, retrying with PowerShell.\n\ncall\nNow checking the file.',
    meta: { provider: 'claude' },
  })

  const result = buildRenderableMessages([leaked])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.id, 'leaked-call-lines')
    assert.equal(result[0]!.message.content, 'Edit failed, retrying with PowerShell.\n\nNow checking the file.')
  }
})

test('buildRenderableMessages removes standalone empty markdown bullet residue from assistant text', () => {
  const leaked = makeMessage({
    id: 'empty-bullet-residue',
    content:
      '-\n\n**Blocked work**: visual review started, but the tool channel failed.\n\nSuggestion\n\nRestart the session.',
    meta: { provider: 'claude' },
  })

  const result = buildRenderableMessages([leaked])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type === 'message') {
    assert.equal(
      result[0]!.message.content,
      '**Blocked work**: visual review started, but the tool channel failed.\n\nSuggestion\n\nRestart the session.',
    )
  }
})

test('buildRenderableMessages keeps real markdown lists while removing only empty bullet residue', () => {
  const message = makeMessage({
    id: 'real-list-with-empty-residue',
    content: '-\n\n- first item\n- second item\n\nKeep inline - dash.',
    meta: { provider: 'claude' },
  })

  const result = buildRenderableMessages([message])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.content, '- first item\n- second item\n\nKeep inline - dash.')
  }
})

test('buildRenderableMessages keeps standalone dash inside fenced code blocks', () => {
  const message = makeMessage({
    id: 'code-block-dash',
    content: 'Example:\n\n```txt\n-\n```\n\nDone.',
    meta: { provider: 'claude' },
  })

  const result = buildRenderableMessages([message])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.content, message.content)
  }
})

test('buildRenderableMessages hides a trailing empty Codex markdown fence', () => {
  const message = makeMessage({
    id: 'codex-empty-trailing-fence',
    content: '### Recommended structure\n\n```json\n',
    meta: { provider: 'codex' },
  })

  const result = buildRenderableMessages([message])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.content, '### Recommended structure')
  }
})

test('buildRenderableMessages keeps populated and completed Codex markdown fences', () => {
  const populated = makeMessage({
    id: 'codex-populated-fence',
    content: '### Recommended structure\n\n```json\n{ "version": 1 }',
    meta: { provider: 'codex' },
  })
  const completed = makeMessage({
    id: 'codex-completed-fence',
    content: '```json\n{ "version": 1 }\n```',
    meta: { provider: 'codex' },
  })

  const result = buildRenderableMessages([populated, completed])

  assert.equal(result.length, 2)
  assert.equal(result[0]!.type, 'message')
  assert.equal(result[1]!.type, 'message')
  if (result[0]!.type === 'message' && result[1]!.type === 'message') {
    assert.equal(result[0]!.message.content, populated.content)
    assert.equal(result[1]!.message.content, completed.content)
  }
})

test('buildRenderableMessages removes trailing Claude count residue near tool activity', () => {
  const beforeTool = makeToolMessage('Grep', '搜索文本: targetRule')
  const leaked = makeMessage({
    id: 'leaked-count-line',
    content:
      '我需要看用那个带 `targetRule`/`targetCount` 模板的卡，以及运行时 taggedAllies 后续的 targetRule 处理逻辑。\n\ncount\n',
    meta: { provider: 'claude' },
  })
  const afterTool = makeToolMessage('Read', '读取 binding.json')

  const result = buildRenderableMessages([beforeTool, leaked, afterTool])

  assert.equal(result.length, 3)
  assert.equal(result[1]!.type, 'message')
  if (result[1]!.type === 'message') {
    assert.equal(
      result[1]!.message.content,
      '我需要看用那个带 `targetRule`/`targetCount` 模板的卡，以及运行时 taggedAllies 后续的 targetRule 处理逻辑。',
    )
  }
})

test('buildRenderableMessages removes standalone count residue between Claude tool groups without provider meta', () => {
  const beforeTool = makeToolMessage('Grep', 'Search text: output_mode')
  const leaked = makeMessage({
    id: 'standalone-count-residue',
    content: 'count',
  })
  const afterTool = makeToolMessage('Read', 'Read results.json')

  const result = buildRenderableMessages([beforeTool, leaked, afterTool])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'tool-group')
  if (result[0]!.type === 'tool-group') {
    assert.equal(result[0]!.items.length, 2)
  }
})

test('buildRenderableMessages removes standalone count residue even when provider meta is missing and a user reply follows', () => {
  const assistantText = makeMessage({
    id: 'assistant-before-count',
    content: '逻辑严密。现在读回 sidecar 文件本体确认 JSON 结构正确，并生成进度报告。',
    meta: { provider: 'claude' },
  })
  const leaked = makeMessage({
    id: 'standalone-count-residue-before-user',
    content: 'count',
  })
  const userReply = makeMessage({
    id: 'user-reply-after-count',
    role: 'user',
    content: '我',
  })

  const result = buildRenderableMessages([assistantText, leaked, userReply])

  assert.deepEqual(
    result.flatMap((entry) => (entry.type === 'message' ? [entry.message.id] : [])),
    ['assistant-before-count', 'user-reply-after-count'],
  )
})

test('buildRenderableMessages keeps normal Claude prose that mentions count inline', () => {
  const message = makeMessage({
    id: 'normal-count-prose',
    content: 'The count value should remain visible when it is part of a sentence.',
    meta: { provider: 'claude' },
  })

  const result = buildRenderableMessages([message])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.content, message.content)
  }
})

test('buildRenderableMessages removes standalone card residue between Claude tool activity', () => {
  const beforeTool = makeToolMessage('Bash', '执行了 1 条命令')
  const leaked = makeMessage({
    id: 'standalone-card-residue',
    content: 'card',
    meta: { provider: 'claude' },
  })
  const afterTool = makeToolMessage('Read', 'Read grade-pass.ts')

  const result = buildRenderableMessages([beforeTool, leaked, afterTool])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'tool-group')
  if (result[0]!.type === 'tool-group') {
    assert.equal(result[0]!.items.length, 2)
  }
})

test('buildRenderableMessages removes unknown single-word residue sandwiched between Claude tool activity', () => {
  const beforeTool = makeToolMessage('Bash', '执行了 1 条命令')
  const leaked = makeMessage({
    id: 'unknown-word-residue',
    content: 'cart',
  })
  const afterEdits = makeEditsMessage('stream-residue', [
    { path: 'src/grade.ts', addedLines: 3, removedLines: 1 },
  ])

  const result = buildRenderableMessages([beforeTool, leaked, afterEdits])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'tool-group')
  if (result[0]!.type === 'tool-group') {
    assert.equal(result[0]!.items.length, 2)
  }
})

test('buildRenderableMessages strips trailing card residue attached to Claude prose near tool activity', () => {
  const beforeTool = makeToolMessage('Bash', '执行了 1 条命令')
  const leaked = makeMessage({
    id: 'trailing-card-line',
    content: '整体高度一致，色调略微偏移，需要压一压中间调。\n\ncard\n',
    meta: { provider: 'claude' },
  })
  const afterTool = makeToolMessage('Read', 'Read grade-pass.ts')

  const result = buildRenderableMessages([beforeTool, leaked, afterTool])

  assert.equal(result.length, 3)
  assert.equal(result[1]!.type, 'message')
  if (result[1]!.type === 'message') {
    assert.equal(result[1]!.message.content, '整体高度一致，色调略微偏移，需要压一压中间调。')
  }
})

test('buildRenderableMessages keeps a short final assistant word that only follows tool activity', () => {
  const beforeTool = makeToolMessage('Bash', '执行了 1 条命令')
  const finalWord = makeMessage({
    id: 'final-short-word',
    content: 'Done',
    meta: { provider: 'claude' },
  })

  const result = buildRenderableMessages([beforeTool, finalWord])

  assert.deepEqual(
    result.flatMap((entry) => (entry.type === 'message' ? [entry.message.id] : [])),
    ['final-short-word'],
  )
})

test('buildRenderableMessages keeps normal Claude prose that mentions card inline', () => {
  const message = makeMessage({
    id: 'normal-card-prose',
    content: 'The card component should stay visible when card is part of a sentence.',
    meta: { provider: 'claude' },
  })

  const result = buildRenderableMessages([message])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.content, message.content)
  }
})

test('buildRenderableMessages hides gateway-mangled antml:invoke residue between tool activity', () => {
  // Exact shapes captured from live state.json (jp gateway eats the leading `<`).
  const shapes = [
    'card\n\nantml:invoke name="Edit">\n\n\n\n\n</invoke>card',
    'card\n\nantml:invoke name="Read">\n\n</invoke>card',
    'card\n\nantml:invoke name="Read">\n\n\n\n</invoke">',
    'cardcard',
  ]

  for (const content of shapes) {
    const beforeTool = makeToolMessage('Bash', '执行了 1 条命令')
    const leaked = makeMessage({ id: `mangled-${shapes.indexOf(content)}`, content, meta: { provider: 'claude' } })
    const afterTool = makeToolMessage('Read', 'Read outline.js')

    const result = buildRenderableMessages([beforeTool, leaked, afterTool])

    assert.equal(result.length, 1, `shape must be hidden: ${JSON.stringify(content.slice(0, 40))}`)
    assert.equal(result[0]!.type, 'tool-group')
  }
})

test('buildRenderableMessages strips mangled antml:invoke residue but keeps surrounding prose', () => {
  const beforeTool = makeToolMessage('Bash', '执行了 1 条命令')
  const leaked = makeMessage({
    id: 'mangled-with-prose',
    content: '现在整体结构对了,我把当前版和原图并排看差距:\n\nantml:invoke name="Bash">\n\n</invoke">',
    meta: { provider: 'claude' },
  })
  const afterTool = makeToolMessage('Read', 'Read outline.js')

  const result = buildRenderableMessages([beforeTool, leaked, afterTool])

  assert.equal(result.length, 3)
  assert.equal(result[1]!.type, 'message')
  if (result[1]!.type === 'message') {
    assert.equal(result[1]!.message.content, '现在整体结构对了,我把当前版和原图并排看差距:')
  }
})

test('buildRenderableMessages strips repeated marker words attached to Claude prose near tool activity', () => {
  const beforeTool = makeToolMessage('Bash', '执行了 1 条命令')
  const leaked = makeMessage({
    id: 'trailing-doubled-card',
    content: '截图已生成，先检查一下渲染结果。\n\ncardcard\n',
    meta: { provider: 'claude' },
  })
  const afterTool = makeToolMessage('Read', 'Read shot.png')

  const result = buildRenderableMessages([beforeTool, leaked, afterTool])

  assert.equal(result.length, 3)
  assert.equal(result[1]!.type, 'message')
  if (result[1]!.type === 'message') {
    assert.equal(result[1]!.message.content, '截图已生成，先检查一下渲染结果。')
  }
})

test('buildRenderableMessages keeps prose that mentions antml:invoke in backticks', () => {
  const message = makeMessage({
    id: 'antml-prose-mention',
    content: '坏节点会把 `antml:invoke` 这样的协议标记泄漏成正文。',
    meta: { provider: 'claude' },
  })

  const result = buildRenderableMessages([message])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.content, message.content)
  }
})

test('buildRenderableMessages keeps card lines inside fenced code blocks near tool activity', () => {
  const beforeTool = makeToolMessage('Bash', '执行了 1 条命令')
  const withCodeBlock = makeMessage({
    id: 'code-block-card-line',
    content: '组件清单：\n\n```txt\ncard\ncourt\n```\n\ncard\n',
    meta: { provider: 'claude' },
  })
  const afterTool = makeToolMessage('Read', 'Read components.md')

  const result = buildRenderableMessages([beforeTool, withCodeBlock, afterTool])

  assert.equal(result.length, 3)
  assert.equal(result[1]!.type, 'message')
  if (result[1]!.type === 'message') {
    assert.equal(result[1]!.message.content, '组件清单：\n\n```txt\ncard\ncourt\n```')
  }
})

test('buildRenderableMessages skips empty assistant messages (streaming artifacts)', () => {
  const textBefore = makeMessage({ content: 'Before tools' })
  const emptyAssistant1 = makeMessage({ content: '' })
  const emptyAssistant2 = makeMessage({ content: '   ' })
  const emptyAssistantWithProvider = makeMessage({
    content: '',
    meta: { provider: 'claude' },
  })
  const textAfter = makeMessage({ content: 'After tools' })

  const messages = [textBefore, emptyAssistant1, emptyAssistant2, emptyAssistantWithProvider, textAfter]

  const result = buildRenderableMessages(messages)

  // All empty assistant messages should be skipped
  assert.equal(result.length, 2)
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.content, 'Before tools')
  }
  if (result[1]!.type === 'message') {
    assert.equal(result[1]!.message.content, 'After tools')
  }
})

test('buildRenderableMessages keeps user messages even if empty', () => {
  const emptyUser = makeMessage({ role: 'user', content: '' })
  const result = buildRenderableMessages([emptyUser])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
})

test('buildRenderableMessages skips hidden auto-compact boundary messages', () => {
  const hiddenAutoCompactBoundary = makeMessage({
    role: 'user',
    content: '/compact',
    meta: {
      provider: 'codex',
      compactBoundary: 'true',
      compactTrigger: 'auto',
      compactHidden: 'true',
    },
  })
  const compactedSummary = makeMessage({
    role: 'assistant',
    content: 'Compacted summary remains visible.',
  })

  const result = buildRenderableMessages([hiddenAutoCompactBoundary, compactedSummary])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.content, 'Compacted summary remains visible.')
  }
})

test('getLastRenderableUserMessageId returns the last visible user message id', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Earlier reply' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'First visible prompt' }),
    makeToolMessage('Read', 'Read src/App.tsx'),
    makeMessage({ id: 'assistant-2', role: 'assistant', content: 'Latest reply body' }),
    makeMessage({ id: 'user-2', role: 'user', content: 'Keep this prompt pinned' }),
    makeToolMessage('Edit', 'Update the layout'),
  ])

  assert.equal(getLastRenderableUserMessageId(result), 'user-2')
})

test('getLastRenderableUserMessageId returns null when no user message is visible', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Only assistant text' }),
    makeToolMessage('Read', 'Read src/state.ts'),
  ])

  assert.equal(getLastRenderableUserMessageId(result), null)
})

test('getStickyRenderableUserMessageId waits until a reply takes over before pinning that user prompt', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Intro reply before any user prompt' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'First prompt' }),
    makeToolMessage('Read', 'Read src/App.tsx'),
    makeMessage({ id: 'assistant-2', role: 'assistant', content: 'Reply to the first prompt' }),
    makeMessage({ id: 'user-2', role: 'user', content: 'Second prompt' }),
    makeMessage({ id: 'assistant-3', role: 'assistant', content: 'Reply to the second prompt' }),
  ])

  assert.equal(getStickyRenderableUserMessageId(result, 'assistant-1'), null)
  assert.equal(getStickyRenderableUserMessageId(result, 'user-1'), null)
  assert.equal(getStickyRenderableUserMessageId(result, 'assistant-2'), 'user-1')
  assert.equal(getStickyRenderableUserMessageId(result, 'user-2'), null)
  assert.equal(getStickyRenderableUserMessageId(result, 'assistant-3'), 'user-2')
})

test('getStickyRenderableUserMessageId hides a latest user prompt that has no following renderable reply yet', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Earlier reply before the latest prompt' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'Earlier prompt with a reply' }),
    makeMessage({ id: 'assistant-2', role: 'assistant', content: 'Reply to the earlier prompt' }),
    makeMessage({ id: 'user-2', role: 'user', content: 'Latest prompt still waiting for any reply' }),
  ])

  assert.equal(getStickyRenderableUserMessageId(result, 'user-2'), null)
})

test('getRestoredStickyUserAnchor points restored chats at the reply right after the last visible user prompt', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Intro reply before any user prompt' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'First prompt' }),
    makeToolMessage('Read', 'Read src/App.tsx'),
    makeMessage({ id: 'assistant-2', role: 'assistant', content: 'Reply to the first prompt' }),
    makeMessage({ id: 'user-2', role: 'user', content: 'Keep this prompt pinned after restore' }),
    makeMessage({ id: 'assistant-3', role: 'assistant', content: 'Short latest reply' }),
  ])

  assert.deepEqual(getRestoredStickyUserAnchor(result), {
    stickyMessageId: 'user-2',
    anchorEntryId: 'assistant-3',
  })
})

test('getRestoredStickyUserAnchor returns null when the latest visible user prompt has no following content', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Intro reply before any user prompt' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'Most recent prompt without a reply yet' }),
  ])

  assert.equal(getRestoredStickyUserAnchor(result), null)
})

test('getTopVisibleRenderableEntryId keeps a visible user message as the active boundary before the next reply takes over', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Intro reply before any user prompt' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'First prompt' }),
    makeMessage({ id: 'assistant-2', role: 'assistant', content: 'Reply to the first prompt' }),
    makeMessage({ id: 'user-2', role: 'user', content: 'Second prompt with a tall attachment preview' }),
    makeMessage({ id: 'assistant-3', role: 'assistant', content: 'Reply to the second prompt' }),
  ])

  const visibleEntries = new Set(['user-2', 'assistant-3'])
  assert.equal(getTopVisibleRenderableEntryId(result, (entryId) => visibleEntries.has(entryId)), 'user-2')
})

test('collectChangesSummaryFilesForStream only includes edits from the active stream', () => {
  const previousRunEdit = makeEditsMessage('stream-1', [
    { path: 'src/old.ts', addedLines: 5, removedLines: 1 },
  ])
  const currentRunEditA = makeEditsMessage('stream-2', [
    { path: 'src/current.ts', addedLines: 2, removedLines: 3 },
  ])
  const currentRunEditB = makeEditsMessage('stream-2', [
    { path: 'src/current.ts', addedLines: 1, removedLines: 0 },
    { path: 'src/other.ts', addedLines: 4, removedLines: 2 },
  ])

  const result = collectChangesSummaryFilesForStream(
    [previousRunEdit, currentRunEditA, currentRunEditB],
    'claude',
    'stream-2',
  )

  assert.deepEqual(result, [
    { path: 'src/current.ts', addedLines: 3, removedLines: 3 },
    { path: 'src/other.ts', addedLines: 4, removedLines: 2 },
  ])
})

test('collectChangesSummaryFilesForStream preserves omitted-detail state for filename-only edits', () => {
  const result = collectChangesSummaryFilesForStream(
    [
      makeEditsMessage('stream-omitted', [
        {
          path: 'artifacts/large-output.bin',
          addedLines: 0,
          removedLines: 0,
          patchOmittedReason: 'file-too-large',
        },
      ]),
    ],
    'claude',
    'stream-omitted',
  )

  assert.deepEqual(result, [
    {
      path: 'artifacts/large-output.bin',
      addedLines: 0,
      removedLines: 0,
      patchOmittedReason: 'file-too-large',
    },
  ])
})

test('parseStructuredTodoMessage reads structured todo list messages', () => {
  const message = makeMessage({
    meta: {
      provider: 'claude',
      kind: 'todo',
      itemId: 'toolu_todo',
      structuredData: JSON.stringify({
        itemId: 'toolu_todo',
        kind: 'todo',
        status: 'completed',
        items: [
          {
            id: 'todo-1',
            content: 'Inspect the current card pipeline',
            status: 'completed',
          },
          {
            id: 'todo-2',
            content: 'Render the live task list',
            activeForm: 'Rendering the live task list',
            status: 'in_progress',
            priority: 'high',
          },
        ],
      }),
    },
  })

  assert.deepEqual(parseStructuredTodoMessage(message), {
    itemId: 'toolu_todo',
    status: 'completed',
    items: [
      {
        id: 'todo-1',
        content: 'Inspect the current card pipeline',
        status: 'completed',
      },
      {
        id: 'todo-2',
        content: 'Render the live task list',
        activeForm: 'Rendering the live task list',
        status: 'in_progress',
        priority: 'high',
      },
    ],
  })
})

const makeAskUserMessage = (
  id: string,
  question: string,
  header: string,
  optionLabels: string[],
): ChatMessage =>
  makeMessage({
    id,
    role: 'assistant',
    content: '',
    meta: {
      provider: 'claude',
      kind: 'ask-user',
      itemId: id,
      structuredData: JSON.stringify({
        itemId: id,
        kind: 'ask-user',
        status: 'completed',
        question,
        header,
        multiSelect: false,
        options: optionLabels.map((label) => ({ label, description: '' })),
      }),
    },
  })

test('buildRenderableMessages merges consecutive ask-user messages into a single renderable with questions[]', () => {
  const messages = [
    makeAskUserMessage('ask-1', 'Q1?', 'H1', ['A', 'B']),
    makeAskUserMessage('ask-2', 'Q2?', 'H2', ['C', 'D']),
    makeAskUserMessage('ask-3', 'Q3?', 'H3', ['E', 'F']),
  ]

  const result = buildRenderableMessages(messages)

  assert.equal(result.length, 1, 'three consecutive ask-user should merge to one renderable')
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type !== 'message') return

  const merged = parseStructuredAskUserMessage(result[0]!.message)
  assert.ok(merged, 'merged message must still parse as ask-user')
  assert.equal(merged!.itemId, 'ask-1', 'anchor itemId should be the first message id')
  assert.equal(merged!.questions.length, 3, 'all three questions should be preserved')
  assert.equal(merged!.questions[0]!.question, 'Q1?')
  assert.equal(merged!.questions[1]!.question, 'Q2?')
  assert.equal(merged!.questions[2]!.question, 'Q3?')
  assert.equal(merged!.questions[1]!.header, 'H2')
})

test('parseStructuredAskUserMessage reads a grouped Codex activity directly', () => {
  const message = makeMessage({
    id: 'codex-ask-group',
    role: 'assistant',
    content: '',
    meta: {
      provider: 'codex',
      kind: 'ask-user',
      itemId: 'codex-ask-group',
      structuredData: JSON.stringify({
        itemId: 'codex-ask-group',
        kind: 'ask-user',
        status: 'completed',
        question: 'Q1?',
        header: 'H1',
        multiSelect: false,
        options: [
          { label: 'A', description: '' },
          { label: 'B', description: '' },
        ],
        questions: [
          {
            question: 'Q1?',
            header: 'H1',
            multiSelect: false,
            options: [
              { label: 'A', description: '' },
              { label: 'B', description: '' },
            ],
          },
          {
            question: 'Q2?',
            header: 'H2',
            multiSelect: false,
            options: [
              { label: 'C', description: '' },
              { label: 'D', description: '' },
            ],
          },
        ],
      }),
    },
  })

  const parsed = parseStructuredAskUserMessage(message)

  assert.ok(parsed)
  assert.equal(parsed.questions.length, 2)
  assert.equal(parsed.questions[0]!.question, 'Q1?')
  assert.equal(parsed.questions[1]!.question, 'Q2?')
  assert.equal(parsed.questions[1]!.options[1]!.label, 'D')
})

test('buildRenderableMessages does not merge ask-user across non-ask-user boundary', () => {
  const messages = [
    makeAskUserMessage('ask-1', 'Q1?', 'H1', ['A', 'B']),
    makeMessage({ id: 'user-reply', role: 'user', content: 'A' }),
    makeAskUserMessage('ask-2', 'Q2?', 'H2', ['C', 'D']),
  ]

  const result = buildRenderableMessages(messages)

  assert.equal(result.length, 3, 'user message in between must break the merge group')
})

test('getAskUserAnswerKey ignores cosmetic structured data changes after restore', () => {
  const first = makeAskUserMessage('ask-1', 'Q1?', 'H1', ['A', 'B'])
  const reordered = {
    ...first,
    meta: {
      ...first.meta!,
      structuredData: JSON.stringify({
        status: 'completed',
        kind: 'ask-user',
        options: [
          { description: 'first option text changed later', label: 'A' },
          { label: 'B', description: '' },
        ],
        multiSelect: false,
        header: 'H1',
        question: 'Q1?',
        itemId: 'ask-1',
      }),
    },
  }

  assert.equal(getAskUserAnswerKey(first), getAskUserAnswerKey(reordered))
})
