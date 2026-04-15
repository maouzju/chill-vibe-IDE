import assert from 'node:assert/strict'
import test from 'node:test'

import { createClaudeStructuredOutputParser } from '../server/claude-structured-output.ts'

test('parses Claude tool use, edited files, and local command output into structured chat events', () => {
  const parseClaudeStreamEvent = createClaudeStructuredOutputParser('en')

  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_bash',
            name: 'Bash',
            input: {
              command: 'pnpm test',
            },
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'toolu_bash',
        kind: 'command',
        status: 'in_progress',
        command: 'pnpm test',
        output: '',
        exitCode: null,
      },
    ],
  )

  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'user',
      message: {
        content: '<local-command-stdout>2 passed</local-command-stdout>',
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'toolu_bash',
        kind: 'command',
        status: 'completed',
        command: 'pnpm test',
        output: '2 passed',
        exitCode: null,
      },
    ],
  )

  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_read',
            name: 'Read',
            input: {
              file_path: 'src/App.tsx',
            },
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'toolu_read',
        kind: 'tool',
        status: 'completed',
        toolName: 'Read',
        summary: 'Read App.tsx',
        toolInput: {
          file_path: 'src/App.tsx',
        },
      },
    ],
  )

  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_edit',
            name: 'Edit',
            input: {
              file_path: 'src/App.tsx',
              old_string: 'const oldValue = true\n',
              new_string: 'const newValue = true\n',
            },
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'toolu_edit',
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
    parseClaudeStreamEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_write',
            name: 'Write',
            input: {
              file_path: 'src/new.ts',
              content: 'export const value = 1\n',
            },
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'toolu_write',
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

test('TodoWrite emits a structured todo activity that can update in place', () => {
  const parseClaudeStreamEvent = createClaudeStructuredOutputParser('en')

  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_todo',
            name: 'TodoWrite',
            input: {
              todos: [
                {
                  id: 'todo_1',
                  content: 'Inspect the stream parser',
                  activeForm: 'Inspecting the stream parser',
                  status: 'completed',
                  priority: 'high',
                },
                {
                  id: 'todo_2',
                  content: 'Render the task panel',
                  activeForm: 'Rendering the task panel',
                  status: 'in_progress',
                },
                {
                  id: 'todo_3',
                  content: 'Verify light and dark theme snapshots',
                  status: 'pending',
                },
              ],
            },
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'toolu_todo',
        kind: 'todo',
        status: 'completed',
        items: [
          {
            id: 'todo_1',
            content: 'Inspect the stream parser',
            activeForm: 'Inspecting the stream parser',
            status: 'completed',
            priority: 'high',
          },
          {
            id: 'todo_2',
            content: 'Render the task panel',
            activeForm: 'Rendering the task panel',
            status: 'in_progress',
          },
          {
            id: 'todo_3',
            content: 'Verify light and dark theme snapshots',
            status: 'pending',
          },
        ],
      },
    ],
  )
})

test('ExitPlanMode emits an ask-user activity with approve and reject options', () => {
  const parseEn = createClaudeStructuredOutputParser('en')
  const parseZh = createClaudeStructuredOutputParser('zh-CN')

  // ExitPlanMode without a preceding Write — no planFile
  assert.deepEqual(
    parseEn({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_exit_plan',
            name: 'ExitPlanMode',
            input: {},
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'toolu_exit_plan',
        kind: 'ask-user',
        status: 'completed',
        question: 'Plan is ready for review',
        header: 'Plan approval',
        multiSelect: false,
        options: [
          { label: 'Approve plan', description: '' },
          { label: 'Reject plan', description: '' },
        ],
        planFile: undefined,
      },
    ],
  )

  // ExitPlanMode — Chinese
  assert.deepEqual(
    parseZh({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_exit_plan_zh',
            name: 'ExitPlanMode',
            input: {},
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'toolu_exit_plan_zh',
        kind: 'ask-user',
        status: 'completed',
        question: '计划已准备好，请审阅',
        header: '计划审批',
        multiSelect: false,
        options: [
          { label: '批准计划', description: '' },
          { label: '拒绝计划', description: '' },
        ],
        planFile: undefined,
      },
    ],
  )

  // EnterPlanMode stays as a regular tool activity
  assert.deepEqual(
    parseEn({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_enter_plan',
            name: 'EnterPlanMode',
            input: {},
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'toolu_enter_plan',
        kind: 'tool',
        status: 'completed',
        toolName: 'EnterPlanMode',
        summary: 'Enter plan mode',
        toolInput: undefined,
      },
    ],
  )
})

test('ExitPlanMode attaches planFile from the most recent Write activity', () => {
  const parse = createClaudeStructuredOutputParser('en')

  // First: a Write tool creates the plan file
  parse({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_write_plan',
          name: 'Write',
          input: {
            file_path: '.claude/plan.md',
            content: '# Plan\n\n1. Do the thing\n',
          },
        },
      ],
    },
  })

  // Then: ExitPlanMode should carry the plan file path
  assert.deepEqual(
    parse({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_exit_plan2',
            name: 'ExitPlanMode',
            input: {},
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'toolu_exit_plan2',
        kind: 'ask-user',
        status: 'completed',
        question: 'Plan is ready for review',
        header: 'Plan approval',
        multiSelect: false,
        options: [
          { label: 'Approve plan', description: '' },
          { label: 'Reject plan', description: '' },
        ],
        planFile: '.claude/plan.md',
      },
    ],
  )
})
