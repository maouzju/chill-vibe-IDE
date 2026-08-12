import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { decideDragStartActiveTabRestore } from '../src/components/pane-tab-drag-view.ts'

const paneViewSourcePath = path.join(process.cwd(), 'src', 'components', 'PaneView.tsx')

describe('dragging a pane tab keeps the pane showing what it showed before the gesture', () => {
  it('restores the pre-gesture tab when the 80ms pointerdown fallback already switched to the dragged tab', () => {
    // 用户场景：pane 正显示自动化看板，用户去拖同一 tab 栏里的另一个 chat tab。
    // pointerdown 的 80ms 兜底先把看板切走，落点（看板泳道）就没了。
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'chat-1',
        gesture: { tabId: 'chat-1', activeTabIdAtPointerDown: 'board-1' },
        currentActiveTabId: 'chat-1',
        paneTabIds: ['board-1', 'chat-1'],
      }),
      'board-1',
    )
  })

  it('does nothing when the gesture never switched the active tab', () => {
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'chat-1',
        gesture: { tabId: 'chat-1', activeTabIdAtPointerDown: 'board-1' },
        currentActiveTabId: 'board-1',
        paneTabIds: ['board-1', 'chat-1'],
      }),
      null,
    )
  })

  it('does nothing when the user drags the tab that was already active', () => {
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'board-1',
        gesture: { tabId: 'board-1', activeTabIdAtPointerDown: 'board-1' },
        currentActiveTabId: 'board-1',
        paneTabIds: ['board-1', 'chat-1'],
      }),
      null,
    )
  })

  it('never fights a switch this gesture did not cause', () => {
    // 当前活动 tab 不是被拖的那个：切换来自别处（快捷键、rescue、别的 pane 的动作），
    // 强行改回去只会把用户刚选中的东西抢走。
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'chat-1',
        gesture: { tabId: 'chat-1', activeTabIdAtPointerDown: 'board-1' },
        currentActiveTabId: 'chat-2',
        paneTabIds: ['board-1', 'chat-1', 'chat-2'],
      }),
      null,
    )
  })

  it('ignores a gesture recorded for a different tab', () => {
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'chat-1',
        gesture: { tabId: 'chat-2', activeTabIdAtPointerDown: 'board-1' },
        currentActiveTabId: 'chat-1',
        paneTabIds: ['board-1', 'chat-1', 'chat-2'],
      }),
      null,
    )
  })

  it('ignores a missing gesture and a pre-gesture tab that has since left the pane', () => {
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'chat-1',
        gesture: null,
        currentActiveTabId: 'chat-1',
        paneTabIds: ['board-1', 'chat-1'],
      }),
      null,
    )
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'chat-1',
        gesture: { tabId: 'chat-1', activeTabIdAtPointerDown: 'gone-1' },
        currentActiveTabId: 'chat-1',
        paneTabIds: ['board-1', 'chat-1'],
      }),
      null,
    )
  })
})

describe('PaneView wires the drag-start restore', () => {
  it('records the pre-gesture active tab on pointerdown and restores it on dragstart', async () => {
    const source = await readFile(paneViewSourcePath, 'utf8')
    const pointerDownBlock =
      source.match(
        /const handleTabPointerDown = \(tabId: string\) => \(event: PointerEvent<HTMLButtonElement>\) => \{[\s\S]*?\n {2}\}/,
      )?.[0] ?? ''
    const dragStartBlock =
      source.match(
        /const handleTabDragStart = \(tabId: string\) => \(event: DragEvent<HTMLButtonElement>\) => \{[\s\S]*?\n {2}\}/,
      )?.[0] ?? ''

    assert.match(
      pointerDownBlock,
      /activeTabIdAtPointerDown: pane\.activeTabId/,
      'the pointerdown gesture must remember what the pane was showing before it may switch tabs',
    )
    assert.match(
      dragStartBlock,
      /decideDragStartActiveTabRestore/,
      'dragstart must undo a switch this gesture caused, or a board tab disappears before it can be a drop target',
    )
    assert.match(
      dragStartBlock,
      /onSetActiveTab\(pane\.id, /,
      'the restore has to go through onSetActiveTab so the pane really flips back',
    )
  })
})
