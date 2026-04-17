import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createDefaultBrainstormState } from '../shared/brainstorm.ts'
import type { ChatCard as ChatCardModel, ImageAttachment } from '../shared/schema.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import { ChatCard } from '../src/components/ChatCard.tsx'
import { cleanCommandDisplay, summarizeCommandDisplay } from '../src/components/chat-card-rendering.tsx'
import { getNewlyCompletedStructuredTodoItemIds } from '../src/components/structured-todo-flash.ts'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const createCard = (): ChatCardModel => ({
  id: 'card-1',
  title: 'Feature Chat',
  status: 'streaming',
  size: 560,
  provider: 'codex',
  model: 'gpt-5.4',
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  autoUrgeActive: false,
  autoUrgeProfileId: 'auto-urge-default',
  collapsed: false,
  unread: false,
  draft: '',
  draftAttachments: [],
  stickyNote: '',
  brainstorm: createDefaultBrainstormState(),
  providerSessions: {},
  messages: [
    {
      id: 'msg-a',
      role: 'assistant',
      content: 'I checked the project entrypoints first.',
      createdAt: '2026-04-05T12:00:00.000Z',
      meta: {
        provider: 'codex',
      },
    },
    {
      id: 'cmd-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:00:02.000Z',
      meta: {
        kind: 'command',
        provider: 'codex',
        structuredData: JSON.stringify({
          itemId: 'item_1',
          status: 'completed',
          command: 'pnpm test',
          output: '2 passed',
          exitCode: 0,
        }),
      },
    },
    {
      id: 'cmd-2',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:00:03.000Z',
      meta: {
        kind: 'command',
        provider: 'codex',
        structuredData: JSON.stringify({
          itemId: 'item_2',
          status: 'completed',
          command: 'pnpm build',
          output: 'done',
          exitCode: 0,
        }),
      },
    },
    {
      id: 'reasoning-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:00:04.000Z',
      meta: {
        kind: 'reasoning',
        provider: 'codex',
        structuredData: JSON.stringify({
          itemId: 'item_3',
          status: 'completed',
          text: '**Planning**\n\nCheck the renderer bridge next.',
        }),
      },
    },
  ],
})

const createClaudeToolCard = (): ChatCardModel => ({
  id: 'card-2',
  title: 'Review Chat',
  status: 'idle',
  size: 560,
  provider: 'claude',
  model: 'claude-opus-4-7',
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  autoUrgeActive: false,
  autoUrgeProfileId: 'auto-urge-default',
  collapsed: false,
  unread: false,
  draft: '',
  draftAttachments: [],
  stickyNote: '',
  brainstorm: createDefaultBrainstormState(),
  providerSessions: {},
  messages: [
    {
      id: 'tool-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:01:00.000Z',
      meta: {
        kind: 'tool',
        provider: 'claude',
        structuredData: JSON.stringify({
          itemId: 'toolu_read',
          status: 'completed',
          toolName: 'Read',
          summary: 'Read App.tsx',
          toolInput: {
            file_path: 'src/App.tsx',
            offset: '471',
            limit: '50',
          },
        }),
      },
    },
  ],
})

const createEditedFilesCard = (): ChatCardModel => ({
  id: 'card-3',
  title: 'Edit Chat',
  status: 'idle',
  size: 560,
  provider: 'codex',
  model: 'gpt-5.4',
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  autoUrgeActive: false,
  autoUrgeProfileId: 'auto-urge-default',
  collapsed: false,
  unread: false,
  draft: '',
  draftAttachments: [],
  stickyNote: '',
  brainstorm: createDefaultBrainstormState(),
  providerSessions: {},
  messages: [
    {
      id: 'edits-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:02:00.000Z',
      meta: {
        kind: 'edits',
        provider: 'codex',
        structuredData: JSON.stringify({
          itemId: 'workspace_edits',
          status: 'completed',
          files: [
            {
              path: 'shared/schema.ts',
              kind: 'modified',
              addedLines: 11,
              removedLines: 1,
              patch: '@@ -8,1 +8,1 @@\n-export const oldLine = true\n+export const newLine = true',
            },
          ],
        }),
      },
    },
  ],
})

const createChangesSummaryCard = (): ChatCardModel => ({
  id: 'card-5',
  title: 'Summary Chat',
  status: 'idle',
  size: 560,
  provider: 'codex',
  model: 'gpt-5.4',
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  autoUrgeActive: false,
  autoUrgeProfileId: 'auto-urge-default',
  collapsed: false,
  unread: false,
  draft: '',
  draftAttachments: [],
  stickyNote: '',
  brainstorm: createDefaultBrainstormState(),
  providerSessions: {},
  messages: [
    {
      id: 'summary-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:02:30.000Z',
      meta: {
        kind: 'changes-summary',
        provider: 'codex',
        structuredData: JSON.stringify([
          {
            path: 'D:/Git/chill-vibe/docs/release-notes.md',
            addedLines: 0,
            removedLines: 57,
          },
        ]),
      },
    },
  ],
})

const createTodoCard = (): ChatCardModel => ({
  id: 'card-4',
  title: 'Task Chat',
  status: 'streaming',
  size: 560,
  provider: 'claude',
  model: 'claude-opus-4-7',
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  autoUrgeActive: false,
  autoUrgeProfileId: 'auto-urge-default',
  collapsed: false,
  unread: false,
  draft: '',
  draftAttachments: [],
  stickyNote: '',
  brainstorm: createDefaultBrainstormState(),
  providerSessions: {},
  messages: [
    {
      id: 'todo-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:03:00.000Z',
      meta: {
        kind: 'todo',
        provider: 'claude',
        structuredData: JSON.stringify({
          itemId: 'todo_update',
          status: 'completed',
          items: [
            {
              id: 'task-1',
              content: 'Inspect the activity pipeline',
              status: 'completed',
            },
            {
              id: 'task-2',
              content: 'Render the VS Code-like task list',
              activeForm: 'Rendering the VS Code-like task list',
              status: 'in_progress',
              priority: 'high',
            },
            {
              id: 'task-3',
              content: 'Verify both themes',
              status: 'pending',
            },
          ],
        }),
      },
    },
  ],
})

const renderCard = (
  card: ChatCardModel,
  {
    onForkConversation,
    onOpenFile,
  }: {
    onForkConversation?: (messageId: string) => void
    onOpenFile?: (relativePath: string) => void
  } = {},
) =>
  renderToStaticMarkup(
    <ChatCard
      card={card}
      providerReady={true}
      workspacePath="d:\\Git\\chill-vibe"
      language="en"
      systemPrompt={defaultSystemPrompt}
      crossProviderSkillReuseEnabled={true}
      musicAlbumCoverEnabled={false}
      weatherCity=""
      gitAgentModel="gpt-5.4 low"
      brainstormRequestModel="gpt-5.4"
      availableQuickToolModels={[]}
      autoUrgeEnabled={false}
      autoUrgeMessage=""
      autoUrgeSuccessKeyword=""
      onSetAutoUrgeEnabled={() => undefined}
      onRemove={() => undefined}
      onSend={async (_prompt: string, _attachments: ImageAttachment[]) => undefined}
      onStop={async () => undefined}
      onDraftChange={() => undefined}
      onChangeModel={() => undefined}
      onChangeReasoningEffort={() => undefined}
      onTogglePlanMode={() => undefined}
      onToggleThinking={() => undefined}
      onToggleCollapsed={() => undefined}
      onMarkRead={() => undefined}
      onStickyNoteChange={() => undefined}
      onPatchCard={() => undefined}
      onChangeTitle={() => undefined}
      onOpenFile={onOpenFile}
      onForkConversation={onForkConversation}
      isRestored={false}
      onRestoredAnimationEnd={() => undefined}
    />,
  )

test('renders inline structured command summaries and reasoning blocks', () => {
  const markup = renderCard(createCard())

  assert.match(markup, /Package script/)
  assert.match(markup, /pnpm test/)
  assert.match(markup, /pnpm build/)
  assert.match(markup, /structured-command-inline-row/)
  assert.match(markup, /Thinking/)
  assert.match(markup, /Check the renderer bridge next/)
})

test('renders reasoning previews without raw markdown markers', () => {
  const markup = renderCard(createCard())

  assert.doesNotMatch(markup, /\*\*Planning\*\*/)
  assert.match(markup, /Planning/)
  assert.match(markup, /Check the renderer bridge next/)
})

test('hides exit code 0 (success) from command blocks', () => {
  const markup = renderCard(createCard())

  assert.doesNotMatch(markup, /Exit code 0/)
  assert.doesNotMatch(markup, /structured-command-exit/)
})

test('shows non-zero exit code for failed commands', () => {
  const card = createCard()
  card.messages[1] = {
    ...card.messages[1],
    meta: {
      ...card.messages[1].meta,
      structuredData: JSON.stringify({
        itemId: 'item_1',
        status: 'in_progress',
        command: 'pnpm test',
        output: '1 failed',
        exitCode: 1,
      }),
    },
  }

  const markup = renderCard(card)

  assert.match(markup, /Exit code 1/)
})

test('strips shell wrapper from command display', () => {
  assert.equal(
    cleanCommandDisplay(
      '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'Get-ChildItem -Force\'',
    ),
    'Get-ChildItem -Force',
  )
})

test('renders command type summaries inline while suppressing verbose command output', () => {
  const card = createCard()
  card.messages[1] = {
    ...card.messages[1],
    meta: {
      ...card.messages[1].meta,
      structuredData: JSON.stringify({
        itemId: 'item_1',
        status: 'completed',
        command: 'git status --short',
        output: 'M src/App.tsx',
        exitCode: 0,
      }),
    },
  }
  card.messages[2] = {
    ...card.messages[2],
    meta: {
      ...card.messages[2].meta,
      structuredData: JSON.stringify({
        itemId: 'item_2',
        status: 'completed',
        command: 'Get-Content C:\\Users\\demo\\.codex\\skills\\chill-vibe-full-regression\\SKILL.md',
        output: 'name: chill-vibe-full-regression',
        exitCode: 0,
      }),
    },
  }

  const markup = renderCard(card)

  assert.match(markup, /Git command/)
  assert.match(markup, /Read file/)
  assert.match(markup, /git status --short/)
  assert.match(markup, /Get-Content C:\\Users\\demo\\\.codex\\skills\\chill-vibe-full-regression\\SKILL\.md/)
  assert.doesNotMatch(markup, /name: chill-vibe-full-regression/)
})

test('summarizes grep-style commands as text search like VS Code', () => {
  assert.equal(
    summarizeCommandDisplay(
      'grep -r "export.*memo\\|React\\.memo" /d/Git/chill-vibe/src/components --include="*.tsx" | head -10',
      'en',
    ),
    'Search text',
  )

  assert.equal(
    summarizeCommandDisplay(
      'grep -r "export.*memo\\|React\\.memo" /d/Git/chill-vibe/src/components --include="*.tsx" | head -10',
      'zh-CN',
    ),
    '搜索文本',
  )
})

test('keeps rg --files summarized as file search', () => {
  assert.equal(summarizeCommandDisplay('rg --files src/components', 'en'), 'Search files')
  assert.equal(summarizeCommandDisplay('rg --files src/components', 'zh-CN'), '搜索文件')
})

test('summarizes multi-statement PowerShell file reads by the dominant command', () => {
  const command = '$content = Get-Content -Path src/components/ChatCard.tsx; $content[1638..1698]'

  assert.equal(summarizeCommandDisplay(command, 'en'), 'Read file')
  assert.equal(summarizeCommandDisplay(command, 'zh-CN'), '读取文件')
})

test('renders structured Claude tool blocks', () => {
  const markup = renderCard(createClaudeToolCard())

  assert.match(markup, />Read</)
  assert.match(markup, /Read App\.tsx \(lines 471-520\)/)
})

test('does not render fork actions for structured tool groups', () => {
  const markup = renderCard(createClaudeToolCard(), {
    onForkConversation: () => undefined,
  })

  assert.match(markup, /structured-command-group/)
  assert.doesNotMatch(markup, /message-fork-btn/)
})

test('renders tool card with toolInput details', () => {
  const card = createClaudeToolCard()
  card.messages[0] = {
    ...card.messages[0],
    meta: {
      kind: 'tool',
      provider: 'claude',
      structuredData: JSON.stringify({
        itemId: 'toolu_glob',
        status: 'completed',
        toolName: 'Glob',
        summary: 'Search files: **/*.ts',
        toolInput: { pattern: '**/*.ts', path: 'src/' },
      }),
    },
  }

  const markup = renderCard(card)

  assert.match(markup, />Glob</)
  assert.match(markup, /Search files/)
  assert.match(markup, /structured-tool-chevron/)
})

test('renders tool card without toolInput (backward compatible)', () => {
  const card = createClaudeToolCard()
  card.messages[0] = {
    ...card.messages[0],
    meta: {
      ...card.messages[0].meta,
      structuredData: JSON.stringify({
        itemId: 'toolu_read',
        status: 'completed',
        toolName: 'Read',
        summary: 'Read App.tsx',
      }),
    },
  }
  const markup = renderCard(card)

  assert.match(markup, />Read</)
  assert.match(markup, /Read App\.tsx/)
  assert.doesNotMatch(markup, /structured-tool-chevron/)
  assert.doesNotMatch(markup, /structured-tool-details/)
})

test('renders structured edited-file diff blocks', () => {
  const markup = renderCard(createEditedFilesCard())

  assert.match(markup, /Edited files/)
  assert.match(markup, /shared\/schema\.ts/)
  assert.match(markup, /\+11/)
  assert.match(markup, /-1/)
  assert.match(markup, /structured-inline-diff-row is-removed/)
  assert.match(markup, /structured-inline-diff-row is-added/)
  assert.match(markup, /export const newLine = true/)
})

test('renders open-file buttons for structured edited files when file opening is available', () => {
  const markup = renderCard(createEditedFilesCard(), {
    onOpenFile: () => undefined,
  })

  assert.match(markup, /structured-edits-summary-button/)
  assert.match(markup, /data-open-file-path="shared\/schema\.ts"/)
  assert.match(markup, /aria-label="Open shared\/schema\.ts"/)
})

test('renders open-file buttons for absolute changes-summary paths inside the workspace', () => {
  const markup = renderCard(createChangesSummaryCard(), {
    onOpenFile: () => undefined,
  })

  assert.match(markup, /changes-summary-file-button/)
  assert.match(markup, /data-open-file-path="docs\/release-notes\.md"/)
  assert.match(markup, /aria-label="Open D:\/Git\/chill-vibe\/docs\/release-notes\.md"/)
})

test('renders a VS Code-like structured todo card', () => {
  const markup = renderCard(createTodoCard())

  assert.match(markup, /structured-todo-card/)
  assert.match(markup, /Tasks/)
  assert.match(markup, /1 of 3 completed/)
  assert.match(markup, /Inspect the activity pipeline/)
  assert.match(markup, /Render the VS Code-like task list/)
  assert.match(markup, /Rendering the VS Code-like task list/)
  assert.match(markup, /Verify both themes/)
  assert.match(markup, /structured-todo-item is-in_progress/)
  assert.match(markup, /structured-todo-item is-pending/)
  assert.match(markup, /structured-todo-item is-completed/)
  assert.match(markup, /High priority/)
})

test('detects todo items that just transitioned into completed', () => {
  assert.deepEqual(
    getNewlyCompletedStructuredTodoItemIds(
      [
        {
          id: 'task-1',
          content: 'Inspect the activity pipeline',
          status: 'completed',
        },
        {
          id: 'task-2',
          content: 'Render the VS Code-like task list',
          status: 'in_progress',
        },
        {
          id: 'task-3',
          content: 'Verify both themes',
          status: 'pending',
        },
      ],
      [
        {
          id: 'task-1',
          content: 'Inspect the activity pipeline',
          status: 'completed',
        },
        {
          id: 'task-2',
          content: 'Render the VS Code-like task list',
          status: 'completed',
        },
        {
          id: 'task-3',
          content: 'Verify both themes',
          status: 'completed',
        },
        {
          id: 'task-4',
          content: 'Ship the visual polish',
          status: 'completed',
        },
      ],
    ),
    ['task-2', 'task-3'],
  )
})
