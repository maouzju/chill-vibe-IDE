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
