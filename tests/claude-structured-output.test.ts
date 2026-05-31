import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createClaudeAskUserDeltaStripper,
  createClaudeStructuredOutputParser,
} from '../server/claude-structured-output.ts'

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

test('delta stripper holds back a partial open tag split across chunks', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const full =
    'Hello <ask-user-question>{"header":"H","question":"Q","options":[{"label":"A"}]}</ask-user-question> bye'

  let released = ''
  // Feed one character at a time to stress tag-boundary detection.
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, 'Hello  bye')
  assert.equal(released.includes('ask-user-question'), false)
  assert.equal(released.includes('<ask'), false)
})

test('delta stripper releases plain prose immediately without buffering', () => {
  const stripper = createClaudeAskUserDeltaStripper()

  assert.equal(stripper.push('Just plain text '), 'Just plain text ')
  assert.equal(stripper.push('with no tags.'), 'with no tags.')
  assert.equal(stripper.flush(), '')
})

test('delta stripper drops an unterminated real ask-user block on flush', () => {
  const stripper = createClaudeAskUserDeltaStripper()

  // The open tag arrives followed by JSON, but the stream ends before the close
  // tag. A truncated ask-user block can never become a card (the structured
  // parser needs the closing tag), and releasing the partial JSON verbatim leaks
  // raw `{"question":...` into the bubble. So drop it, like a truncated tool call.
  assert.equal(stripper.push('Lead in '), 'Lead in ')
  stripper.push('<ask-user-question>{"question":"Q"')
  assert.equal(stripper.flush(), '')
})

test('delta stripper passes through the ask-user tag name mentioned in prose', () => {
  // When the model merely talks about the tag (e.g. while explaining a bug) the
  // open tag is NOT followed by a JSON `{`, so it must never be treated as a
  // card and must not swallow the explanation that follows it.
  const stripper = createClaudeAskUserDeltaStripper()
  const full =
    'The bare token is not `<ask-user-question>` but the raw XML, ' +
    'which then leaks the rest of this sentence.'

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, full)
})

test('delta stripper does not mistake a lone angle bracket for a tag', () => {
  const stripper = createClaudeAskUserDeltaStripper()

  // A `<` that is not the ask-user tag should still be released once it is clear
  // it cannot grow into the open tag.
  assert.equal(stripper.push('a < b '), 'a < b ')
  assert.equal(stripper.push('and c > d'), 'and c > d')
  assert.equal(stripper.flush(), '')
})

test('delta stripper removes a Claude tool-call XML block typed as plain text', () => {
  // When Claude mistakenly emits a tool call as prose instead of a real
  // tool_use block, the raw function-call XML must never reach the chat UI.
  const stripper = createClaudeAskUserDeltaStripper()
  const openContainer = '<function' + '_calls>'
  const closeContainer = '</function' + '_calls>'
  const full =
    'Let me check.' +
    openContainer +
    '<invoke name="Bash"><parameter name="command">ls</parameter></invoke>' +
    closeContainer +
    'Done.'

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, 'Let me check.Done.')
  assert.equal(released.includes('invoke'), false)
  assert.equal(released.includes('function' + '_calls'), false)
  assert.equal(released.includes('parameter'), false)
})

test('delta stripper removes a bare <invoke> tool-call block emitted without a function_calls wrapper', () => {
  // Reproduces the UI leak: the model types a tool call as prose but omits the
  // outer <function_calls> container, so only `<invoke ...>...</invoke>` streams
  // out. The earlier stripper only matched the wrapped form, so this raw XML
  // leaked into the chat bubble and then failed to parse ("tool call could not
  // be parsed"). The bare invoke block must be stripped just like the wrapped one.
  const stripper = createClaudeAskUserDeltaStripper()
  const full =
    'Let me check.' +
    '<invoke name="Bash"><parameter name="command">ls</parameter></invoke>' +
    'Done.'

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, 'Let me check.Done.')
  assert.equal(released.includes('invoke'), false)
  assert.equal(released.includes('parameter'), false)
})

test('delta stripper passes through a bare <invoke> tag name mentioned in prose', () => {
  // The bare invoke tag is only stripped when it actually opens a tool call
  // (body continues with attributes/`>`); when its name is merely mentioned in
  // backticks it must pass through untouched, exactly like the wrapped form.
  const stripper = createClaudeAskUserDeltaStripper()
  const full = '我这条回复停在一个孤立的反引号 `<invoke` 之后,后面这段解释不能被吞掉。'

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, full)
})

test('delta stripper drops an unterminated bare <invoke> block on flush', () => {
  // A bare invoke whose closing </invoke> never arrives (stream cut off) is held
  // back during push() — it might still be a real block. Earlier we released it
  // verbatim on flush, but that leaked the raw XML: ReactMarkdown drops the
  // `<invoke …>` tag yet keeps the inner `<parameter>` value, so a stray bubble
  // like `count` reached the UI (the "老是停住" report). An unterminated tool call
  // is broken tool internals, never user prose, so flush must DROP it.
  const stripper = createClaudeAskUserDeltaStripper()

  assert.equal(stripper.push('Lead in '), 'Lead in ')
  stripper.push('<invoke name="Bash">')
  assert.equal(stripper.flush(), '')
})

test('delta stripper drops an unterminated wrapped tool-call block on flush', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const openContainer = '<function' + '_calls>'

  assert.equal(stripper.push('Lead in '), 'Lead in ')
  stripper.push(openContainer + '<invoke name="Bash">')
  assert.equal(stripper.flush(), '')
})

test('delta stripper drops an unterminated tool call but keeps the safe lead-in (count leak repro)', () => {
  // Exact shape of the UI leak: the model types a tool call as text and the
  // stream ends mid-`<parameter>`. flush must drop the broken block so the
  // inner value (`count`) never surfaces, while the preceding prose survives.
  const stripper = createClaudeAskUserDeltaStripper()

  const lead = stripper.push('Let me check. ')
  stripper.push('<invoke name="Grep"><parameter name="output_mode">count')
  const released = lead + stripper.flush()

  assert.equal(released, 'Let me check. ')
  assert.equal(released.includes('count'), false)
  assert.equal(released.includes('invoke'), false)
  assert.equal(released.includes('parameter'), false)
})

test('delta stripper drops a char-streamed unterminated bare tool call (no count leak)', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const full = '<invoke name="Grep">\n<parameter name="output_mode">count'

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, '')
  assert.equal(released.includes('count'), false)
})

test('delta stripper drops a char-streamed unterminated wrapped tool call (no count leak)', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const full =
    '<function' + '_calls>\n<invoke name="Grep">\n<parameter name="output_mode">count'

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, '')
  assert.equal(released.includes('count'), false)
})

test('delta stripper drops an unterminated ask-user block on flush', () => {
  const stripper = createClaudeAskUserDeltaStripper()

  stripper.push('<ask-user-question>{"question":"x","options":[')
  assert.equal(stripper.flush(), '')
})

test('stripper counts a completed wrapped tool-call block it consumed', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const full =
    '<function' +
    '_calls>' +
    '<invoke name="Bash"><parameter name="command">ls</parameter></invoke>' +
    '</function' +
    '_calls>'

  for (const char of full) {
    stripper.push(char)
  }
  stripper.flush()

  assert.equal(stripper.consumedToolCallBlockCount(), 1)
})

test('stripper counts a truncated tool-call block dropped on flush', () => {
  const stripper = createClaudeAskUserDeltaStripper()

  stripper.push('<invoke name="Grep"><parameter name="output_mode">count')
  stripper.flush()

  assert.equal(stripper.consumedToolCallBlockCount(), 1)
})

test('stripper does not count a tool-call tag merely mentioned in prose', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const full = '我这条回复停在一个孤立的反引号 `<invoke` 之后,后面这段解释不能被吞掉。'

  for (const char of full) {
    stripper.push(char)
  }
  stripper.flush()

  assert.equal(stripper.consumedToolCallBlockCount(), 0)
})

test('delta stripper strips a complete wrapped block pretty-printed with newlines', () => {
  // Real Claude output indents the wrapper: `<function_calls>\n  <invoke …>`.
  // The newline must not stop the container from being recognised, or the
  // wrapper tags (and inner `<parameter>` text) leak.
  const stripper = createClaudeAskUserDeltaStripper()
  const full =
    'Let me check.' +
    '<function' +
    '_calls>\n  <invoke name="Grep">\n    <parameter name="output_mode">count</parameter>\n  </invoke>\n</function' +
    '_calls>' +
    'Done.'

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, 'Let me check.Done.')
  assert.equal(released.includes('count'), false)
  assert.equal(released.includes('function' + '_calls'), false)
  assert.equal(stripper.consumedToolCallBlockCount(), 1)
})

test('delta stripper passes through a function-call tag name in prose even with a trailing newline', () => {
  // The whitespace tolerance must not turn a prose mention followed by a blank
  // line into a swallowed block.
  const stripper = createClaudeAskUserDeltaStripper()
  const full = 'The container is `' + '<function' + '_calls>' + '`\n\nand this explanation stays.'

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, full)
  assert.equal(stripper.consumedToolCallBlockCount(), 0)
})

test('delta stripper passes through the function-call tag name mentioned in prose', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const openContainer = '<function' + '_calls>'
  const full =
    'The container Claude uses is `' +
    openContainer +
    '`, and naming it here must not eat this trailing explanation.'

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, full)
})

test('delta stripper releases a backtick-wrapped ask-user tag at the very end of the stream', () => {
  // Reproduces the truncation seen in the UI: the model ends a sentence with the
  // tag name wrapped in backticks, e.g. "...如果我当时输出的是 `<ask-user-question>`".
  // The open tag is the last thing buffered (its body never starts with `{`), so
  // flush must release it verbatim instead of dropping the buffered open tag.
  const stripper = createClaudeAskUserDeltaStripper()
  const full = '如果我当时输出的是 `<ask-user-question>`'

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, full)
})

test('delta stripper releases an ask-user tag immediately followed by a closing backtick', () => {
  // The disambiguating byte after the open tag is a backtick (not `{`), so the
  // whole `<ask-user-question>` token plus the backtick must pass through.
  const stripper = createClaudeAskUserDeltaStripper()
  const full = '行内 `<ask-user-question>` 收尾后继续说明文字。'

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }
  released += stripper.flush()

  assert.equal(released, full)
})

test('delta stripper streams prose that continues after a backtick-wrapped ask-user tag without waiting for flush', () => {
  // Real truncation seen in the UI: the model writes the tag name inside
  // backticks mid-sentence and then keeps going with a long explanation. The
  // backtick after the open tag already proves it is prose (body is not `{`),
  // so every later character must be released during push(); it must NOT be held
  // hostage in the buffer until flush(). Earlier coverage only checked the total
  // after flush, which hid this live-truncation: the tail was being withheld
  // until stream end, so a still-streaming reply looked frozen at the tag.
  const stripper = createClaudeAskUserDeltaStripper()
  const lead = '我刚才那条被截断的消息里,写的是 `<ask-user-question>`'
  const tail = ' 这个标签,正是它把后面这一整段解释文字吞掉,导致界面看起来卡在标签前不动了。'
  const full = lead + tail

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }

  // Critical: the entire sentence must already be visible from push() alone,
  // before flush() is ever called, because the live stream may continue for a
  // long time after this point.
  assert.equal(released, full)
  assert.equal(stripper.flush(), '')
})

test('delta stripper does not buffer prose after a backtick-wrapped function-call tag until flush', () => {
  const stripper = createClaudeAskUserDeltaStripper()
  const openContainer = '<function' + '_calls>'
  const lead = '我正要写 `' + openContainer + '`'
  const tail = ' 这个容器名,但只要打出来就把后续的说明全部吃掉了,所以话总是说一半。'
  const full = lead + tail

  let released = ''
  for (const char of full) {
    released += stripper.push(char)
  }

  assert.equal(released, full)
  assert.equal(stripper.flush(), '')
})

test('emits Claude extended thinking as a reasoning activity (parity with Codex)', () => {
  const parseClaudeStreamEvent = createClaudeStructuredOutputParser('en')

  // message_start carries the assistant message id used to key the reasoning block.
  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_think_1' } },
    }),
    [],
  )

  // The thinking content block opens at index 0 (before the text answer at index 1).
  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    }),
    [],
  )

  // thinking_delta chunks accumulate but do not emit until the block stops.
  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me check the ' } },
    }),
    [],
  )
  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'renderer bridge next.' } },
    }),
    [],
  )

  // signature_delta is opaque verification metadata and must be ignored.
  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQBCgIYAh' } },
    }),
    [],
  )

  // content_block_stop flushes the accumulated thinking as a completed reasoning activity.
  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    }),
    [
      {
        type: 'activity',
        itemId: 'msg_think_1:thinking:0',
        kind: 'reasoning',
        status: 'completed',
        text: 'Let me check the renderer bridge next.',
      },
    ],
  )

  // The following text block streams the answer and must not produce a reasoning activity.
  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    }),
    [],
  )
  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Here is the answer.' } },
    }),
    [],
  )
  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
    }),
    [],
  )
})

test('does not emit a reasoning activity when the thinking block carries no text (omitted display)', () => {
  const parseClaudeStreamEvent = createClaudeStructuredOutputParser('en')

  parseClaudeStreamEvent({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg_omitted' } },
  })
  parseClaudeStreamEvent({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  })
  // Only a signature arrives — no thinking_delta text.
  parseClaudeStreamEvent({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQBCgIYAh' } },
  })

  assert.deepEqual(
    parseClaudeStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    }),
    [],
  )
})
