import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createDefaultBrainstormState } from '../shared/brainstorm.ts'
import { createPane } from '../shared/default-state.ts'
import type { BoardColumn, ExternalSessionSummary, ProviderStatus, SessionHistoryEntry } from '../shared/schema.ts'
import { WorkspaceColumn } from '../src/components/WorkspaceColumn.tsx'
import {
  filterExternalSessionHistory,
  filterSessionHistoryEntries,
  getSessionHistoryDisplayMessageCount,
  getSessionHistoryLifecycle,
  getSessionHistoryLifecycleLabel,
  mergeSessionHistorySearchResults,
} from '../src/components/workspace-column-history.ts'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

type TestWindow = {
  electronAPI?: {
    openFolderDialog?: () => Promise<string | null>
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

const restoreWindow = () => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow)
    return
  }

  Reflect.deleteProperty(globalThis, 'window')
}

const setWindow = (value: TestWindow | undefined) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: value as unknown,
  })
}

const createColumn = (overrides: Partial<BoardColumn> = {}): BoardColumn => ({
  id: overrides.id ?? 'column-1',
  title: overrides.title ?? 'Workspace 1',
  provider: overrides.provider ?? 'codex',
  workspacePath: overrides.workspacePath ?? '',
  model: overrides.model ?? 'gpt-5.5',
  width: overrides.width,
  cards: overrides.cards ?? {},
  layout: overrides.layout ?? createPane(Object.keys(overrides.cards ?? {}), Object.keys(overrides.cards ?? {})[0] ?? '', 'pane-1'),
})

const createMarkup = (column: BoardColumn) =>
  renderToStaticMarkup(
    React.createElement(WorkspaceColumn, {
      column,
      providers: {} as Record<string, ProviderStatus>,
      language: 'en',
      musicAlbumCoverEnabled: false,
      weatherCity: '',
      gitAgentModel: 'gpt-5.5 low',
      brainstormRequestModel: 'gpt-5.5',
      availableQuickToolModels: [],
      autoUrgeEnabled: false,
      autoUrgeMessage: '',
      autoUrgeSuccessKeyword: '',
      workspaceCards: Object.values(column.cards),
      onAddTab: () => {},
      onChangeColumn: () => {},
      onChangeCardModel: () => {},
      onChangeCardReasoningEffort: () => {},
      onToggleCardPlanMode: () => {},
      onToggleCardThinking: () => {},
      onToggleCardCollapsed: () => {},
      onMarkCardRead: () => {},
      onChangeCardDraft: () => {},
      onChangeCardStickyNote: () => {},
      onPatchCard: () => {},
      onChangeCardTitle: () => {},
      onReorderColumn: () => {},
      onRemoveColumn: () => {},
      onResizeColumn: () => {},
      onSplitPane: () => {},
      onSplitMoveTab: () => {},
      onCloseTab: () => {},
      onMoveTab: () => {},
      onReorderTab: () => {},
      onSetActiveTab: () => {},
      onResizePane: () => {},
      onActivatePane: () => {},
      onSendMessage: async () => {},
      onStopMessage: async () => {},
      sessionHistory: [],
      onRestoreSession: () => {},
      onImportExternalSession: () => {},
      recentWorkspaces: [],
      onRecordRecentWorkspace: () => {},
      onRemoveRecentWorkspaces: () => {},
    } as unknown as React.ComponentProps<typeof WorkspaceColumn>),
  )

afterEach(() => {
  restoreWindow()
})

describe('WorkspaceColumn streaming column actions', () => {
  it('keeps column-header actions available while a card is streaming', () => {
    setWindow(undefined)

    const column = createColumn({
      workspacePath: '/some/project',
      cards: {
        'card-1': {
          id: 'card-1',
          title: 'Chat 1',
          status: 'streaming',
          provider: 'codex',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          thinkingEnabled: true,
          planMode: false,
          autoUrgeActive: false,
          autoUrgeProfileId: 'auto-urge-default',
          collapsed: false,
          unread: false,
          draft: '',
          draftAttachments: [],
          queuedSends: [],
          stickyNote: '',
          brainstorm: createDefaultBrainstormState(),
          providerSessions: {},
          messages: [],
        },
      },
    })

    const markup = createMarkup(column)
    const columnHeaderMarkup = markup.match(/<header class="column-header">[\s\S]*?<\/header>/)?.[0] ?? ''

    assert.doesNotMatch(
      markup,
      /aria-label="Session history"[^>]*disabled/,
      'Session history button should stay enabled while streaming',
    )
    assert.match(columnHeaderMarkup, /aria-label="Session history"/, 'Session history button should render in the column header')
    assert.doesNotMatch(columnHeaderMarkup, /aria-label="Add chat"/, 'Add chat button should stay removed from the column header')
    assert.doesNotMatch(columnHeaderMarkup, /aria-label="Copy column"/, 'Copy column button should stay removed from the column header')

    // Close-workspace button should not be disabled
    assert.doesNotMatch(
      markup,
      /aria-label="Close workspace"[^>]*disabled/,
      'Close workspace button should not be disabled while streaming',
    )
    assert.match(columnHeaderMarkup, /aria-label="Close workspace"/, 'Close workspace button should render in the column header')

    // Column headline should be draggable
    assert.match(
      markup,
      /class="column-headline"[^>]*draggable="true"/,
      'Column headline should remain draggable while streaming',
    )
  })
})

describe('WorkspaceColumn column-title-btn drag isolation', () => {
  it('marks the column-title-btn as non-draggable so clicks are not intercepted by the parent drag handle', () => {
    setWindow(undefined)

    const column = createColumn({ workspacePath: '/some/project' })
    const markup = createMarkup(column)

    // The column-title-btn must carry draggable="false" to prevent the
    // browser from initiating a drag on the parent column-headline div
    // when the user clicks the button to edit the workspace path.
    assert.match(
      markup,
      /class="column-title-btn"[^>]*draggable="false"/,
      'column-title-btn should have draggable="false" to prevent drag interference',
    )
  })
})

describe('WorkspaceColumn path picker chrome', () => {
  it('keeps the folder-picker control visible even before the Electron bridge hydrates', () => {
    setWindow(undefined)

    const markup = createMarkup(createColumn())

    assert.match(markup, /workspace-path-input/)
    assert.match(markup, /aria-label="Select folder"/)
    assert.doesNotMatch(markup, /This window cannot open the system folder picker/)
  })

  it('keeps the native folder button when the desktop picker is available', () => {
    setWindow({
      electronAPI: {
        openFolderDialog: async () => null,
      },
    })

    const markup = createMarkup(createColumn())

    assert.match(markup, /workspace-path-input/)
    assert.match(markup, /aria-label="Select folder"/)
    assert.doesNotMatch(markup, /This window cannot open the system folder picker/)
  })
})

describe('WorkspaceColumn session history access', () => {
  it('keeps a session history entry point inside the workspace title menu after the header icon is removed', () => {
    setWindow(undefined)

    const markup = createMarkup(createColumn())

    assert.match(markup, /workspace-path-input/)
    assert.match(markup, />Session history</)
  })

  it('marks the session history button as a non-drag target so clicks are not eaten by the draggable header', () => {
    setWindow(undefined)

    const markup = createMarkup(createColumn())
    const columnHeaderMarkup = markup.match(/<div class="column-actions"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? ''

    assert.match(columnHeaderMarkup, /aria-label="Session history"/)
    assert.match(columnHeaderMarkup, /draggable="false"/)
  })
})

describe('WorkspaceColumn session history search', () => {
  it('merges local and deep results in newest-first order without duplicate entries or provider sessions', () => {
    const createEntry = (
      id: string,
      archivedAt: string,
      sessionId: string,
      provider: SessionHistoryEntry['provider'] = 'codex',
    ): SessionHistoryEntry => ({
      id,
      title: id,
      sessionId,
      provider,
      model: provider === 'claude' ? 'claude-sonnet-4-5' : 'gpt-5.5',
      workspacePath: 'D:\\Git\\chill-vibe',
      archivedAt,
      messages: [],
      messageCount: 12,
    })

    const localResults = [
      createEntry('shared-session-older', '2026-04-10T10:00:00.000Z', 'shared-session'),
      createEntry('local-result', '2026-04-10T11:00:00.000Z', 'local-session'),
    ]
    const deepResults = [
      createEntry('shared-session-newer', '2026-04-10T12:00:00.000Z', 'shared-session'),
      createEntry('claude-same-id', '2026-04-10T11:30:00.000Z', 'shared-session', 'claude'),
      createEntry('local-result', '2026-04-10T11:00:00.000Z', 'local-session'),
      createEntry('deep-old-result', '2026-04-10T09:00:00.000Z', 'deep-old-session'),
    ]

    assert.deepEqual(
      mergeSessionHistorySearchResults(localResults, deepResults).map((entry) => entry.id),
      ['shared-session-newer', 'claude-same-id', 'local-result', 'deep-old-result'],
    )
  })

  it('uses the archived transcript count instead of the number of preview messages', () => {
    const previewEntry: SessionHistoryEntry = {
      id: 'preview-entry',
      title: 'Preview-only history',
      sessionId: 'preview-session',
      provider: 'codex',
      model: 'gpt-5.5',
      workspacePath: 'D:\\Git\\chill-vibe',
      archivedAt: '2026-04-10T12:00:00.000Z',
      messages: [
        {
          id: 'preview-message-1',
          role: 'user',
          content: 'First preview message',
          createdAt: '2026-04-10T11:58:00.000Z',
        },
        {
          id: 'preview-message-2',
          role: 'assistant',
          content: 'Last preview message',
          createdAt: '2026-04-10T11:59:00.000Z',
        },
      ],
      messageCount: 47,
      messagesPreview: true,
    }
    const legacyFullEntry: SessionHistoryEntry = {
      ...previewEntry,
      id: 'legacy-full-entry',
      messages: previewEntry.messages.slice(0, 1),
      messageCount: undefined,
      messagesPreview: undefined,
    }

    assert.equal(getSessionHistoryDisplayMessageCount(previewEntry), 47)
    assert.equal(getSessionHistoryDisplayMessageCount(legacyFullEntry), 1)
  })

  it('derives ended or interrupted labels for internal session history entries', () => {
    const interruptedEntry: SessionHistoryEntry = {
      id: 'history-interrupted',
      title: 'Interrupted run',
      sessionId: 'session-interrupted',
      provider: 'codex',
      model: 'gpt-5.5',
      workspacePath: 'D:\\Git\\chill-vibe',
      archivedAt: '2026-04-10T03:00:00.000Z',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Partial answer',
          createdAt: '2026-04-10T02:55:00.000Z',
        },
        {
          id: 'message-2',
          role: 'system',
          content: 'User interrupted',
          createdAt: '2026-04-10T02:56:00.000Z',
          meta: {
            kind: 'run-stopped',
            stopReason: 'user-interrupt',
          },
        },
      ],
    }
    const resumedEntry: SessionHistoryEntry = {
      ...interruptedEntry,
      id: 'history-ended-after-resume',
      title: 'Ended after resume',
      messages: [
        ...interruptedEntry.messages,
        {
          id: 'message-3',
          role: 'assistant',
          content: 'Finished after the interruption.',
          createdAt: '2026-04-10T02:57:00.000Z',
        },
      ],
    }

    assert.equal(getSessionHistoryLifecycle(interruptedEntry), 'interrupted')
    assert.equal(getSessionHistoryLifecycle(resumedEntry), 'ended')
    assert.equal(getSessionHistoryLifecycleLabel(interruptedEntry, 'zh-CN'), '中断')
    assert.equal(getSessionHistoryLifecycleLabel(resumedEntry, 'en'), 'Ended')
  })

  it('filters internal session history by title, workspace details, provider, model, and message content', () => {
    const entries: SessionHistoryEntry[] = [
      {
        id: 'history-1',
        title: 'Release checklist',
        sessionId: 'session-1',
        provider: 'codex',
        model: 'gpt-5.5',
        workspacePath: 'D:\\Git\\chill-vibe',
        archivedAt: '2026-04-10T03:00:00.000Z',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            content: 'Need a safer packaging flow before release.',
            createdAt: '2026-04-10T02:55:00.000Z',
          },
        ],
      },
      {
        id: 'history-2',
        title: 'Bug bash notes',
        sessionId: 'session-2',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        workspacePath: 'D:\\Git\\other-repo',
        archivedAt: '2026-04-09T03:00:00.000Z',
        messages: [
          {
            id: 'message-2',
            role: 'assistant',
            content: 'Search the session history menu for the regression details.',
            createdAt: '2026-04-09T02:55:00.000Z',
          },
          {
            id: 'message-3',
            role: 'system',
            content: 'User interrupted',
            createdAt: '2026-04-09T02:56:00.000Z',
            meta: {
              kind: 'run-stopped',
              stopReason: 'manual',
            },
          },
        ],
      },
    ]

    assert.deepEqual(
      filterSessionHistoryEntries(entries, 'release').map((entry) => entry.id),
      ['history-1'],
      'title matches should stay visible',
    )
    assert.deepEqual(
      filterSessionHistoryEntries(entries, 'other-repo').map((entry) => entry.id),
      ['history-2'],
      'workspace path matches should stay visible',
    )
    assert.deepEqual(
      filterSessionHistoryEntries(entries, 'claude').map((entry) => entry.id),
      ['history-2'],
      'provider matches should stay visible',
    )
    assert.deepEqual(
      filterSessionHistoryEntries(entries, 'gpt-5.5').map((entry) => entry.id),
      ['history-1'],
      'model matches should stay visible',
    )
    assert.deepEqual(
      filterSessionHistoryEntries(entries, 'regression details').map((entry) => entry.id),
      ['history-2'],
      'message content matches should stay visible',
    )
    assert.deepEqual(
      filterSessionHistoryEntries(entries, 'interrupted').map((entry) => entry.id),
      ['history-2'],
      'interrupted status matches should stay searchable',
    )
  })

  it('filters external session history by title, workspace details, provider, and model metadata', () => {
    const sessions: ExternalSessionSummary[] = [
      {
        id: 'external-1',
        title: 'Imported release prep',
        provider: 'codex',
        model: 'gpt-5.5',
        workspacePath: 'D:\\Git\\chill-vibe',
        messageCount: 12,
        startedAt: '2026-04-08T03:00:00.000Z',
        updatedAt: '2026-04-08T05:00:00.000Z',
      },
      {
        id: 'external-2',
        title: 'Claude research thread',
        provider: 'claude',
        model: 'claude-opus-4-1',
        workspacePath: 'D:\\Git\\docs-site',
        messageCount: 8,
        startedAt: '2026-04-07T03:00:00.000Z',
        updatedAt: '2026-04-07T05:00:00.000Z',
      },
    ]

    assert.deepEqual(
      filterExternalSessionHistory(sessions, 'research').map((entry) => entry.id),
      ['external-2'],
      'title matches should stay visible',
    )
    assert.deepEqual(
      filterExternalSessionHistory(sessions, 'docs-site').map((entry) => entry.id),
      ['external-2'],
      'workspace path matches should stay visible',
    )
    assert.deepEqual(
      filterExternalSessionHistory(sessions, 'codex').map((entry) => entry.id),
      ['external-1'],
      'provider matches should stay visible',
    )
    assert.deepEqual(
      filterExternalSessionHistory(sessions, 'claude-opus').map((entry) => entry.id),
      ['external-2'],
      'model matches should stay visible',
    )
  })
})
