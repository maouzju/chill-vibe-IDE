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

  // 症状：把看板项「拖出为独立 tab」之后再想拖回看板，全程 no-drop —— 拖出那一刻
  //   弹出的卡就成了 pane 的活动 tab，看板面板 hidden 且组件不挂载，泳道落点
  //   压根不在 DOM 里。上面那条"拖的就是原本活动的 tab 就什么都不做"正好覆盖
  //   了这个场景，于是补偿逻辑一次也没起作用。
  it('reveals the board in this pane when the user drags the tab the pane is showing', () => {
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'chat-1',
        gesture: { tabId: 'chat-1', activeTabIdAtPointerDown: 'chat-1' },
        currentActiveTabId: 'chat-1',
        paneTabIds: ['board-1', 'chat-1'],
        boardTabIds: ['board-1'],
      }),
      'board-1',
    )
  })

  it('reveals the board even when no pointerdown gesture was recorded', () => {
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'chat-1',
        gesture: null,
        currentActiveTabId: 'chat-1',
        paneTabIds: ['board-1', 'chat-1'],
        boardTabIds: ['board-1'],
      }),
      'board-1',
    )
  })

  it('prefers undoing this gesture own switch over revealing the board', () => {
    // 手势自己把视图从 chat-2 切到了被拖的 chat-1：先还原用户原本在看的东西，
    // 而不是越过它去露看板 —— 那会夺走一个用户没要求的视图变化。
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'chat-1',
        gesture: { tabId: 'chat-1', activeTabIdAtPointerDown: 'chat-2' },
        currentActiveTabId: 'chat-1',
        paneTabIds: ['board-1', 'chat-1', 'chat-2'],
        boardTabIds: ['board-1'],
      }),
      'chat-2',
    )
  })

  it('never reveals the board when the dragged tab is the board itself', () => {
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'board-1',
        gesture: { tabId: 'board-1', activeTabIdAtPointerDown: 'board-1' },
        currentActiveTabId: 'board-1',
        paneTabIds: ['board-1', 'chat-1'],
        boardTabIds: ['board-1'],
      }),
      null,
    )
  })

  it('never reveals the board when the pane is not showing the dragged tab', () => {
    // 用户在看看板、去拖另一条 tab：视图本来就已经是落点，不必也不该再动。
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'chat-1',
        gesture: { tabId: 'chat-1', activeTabIdAtPointerDown: 'board-1' },
        currentActiveTabId: 'board-1',
        paneTabIds: ['board-1', 'chat-1'],
        boardTabIds: ['board-1'],
      }),
      null,
    )
  })

  it('has nothing to reveal when this pane holds no board', () => {
    assert.equal(
      decideDragStartActiveTabRestore({
        draggedTabId: 'chat-1',
        gesture: { tabId: 'chat-1', activeTabIdAtPointerDown: 'chat-1' },
        currentActiveTabId: 'chat-1',
        paneTabIds: ['chat-1', 'chat-2'],
        boardTabIds: [],
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
    assert.match(
      dragStartBlock,
      /boardTabIds/,
      'dragstart must tell the decision which tabs in this pane are boards, or a popped-out item can never be dragged back',
    )
  })

  it('puts the pane back on the dragged tab when the drag ends without the board absorbing it', async () => {
    const source = await readFile(paneViewSourcePath, 'utf8')
    const dragEndBlock =
      source.match(/onDragEnd=\{\(\) => \{[\s\S]*?\n {16}\}\}/)?.[0] ?? ''

    assert.match(
      dragEndBlock,
      /restoreViewAfterBoardReveal|boardRevealRestoreRef/,
      'revealing the board for a drop target must be undone when the gesture ends, otherwise every aborted drag silently swaps the view',
    )
  })
})
