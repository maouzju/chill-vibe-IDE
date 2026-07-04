import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyGitSelectionClick,
  pruneGitSelection,
  resolveGitContextTarget,
  type GitChangeSelection,
} from '../src/components/git-selection'

const order = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']

const selection = (paths: string[], anchorPath: string | null): GitChangeSelection => ({
  paths,
  anchorPath,
})

describe('applyGitSelectionClick', () => {
  it('plain click resets selection to the target and moves the anchor', () => {
    const next = applyGitSelectionClick(selection(['a.ts', 'b.ts'], 'a.ts'), order, 'c.ts', {
      ctrlKey: false,
      shiftKey: false,
    })
    assert.deepEqual(next, selection(['c.ts'], 'c.ts'))
  })

  it('ctrl click adds an unselected row and moves the anchor', () => {
    const next = applyGitSelectionClick(selection(['a.ts'], 'a.ts'), order, 'c.ts', {
      ctrlKey: true,
      shiftKey: false,
    })
    assert.deepEqual(next, selection(['a.ts', 'c.ts'], 'c.ts'))
  })

  it('ctrl click removes an already selected row but still moves the anchor', () => {
    const next = applyGitSelectionClick(selection(['a.ts', 'c.ts'], 'a.ts'), order, 'c.ts', {
      ctrlKey: true,
      shiftKey: false,
    })
    assert.deepEqual(next, selection(['a.ts'], 'c.ts'))
  })

  it('ctrl click keeps selection ordered by the visible list order', () => {
    const next = applyGitSelectionClick(selection(['d.ts'], 'd.ts'), order, 'b.ts', {
      ctrlKey: true,
      shiftKey: false,
    })
    assert.deepEqual(next, selection(['b.ts', 'd.ts'], 'b.ts'))
  })

  it('ctrl click can empty the selection while remembering the anchor', () => {
    const next = applyGitSelectionClick(selection(['c.ts'], 'c.ts'), order, 'c.ts', {
      ctrlKey: true,
      shiftKey: false,
    })
    assert.deepEqual(next, selection([], 'c.ts'))
  })

  it('shift click selects the forward range from the anchor without moving it', () => {
    const next = applyGitSelectionClick(selection(['b.ts'], 'b.ts'), order, 'd.ts', {
      ctrlKey: false,
      shiftKey: true,
    })
    assert.deepEqual(next, selection(['b.ts', 'c.ts', 'd.ts'], 'b.ts'))
  })

  it('shift click selects the backward range from the anchor', () => {
    const next = applyGitSelectionClick(selection(['d.ts'], 'd.ts'), order, 'a.ts', {
      ctrlKey: false,
      shiftKey: true,
    })
    assert.deepEqual(next, selection(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 'd.ts'))
  })

  it('shift click with a missing anchor degrades to a plain click', () => {
    const next = applyGitSelectionClick(selection([], null), order, 'c.ts', {
      ctrlKey: false,
      shiftKey: true,
    })
    assert.deepEqual(next, selection(['c.ts'], 'c.ts'))
  })

  it('shift click with an anchor no longer in the list degrades to a plain click', () => {
    const next = applyGitSelectionClick(selection(['gone.ts'], 'gone.ts'), order, 'b.ts', {
      ctrlKey: false,
      shiftKey: true,
    })
    assert.deepEqual(next, selection(['b.ts'], 'b.ts'))
  })

  it('ctrl+shift click behaves like shift click', () => {
    const next = applyGitSelectionClick(selection(['a.ts'], 'a.ts'), order, 'c.ts', {
      ctrlKey: true,
      shiftKey: true,
    })
    assert.deepEqual(next, selection(['a.ts', 'b.ts', 'c.ts'], 'a.ts'))
  })
})

describe('pruneGitSelection', () => {
  it('drops paths that disappeared from the visible list', () => {
    const next = pruneGitSelection(selection(['a.ts', 'gone.ts', 'c.ts'], 'a.ts'), order)
    assert.deepEqual(next, selection(['a.ts', 'c.ts'], 'a.ts'))
  })

  it('clears a vanished anchor', () => {
    const next = pruneGitSelection(selection(['a.ts', 'gone.ts'], 'gone.ts'), order)
    assert.deepEqual(next, selection(['a.ts'], null))
  })

  it('returns the same reference when nothing changed', () => {
    const current = selection(['a.ts', 'b.ts'], 'b.ts')
    assert.equal(pruneGitSelection(current, order), current)
  })
})

describe('resolveGitContextTarget', () => {
  it('keeps the multi-selection when right-clicking a selected row', () => {
    const current = selection(['a.ts', 'c.ts'], 'a.ts')
    assert.equal(resolveGitContextTarget(current, 'c.ts'), current)
  })

  it('resets to a single selection when right-clicking an unselected row', () => {
    const next = resolveGitContextTarget(selection(['a.ts', 'c.ts'], 'a.ts'), 'd.ts')
    assert.deepEqual(next, selection(['d.ts'], 'd.ts'))
  })
})
