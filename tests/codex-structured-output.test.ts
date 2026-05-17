import assert from 'node:assert/strict'
import test from 'node:test'

import { parseCodexResponseEvent } from '../server/codex-structured-output.ts'

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
