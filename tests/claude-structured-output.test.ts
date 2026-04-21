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

test('parses <ask-user-question> XML block emitted in Claude assistant text into ask-user activity', () => {
  const parseClaudeStreamEvent = createClaudeStructuredOutputParser('zh-CN')

  const payload = {
    header: '布局选择',
    question: '工作区干净时如何展示古法 Git 按钮?',
    multiSelect: false,
    options: [
      { label: '单独按钮', description: '只显示古法 Git 按钮' },
      { label: '完整操作栏', description: '其余按钮 disabled' },
    ],
  }

  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'assistant',
      message: {
        id: 'msg_ask_user_xml',
        content: [
          {
            type: 'text',
            text: `<ask-user-question>${JSON.stringify(payload)}</ask-user-question>`,
          },
        ],
      },
    }),
    [
      {
        type: 'activity',
        itemId: 'msg_ask_user_xml',
        kind: 'ask-user',
        status: 'completed',
        header: '布局选择',
        question: '工作区干净时如何展示古法 Git 按钮?',
        multiSelect: false,
        options: [
          { label: '单独按钮', description: '只显示古法 Git 按钮' },
          { label: '完整操作栏', description: '其余按钮 disabled' },
        ],
      },
    ],
  )
})

test('AskUserQuestion tool with multiple questions keeps all of them on the activity', () => {
  const parseClaudeStreamEvent = createClaudeStructuredOutputParser('en')

  const activities = parseClaudeStreamEvent({
    type: 'assistant',
    message: {
      id: 'msg_multi',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_multi_ask',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Layout',
                question: 'Which layout?',
                multiSelect: false,
                options: [
                  { label: 'Compact', description: 'Dense' },
                  { label: 'Spacious', description: 'Airy' },
                ],
              },
              {
                header: 'Theme',
                question: 'Which theme?',
                multiSelect: false,
                options: [
                  { label: 'Dark', description: '' },
                  { label: 'Light', description: '' },
                ],
              },
              {
                header: 'Font',
                question: 'Which font?',
                multiSelect: true,
                options: [
                  { label: 'Sans', description: '' },
                  { label: 'Mono', description: '' },
                ],
              },
            ],
          },
        },
      ],
    },
  })

  assert.equal(activities.length, 1)
  const activity = activities[0] as Extract<typeof activities[number], { kind: 'ask-user' }>
  assert.equal(activity.kind, 'ask-user')
  assert.equal(activity.itemId, 'toolu_multi_ask')
  assert.ok(Array.isArray(activity.questions), 'expected questions array to be kept')
  assert.equal(activity.questions?.length, 3)
  assert.equal(activity.questions?.[0]?.question, 'Which layout?')
  assert.equal(activity.questions?.[1]?.question, 'Which theme?')
  assert.equal(activity.questions?.[2]?.question, 'Which font?')
  assert.equal(activity.questions?.[2]?.multiSelect, true)
  assert.equal(activity.questions?.[1]?.options[0]?.label, 'Dark')
  // Top-level fields should mirror the first question for backward compatibility.
  assert.equal(activity.question, 'Which layout?')
  assert.equal(activity.header, 'Layout')
})

test('invalid Claude AskUserQuestion tool payload falls back to a normal tool activity instead of a blank ask-user card', () => {
  const parseClaudeStreamEvent = createClaudeStructuredOutputParser('en')

  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'assistant',
      message: {
        id: 'msg_invalid_ask_user_tool',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_invalid_ask_user',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  header: 'Confirmation',
                  question: '',
                  multiSelect: false,
                  options: [],
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
        itemId: 'toolu_invalid_ask_user',
        kind: 'tool',
        status: 'completed',
        toolName: 'AskUserQuestion',
        summary: 'Use tool: AskUserQuestion',
        toolInput: undefined,
      },
    ],
  )
})

test('parses <ask-user-question> XML whose JSON uses smart quotes and trailing commas', () => {
  const parseClaudeStreamEvent = createClaudeStructuredOutputParser('zh-CN')

  // Real-world payload as emitted by Claude in the wild: curly quotes around
  // keys/values and a trailing comma after the last option. Plain JSON.parse
  // would throw on this, so the parser must tolerate both forms.
  const rawXml =
    '<ask-user-question>{\u201cheader\u201d:\u201c\u88ab\u52a8\u5b9e\u73b0\u65b9\u5f0f\u201d,\u201cquestion\u201d:\u201c\u6539\u5199\u8868\u8fbe?\u201d,\u201cmultiSelect\u201d:false,\u201coptions\u201d:[{\u201clabel\u201d:\u201c\u65b0\u589e passive.kind=rewrite\u201d,\u201cdescription\u201d:\u201c\u76f4\u63a5\u6539\u5199\u3002\u201d},{\u201clabel\u201d:\u201c\u52a0 aura \u65b0\u89e6\u53d1\u201d,\u201cdescription\u201d:\u201c\u4fdd\u7559\u73b0\u7ed3\u6784\u3002\u201d},]}</ask-user-question>'

  const activities = parseClaudeStreamEvent({
    type: 'assistant',
    message: {
      id: 'msg_smart_quotes',
      content: [{ type: 'text', text: rawXml }],
    },
  })

  assert.equal(activities.length, 1, 'expected a single ask-user activity')
  const activity = activities[0] as Extract<typeof activities[number], { kind: 'ask-user' }>
  assert.equal(activity.kind, 'ask-user')
  assert.equal(activity.itemId, 'msg_smart_quotes')
  assert.equal(activity.header, '\u88ab\u52a8\u5b9e\u73b0\u65b9\u5f0f')
  assert.equal(activity.question, '\u6539\u5199\u8868\u8fbe?')
  assert.equal(activity.multiSelect, false)
  assert.equal(activity.options.length, 2)
  assert.equal(activity.options[0]?.label, '\u65b0\u589e passive.kind=rewrite')
  assert.equal(activity.options[1]?.label, '\u52a0 aura \u65b0\u89e6\u53d1')
})

test('parses <ask-user-question> XML wrapped in a fenced code block', () => {
  const parseClaudeStreamEvent = createClaudeStructuredOutputParser('zh-CN')

  // Claude sometimes wraps its XML in a markdown code fence. The parser should
  // still recognise the ask-user block inside.
  const payload = {
    header: 'Layout',
    question: 'Which layout?',
    multiSelect: false,
    options: [{ label: 'Compact', description: '' }],
  }
  const text = '```xml\n<ask-user-question>' + JSON.stringify(payload) + '</ask-user-question>\n```'

  const activities = parseClaudeStreamEvent({
    type: 'assistant',
    message: {
      id: 'msg_fenced',
      content: [{ type: 'text', text }],
    },
  })

  assert.equal(activities.length, 1)
  const activity = activities[0] as Extract<typeof activities[number], { kind: 'ask-user' }>
  assert.equal(activity.question, 'Which layout?')
  assert.equal(activity.options[0]?.label, 'Compact')
})
