import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCodexAskUserActivityDeduper,
  parseCodexResponseEvent,
} from '../server/codex-structured-output.ts'

test('parses Codex command, reasoning, and assistant items into structured chat events', () => {
  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'pnpm test',
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'item_1',
        kind: 'command',
        status: 'in_progress',
        command: 'pnpm test',
        output: '',
        exitCode: null,
      },
    ],
  )

  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'pnpm test',
        aggregated_output: '2 passed',
        exit_code: 0,
        status: 'completed',
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'item_1',
        kind: 'command',
        status: 'completed',
        command: 'pnpm test',
        output: '2 passed',
        exitCode: 0,
      },
    ],
  )

  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'reasoning',
        text: '**Planning**\n\nCheck the repo first.',
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'item_2',
        kind: 'reasoning',
        status: 'completed',
        text: '**Planning**\n\nCheck the repo first.',
      },
    ],
  )

  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.completed',
      item: {
        id: 'item_3',
        type: 'agent_message',
        text: 'I found the issue.',
      },
    }),
    [
      {
        type: 'assistant_message',
        itemId: 'item_3',
        content: 'I found the issue.',
      },
    ],
  )

  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.completed',
      item: {
        id: 'item_4',
        type: 'edited_files',
        files: [
          {
            path: 'src/App.tsx',
            kind: 'modified',
            added_lines: 1,
            removed_lines: 1,
            patch: '@@ -1,1 +1,1 @@\n-const oldValue = true\n+const newValue = true',
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'item_4',
        kind: 'edits',
        status: 'completed',
        files: [
          {
            path: 'src/App.tsx',
            kind: 'modified',
            addedLines: 1,
            removedLines: 1,
            patch: '@@ -1,1 +1,1 @@\n-const oldValue = true\n+const newValue = true',
          },
        ],
      },
    ],
  )

  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.completed',
      item: {
        id: 'item_5',
        type: 'diff',
        path: 'src/new.ts',
        kind: 'added',
        added_lines: 1,
        removed_lines: 0,
        diff: '@@ -0,0 +1,1 @@\n+export const value = 1',
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'item_5',
        kind: 'edits',
        status: 'completed',
        files: [
          {
            path: 'src/new.ts',
            kind: 'added',
            addedLines: 1,
            removedLines: 0,
            patch: '@@ -0,0 +1,1 @@\n+export const value = 1',
          },
        ],
      },
    ],
  )
})

test('normalizes raw added-file content into a synthetic diff for Codex file changes', () => {
  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.completed',
      item: {
        id: 'item_5b',
        type: 'file_change',
        path: 'docs/gameplay/fix.md',
        kind: 'added',
        patch: '# 标题\n\n- 第一条\n- 第二条',
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'item_5b',
        kind: 'edits',
        status: 'completed',
        files: [
          {
            path: 'docs/gameplay/fix.md',
            kind: 'added',
            addedLines: 4,
            removedLines: 0,
            patch: '@@ -0,0 +1,4 @@\n+# 标题\n+\n+- 第一条\n+- 第二条',
          },
        ],
      },
    ],
  )
})

test('parses synthetic ask-user blocks from Codex assistant messages', () => {
  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.completed',
      item: {
        id: 'item_6',
        type: 'agent_message',
        text: `<ask-user-question>{"header":"Need direction","question":"Which approach should I take?","multiSelect":false,"options":[{"label":"Fast path","description":"Keep the current shape and patch the smallest diff."},{"label":"Safer refactor","description":"Do a slightly larger cleanup first to reduce follow-up risk."}]}</ask-user-question>`,
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'item_6',
        kind: 'ask-user',
        status: 'completed',
        header: 'Need direction',
        question: 'Which approach should I take?',
        multiSelect: false,
        options: [
          {
            label: 'Fast path',
            description: 'Keep the current shape and patch the smallest diff.',
          },
          {
            label: 'Safer refactor',
            description: 'Do a slightly larger cleanup first to reduce follow-up risk.',
          },
        ],
      },
    ],
  )
})

test('parses grouped ask-user blocks from Codex assistant messages', () => {
  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.completed',
      item: {
        id: 'item_6_grouped',
        type: 'agent_message',
        text: `<ask-user-question>${JSON.stringify({
          questions: [
            {
              header: 'Scope',
              question: 'Which area should I change first?',
              multiSelect: false,
              options: [
                { label: 'Editor', description: 'Start with the editor surface.' },
                { label: 'Board', description: 'Start with the board layout.' },
              ],
            },
            {
              header: 'Validation',
              question: 'How broad should verification be?',
              multiSelect: false,
              options: [
                { label: 'Focused', description: 'Run the narrow proving checks.' },
                { label: 'Broad', description: 'Run the wider regression sweep.' },
              ],
            },
            {
              header: 'Ignored',
              question: '',
              multiSelect: false,
              options: [{ label: 'Invalid', description: 'Missing question text.' }],
            },
            {
              header: 'Delivery',
              question: 'How should I deliver the result?',
              multiSelect: false,
              options: [
                { label: 'Patch', description: 'Leave the verified source changes.' },
                { label: 'Package', description: 'Also produce a runnable package.' },
              ],
            },
            {
              header: 'Follow-up',
              question: 'Should I continue with adjacent cleanup?',
              multiSelect: false,
              options: [
                { label: 'Stop', description: 'Keep the change tightly scoped.' },
                { label: 'Continue', description: 'Include the adjacent cleanup.' },
              ],
            },
          ],
        })}</ask-user-question>`,
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'item_6_grouped',
        kind: 'ask-user',
        status: 'completed',
        header: 'Scope',
        question: 'Which area should I change first?',
        multiSelect: false,
        options: [
          { label: 'Editor', description: 'Start with the editor surface.' },
          { label: 'Board', description: 'Start with the board layout.' },
        ],
        questions: [
          {
            header: 'Scope',
            question: 'Which area should I change first?',
            multiSelect: false,
            options: [
              { label: 'Editor', description: 'Start with the editor surface.' },
              { label: 'Board', description: 'Start with the board layout.' },
            ],
          },
          {
            header: 'Validation',
            question: 'How broad should verification be?',
            multiSelect: false,
            options: [
              { label: 'Focused', description: 'Run the narrow proving checks.' },
              { label: 'Broad', description: 'Run the wider regression sweep.' },
            ],
          },
          {
            header: 'Delivery',
            question: 'How should I deliver the result?',
            multiSelect: false,
            options: [
              { label: 'Patch', description: 'Leave the verified source changes.' },
              { label: 'Package', description: 'Also produce a runnable package.' },
            ],
          },
          {
            header: 'Follow-up',
            question: 'Should I continue with adjacent cleanup?',
            multiSelect: false,
            options: [
              { label: 'Stop', description: 'Keep the change tightly scoped.' },
              { label: 'Continue', description: 'Include the adjacent cleanup.' },
            ],
          },
        ],
      },
    ],
  )
})

test('parses failed Codex commands as terminal activities instead of leaving them running', () => {
  assert.deepEqual(
    parseCodexResponseEvent({
      method: 'item/completed',
      params: {
        item: {
          id: 'item_failed_command',
          type: 'commandExecution',
          command: 'pnpm test',
          aggregatedOutput: '1 test failed',
          exitCode: 1,
          status: 'failed',
        },
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'item_failed_command',
        kind: 'command',
        status: 'failed',
        command: 'pnpm test',
        output: '1 test failed',
        exitCode: 1,
      },
    ],
  )
})

test('parses Codex commentary JSON assistant messages into reasoning activities', () => {
  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.completed',
      item: {
        id: 'item_6b',
        type: 'agent_message',
        text: '{"commentary":[{"text":"先确认 JSON 结构，再精确读取锻炉和候选效果。"}]}',
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'item_6b',
        kind: 'reasoning',
        status: 'completed',
        text: '先确认 JSON 结构，再精确读取锻炉和候选效果。',
      },
    ],
  )
})

test('parses Codex native compaction notifications from app-server events', () => {
  assert.deepEqual(
    parseCodexResponseEvent({
      method: 'item/completed',
      params: {
        item: {
          id: 'compact_1',
          type: 'contextCompaction',
        },
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'compact_1',
        kind: 'compaction',
        status: 'completed',
        trigger: 'auto',
      },
    ],
  )

  assert.deepEqual(
    parseCodexResponseEvent({
      method: 'thread/compacted',
      params: {
        turnId: 'turn_123',
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'turn_123',
        kind: 'compaction',
        status: 'completed',
        trigger: 'auto',
      },
    ],
  )
})

test('parses Codex collab agent tool calls into structured agent activities', () => {
  assert.deepEqual(
    parseCodexResponseEvent({
      method: 'item/completed',
      params: {
        item: {
          id: 'call-wait',
          type: 'collabAgentToolCall',
          tool: 'wait',
          status: 'completed',
          senderThreadId: 'thread-main',
          receiverThreadIds: ['thread-lorentz', 'thread-bernoulli', 'thread-maxwell'],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {
            'thread-lorentz': { status: 'completed', message: 'Done' },
            'thread-bernoulli': { status: 'completed', message: 'Done' },
            'thread-maxwell': { status: 'running', message: null },
          },
          receiverAgents: [
            { threadId: 'thread-lorentz', agentNickname: 'Lorentz', agentRole: 'explorer' },
            { threadId: 'thread-bernoulli', agentNickname: 'Bernoulli', agentRole: 'explorer' },
            { threadId: 'thread-maxwell', agentNickname: 'Maxwell', agentRole: 'explorer' },
          ],
        },
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'call-wait',
        kind: 'agents',
        status: 'completed',
        tool: 'wait',
        callStatus: 'completed',
        prompt: null,
        model: null,
        reasoningEffort: null,
        agents: [
          {
            threadId: 'thread-lorentz',
            nickname: 'Lorentz',
            role: 'explorer',
            status: 'completed',
            message: 'Done',
          },
          {
            threadId: 'thread-bernoulli',
            nickname: 'Bernoulli',
            role: 'explorer',
            status: 'completed',
            message: 'Done',
          },
          {
            threadId: 'thread-maxwell',
            nickname: 'Maxwell',
            role: 'explorer',
            status: 'running',
            message: null,
          },
        ],
      },
    ],
  )
})

test('keeps Codex collab agents visible when metadata only arrives in agent status entries', () => {
  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.completed',
      item: {
        id: 'call-wait-snake',
        type: 'collabAgentToolCall',
        tool: 'wait',
        status: 'completed',
        sender_thread_id: 'thread-main',
        receiver_thread_ids: ['thread-robie', 'thread-ada'],
        agent_statuses: [
          {
            thread_id: 'thread-robie',
            agent_nickname: 'Robie',
            agent_role: 'explorer',
            status: 'completed',
            message: 'Done',
          },
          {
            thread_id: 'thread-ada',
            agent_nickname: 'Ada',
            agent_role: 'reviewer',
            status: 'running',
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'call-wait-snake',
        kind: 'agents',
        status: 'completed',
        tool: 'wait',
        callStatus: 'completed',
        prompt: null,
        model: null,
        reasoningEffort: null,
        agents: [
          {
            threadId: 'thread-robie',
            nickname: 'Robie',
            role: 'explorer',
            status: 'completed',
            message: 'Done',
          },
          {
            threadId: 'thread-ada',
            nickname: 'Ada',
            role: 'reviewer',
            status: 'running',
            message: null,
          },
        ],
      },
    ],
  )
})

test('delivers empty wait completion updates so an earlier in-progress activity can settle', () => {
  const item = {
    id: 'call-empty-wait',
    type: 'collabAgentToolCall',
    tool: 'wait',
    senderThreadId: 'thread-main',
    receiverThreadIds: [],
    agentsStates: {},
    prompt: null,
    model: null,
    reasoningEffort: null,
  }

  for (const [method, status] of [['item/started', 'inProgress'], ['item/completed', 'completed']]) {
    const activities = parseCodexResponseEvent({ method, params: { item: { ...item, status } } })
    assert.equal(activities.length, 1)
    assert.deepEqual(activities[0], {
      type: 'activity',
      itemId: item.id,
      kind: 'agents',
      status: 'completed',
      tool: 'wait',
      callStatus: status,
      prompt: null,
      model: null,
      reasoningEffort: null,
      agents: [],
    })
  }
})

// Codex CLI 0.153.x 新增 `request_user_input_async` 工具：模型调用后 CLI 立刻返回
// {"accepted":true}，随后把问题预渲染成一条 agentMessage（delivery: "async"，
// questions: [{title, options}]）。2026-09-20 实测它被当普通气泡显示，用户无处作答，
// 模型每回合重问一次（同一题在一张卡上刷出 4 遍）。这里把它解析成 ask-user 卡。
test('parses Codex async user-input questions on agent messages into ask-user cards', () => {
  assert.deepEqual(
    parseCodexResponseEvent({
      method: 'item/completed',
      params: {
        item: {
          id: 'call_wZ18dfGnI60A4rBjTNVshb57',
          type: 'agentMessage',
          text: '继续修复咖啡师卡牌\n- 直接按“本单位获得的能量翻倍”修复并验证\n- 先只检查现有实现，暂不改代码',
          phase: 'final_answer',
          delivery: 'async',
          questions: [
            {
              title: '继续修复咖啡师卡牌',
              options: ['直接按“本单位获得的能量翻倍”修复并验证', '先只检查现有实现，暂不改代码'],
            },
          ],
        },
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'call_wZ18dfGnI60A4rBjTNVshb57',
        kind: 'ask-user',
        status: 'completed',
        header: '继续修复咖啡师卡牌',
        question: '继续修复咖啡师卡牌',
        multiSelect: false,
        options: [
          { label: '直接按“本单位获得的能量翻倍”修复并验证', description: '' },
          { label: '先只检查现有实现，暂不改代码', description: '' },
        ],
      },
    ],
  )
})

test('parses grouped Codex async user-input questions and skips empty ones', () => {
  const events = parseCodexResponseEvent({
    type: 'item.completed',
    item: {
      id: 'call_a',
      type: 'agent_message',
      text: 'ignored pre-rendered text',
      delivery: 'async',
      questions: [
        { title: 'First', options: ['A', 'B'] },
        { title: '', options: ['X'] },
        { title: 'Second', options: ['C', ''] },
      ],
    },
  })

  assert.equal(events.length, 1)
  const activity = events[0]!
  assert.equal(activity.type, 'activity')
  if (activity.type !== 'activity' || activity.kind !== 'ask-user') {
    throw new Error('expected ask-user activity')
  }
  assert.equal(activity.header, 'First')
  assert.deepEqual(activity.questions, [
    { header: 'First', question: 'First', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
    { header: 'Second', question: 'Second', multiSelect: false, options: [{ label: 'C', description: '' }] },
  ])
})

test('agent messages with an empty questions array still render as plain text', () => {
  assert.deepEqual(
    parseCodexResponseEvent({
      type: 'item.completed',
      item: { id: 'call_b', type: 'agent_message', text: 'Done.', delivery: 'async', questions: [] },
    }),
    [{ type: 'assistant_message', itemId: 'call_b', content: 'Done.' }],
  )
})

// 同一回合里模型把 request_user_input_async 连调两次（rollout 里两条 function_call
// 相隔 66ms，题目逐字相同），CLI 忠实吐出两条 agentMessage。去重按题面签名，
// 遇到任何非 ask-user 事件即复位，所以真正的再次提问不会被吞。
test('deduplicates back-to-back identical Codex ask-user activities within a turn', () => {
  const deduper = createCodexAskUserActivityDeduper()
  const parseAskUser = (id: string, options: string[]) => {
    const event = parseCodexResponseEvent({
      type: 'item.completed',
      item: { id, type: 'agent_message', text: 'Q', questions: [{ title: 'Q', options }] },
    })[0]
    if (!event || event.type !== 'activity' || event.kind !== 'ask-user') {
      throw new Error('expected ask-user activity')
    }
    return event
  }
  const first = parseAskUser('call_1', ['A', 'B'])
  const second = parseAskUser('call_2', ['A', 'B'])
  const different = parseAskUser('call_3', ['A', 'C'])

  assert.equal(deduper.shouldEmit(first), true)
  assert.equal(deduper.shouldEmit(second), false)
  assert.equal(deduper.shouldEmit(different), true)
  deduper.reset()
  assert.equal(deduper.shouldEmit(different), true)
})
